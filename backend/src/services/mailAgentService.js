/**
 * MAIL-AGENT-001 — Mail Secretary orchestrator.
 *
 * Reviews every inbound email (called from emailTimelineService.linkInboundMessage
 * for BOTH the linked and the no-contact paths), decides whether the dispatcher
 * needs a task, and records every decision in mail_agent_reviews.
 *
 * Contract with the caller: NEVER throws — the email link pipeline must not be
 * affected by agent failures. All errors end up as review rows (verdict='error')
 * or console warnings.
 */

const db = require('../db/connection');
const mailAgentQueries = require('../db/mailAgentQueries');
const timelinesQueries = require('../db/timelinesQueries');
const realtimeService = require('./realtimeService');
const { parseRules, matchEmail } = require('./mailAgentRules');
const { classifyEmail } = require('./mailAgentClassifier');

const APP_KEY = 'mail-secretary';
const ACTIVE_CACHE_MS = 60 * 1000;
const DUE_MS = { p1: 60 * 60 * 1000, p2: 4 * 60 * 60 * 1000 };

// companyId → { active, settings, ts }
const activeCache = new Map();

/** Marketplace install check + settings, cached ~60s (called on every inbound email). */
async function getActiveState(companyId) {
    const cached = activeCache.get(companyId);
    if (cached && Date.now() - cached.ts < ACTIVE_CACHE_MS) return cached;

    let active = false;
    let settings = null;
    try {
        const { rows } = await db.query(
            `SELECT 1
             FROM marketplace_installations mi
             JOIN marketplace_apps ma ON ma.id = mi.app_id
             WHERE mi.company_id = $1 AND ma.app_key = $2 AND mi.status = 'connected'
             LIMIT 1`,
            [companyId, APP_KEY]
        );
        if (rows[0]) {
            settings = await mailAgentQueries.getSettings(companyId);
            active = settings.enabled !== false;
        }
    } catch (e) {
        console.error('[MailAgent] getActiveState failed:', e.message);
    }
    const state = { active, settings, ts: Date.now() };
    activeCache.set(companyId, state);
    return state;
}

/** Cheap gate used by emailTimelineService to suppress the dumb inbound_email trigger. */
async function isActive(companyId) {
    return (await getActiveState(companyId)).active;
}

/** Settings writes must invalidate the gate cache immediately. */
function invalidateCache(companyId) {
    activeCache.delete(companyId);
}

function safeParseRules(text) {
    try {
        return parseRules(text);
    } catch (e) {
        // Saved rules are validated on write; if something slips through,
        // fail open (no exclusions) rather than skipping review entirely.
        console.error('[MailAgent] stored exclusion rules failed to parse:', e.message);
        return { rules: [] };
    }
}

function buildRuleInput(msg) {
    return {
        from: `${msg.from_name || ''} <${msg.from_email || ''}>`,
        subject: msg.subject || '',
        body: msg.body_text || '',
    };
}

function buildDescription(verdict, msg) {
    const from = `${msg.from_name ? msg.from_name + ' ' : ''}<${msg.from_email || 'unknown'}>`;
    return `${verdict.reason}\n\nFrom: ${from}\nSubject: ${msg.subject || '(no subject)'}`;
}

/**
 * Review one inbound email. Fire-and-forget safe.
 * @param {string} companyId
 * @param {object} msg — normalized inbound message (from_email/from_name/subject/body_text/provider_message_id)
 * @param {object} ctx — { contactId?, timelineId?, contactName?, noContact?: boolean }
 */
async function reviewInboundEmail(companyId, msg, ctx = {}) {
    try {
        const { active, settings } = await getActiveState(companyId);
        if (!active) return { skipped: 'inactive' };

        // The email row must exist locally (upserted before linking) — it anchors
        // dedup and the decisions feed.
        const emailRow = await mailAgentQueries.getEmailMessage(companyId, msg.provider_message_id);
        if (!emailRow) return { skipped: 'no_email_row' };
        if (await mailAgentQueries.hasReview(companyId, emailRow.id)) {
            return { skipped: 'already_reviewed' };
        }

        // 1) Exclusion rules — cheap, before any LLM spend.
        const parsed = safeParseRules(settings.exclusion_rules);
        const ruleHit = matchEmail(parsed, buildRuleInput(msg));
        if (ruleHit.excluded) {
            await mailAgentQueries.insertReview({
                companyId, emailMessageId: emailRow.id,
                verdict: 'skipped_excluded', ruleLine: ruleHit.ruleLine,
            });
            return { verdict: 'skipped_excluded' };
        }

        // 2) LLM triage.
        let classified;
        try {
            classified = await classifyEmail({
                fromName: msg.from_name,
                fromEmail: msg.from_email,
                subject: msg.subject,
                bodyText: msg.body_text || emailRow.body_text,
                knownContact: !ctx.noContact,
                contactName: ctx.contactName || null,
            });
        } catch (e) {
            console.error('[MailAgent] classification failed:', e.message);
            await mailAgentQueries.insertReview({
                companyId, emailMessageId: emailRow.id,
                verdict: 'error', reason: String(e.message).slice(0, 500),
            });
            return { verdict: 'error' };
        }
        const { verdict, model, latency_ms: latencyMs } = classified;
        const base = {
            companyId, emailMessageId: emailRow.id,
            category: verdict.category, confidence: verdict.confidence,
            reason: verdict.reason, model, latencyMs,
        };

        if (!verdict.needs_attention) {
            await mailAgentQueries.insertReview({ ...base, verdict: 'skipped_no_attention' });
            return { verdict: 'skipped_no_attention' };
        }
        if (verdict.confidence < Number(settings.confidence_threshold)) {
            await mailAgentQueries.insertReview({ ...base, verdict: 'skipped_low_confidence' });
            return { verdict: 'skipped_low_confidence' };
        }

        // 3) Resolve the timeline — creating the contact first for unknown senders.
        let { contactId, timelineId } = ctx;
        if (ctx.noContact) {
            if (!settings.create_contact_for_unknown) {
                await mailAgentQueries.insertReview({ ...base, verdict: 'skipped_unknown_sender' });
                return { verdict: 'skipped_unknown_sender' };
            }
            await mailAgentQueries.createEmailContact(companyId, {
                fromName: msg.from_name, fromEmail: msg.from_email,
            });
            // Re-run the canonical link path (lazy require — circular module edge).
            // It finds the fresh contact, links the message, fires unread + SSE;
            // skipAgent prevents recursion back into this function.
            const { linkInboundMessage } = require('./email/emailTimelineService');
            const linked = await linkInboundMessage(companyId, msg, { skipAgent: true });
            if (!linked || !linked.linked) {
                await mailAgentQueries.insertReview({
                    ...base, verdict: 'error',
                    reason: `contact created but link failed (${(linked && linked.skipped) || 'unknown'})`,
                });
                return { verdict: 'error' };
            }
            contactId = linked.contactId;
            timelineId = linked.timelineId;
        }
        if (!timelineId) {
            await mailAgentQueries.insertReview({ ...base, verdict: 'error', reason: 'no timeline id' });
            return { verdict: 'error' };
        }

        // 4) Create/upsert the dispatcher task (agent provenance = single open
        //    auto task per thread; repeat emails update it instead of stacking).
        const dueAt = new Date(Date.now() + (DUE_MS[verdict.priority] || DUE_MS.p2)).toISOString();
        const task = await timelinesQueries.createTask({
            companyId,
            threadId: timelineId,
            subjectType: 'contact',
            subjectId: contactId || null,
            title: verdict.task_title || `Email from ${msg.from_email || 'unknown sender'}`,
            description: buildDescription(verdict, msg),
            priority: verdict.priority,
            dueAt,
            ownerUserId: settings.assign_owner_user_id || null,
            createdBy: 'agent',
            agentType: 'mail_secretary',
            agentInput: {
                email_message_id: emailRow.id,
                provider_message_id: msg.provider_message_id,
                from_email: msg.from_email,
                subject: msg.subject || null,
            },
            agentOutput: {
                reason: verdict.reason,
                category: verdict.category,
                confidence: verdict.confidence,
                email_message_id: emailRow.id,
            },
            agentStatus: 'succeeded',
        });

        // Parity with the dumb trigger: AR flag + SSE so Pulse lights up now.
        try {
            await timelinesQueries.setActionRequired(timelineId, 'new_message', 'system');
            realtimeService.broadcast('thread.action_required', {
                timelineId, reason: 'new_message',
            });
        } catch (e) {
            console.error('[MailAgent] setActionRequired failed:', e.message);
        }

        await mailAgentQueries.insertReview({ ...base, verdict: 'task_created', taskId: task.id });
        return { verdict: 'task_created', taskId: task.id };
    } catch (err) {
        console.error('[MailAgent] reviewInboundEmail failed:', err.message);
        return { error: err.message };
    }
}

/**
 * Dry run: push the last N inbound emails through exclusions + LLM without
 * creating tasks, contacts, or review rows. Settings-page "what would happen".
 */
async function dryRun(companyId, limit = 10) {
    const settings = await mailAgentQueries.getSettings(companyId);
    const parsed = safeParseRules(settings.exclusion_rules);
    const emails = await mailAgentQueries.listRecentInbound(companyId, limit);

    const results = await Promise.all(emails.map(async (m) => {
        const item = {
            from_name: m.from_name, from_email: m.from_email, subject: m.subject,
        };
        const ruleHit = matchEmail(parsed, {
            from: `${m.from_name || ''} <${m.from_email || ''}>`,
            subject: m.subject || '', body: m.body_text || '',
        });
        if (ruleHit.excluded) {
            return { ...item, verdict: 'skipped_excluded', rule_line: ruleHit.ruleLine };
        }
        try {
            const { verdict } = await classifyEmail({
                fromName: m.from_name, fromEmail: m.from_email,
                subject: m.subject, bodyText: m.body_text,
                knownContact: m.contact_id != null, contactName: null,
            });
            const wouldCreate = verdict.needs_attention
                && verdict.confidence >= Number(settings.confidence_threshold);
            return {
                ...item,
                verdict: wouldCreate ? 'task_created'
                    : (verdict.needs_attention ? 'skipped_low_confidence' : 'skipped_no_attention'),
                category: verdict.category,
                confidence: verdict.confidence,
                reason: verdict.reason,
            };
        } catch (e) {
            return { ...item, verdict: 'error', reason: String(e.message).slice(0, 200) };
        }
    }));
    return results;
}

module.exports = { isActive, reviewInboundEmail, dryRun, invalidateCache };
