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
const emailQueries = require('../db/emailQueries');
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
            // MAIL-AGENT-002: pin the settings row on first activity so
            // activated_at marks the moment the agent went live — the runtime
            // gate below only reviews mail that ARRIVES after this point.
            settings = await mailAgentQueries.ensureSettingsRow(companyId);
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

        // MAIL-AGENT-002 belt-and-braces: the link pipeline already drops
        // outbound mail and DRAFT/SENT pushes before calling us, but the agent
        // must never depend on the caller for that — Gmail pushes fire for
        // every mailbox event including draft saves.
        if (msg.is_outbound === true) return { skipped: 'outbound' };
        if (Array.isArray(msg.labelIds) && msg.labelIds.some(l => l === 'DRAFT' || l === 'SENT')) {
            return { skipped: 'draft_or_sent' };
        }

        // The email row must exist locally (upserted before linking) — it anchors
        // dedup and the decisions feed.
        const emailRow = await mailAgentQueries.getEmailMessage(companyId, msg.provider_message_id);
        if (!emailRow) return { skipped: 'no_email_row' };
        if (emailRow.direction && emailRow.direction !== 'inbound') {
            return { skipped: 'not_inbound' };
        }

        // MAIL-AGENT-002: only mail that ARRIVED after the agent went live.
        // History re-walks and full resyncs funnel months-old letters through
        // this hook — gate on the email's OWN Gmail timestamp, silently (no
        // review row: historical mail is re-touched by every sync pass and
        // would flood the decisions feed).
        const emailDate = msg.internal_at ? new Date(msg.internal_at)
            : (emailRow.gmail_internal_at ? new Date(emailRow.gmail_internal_at) : null);
        const activatedAt = settings.activated_at ? new Date(settings.activated_at) : null;
        if (!activatedAt || !emailDate || Number.isNaN(emailDate.getTime()) || emailDate < activatedAt) {
            return { skipped: 'historical' };
        }

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
            // MAIL-AGENT-003: find-or-create, never blind-create. ctx.noContact can
            // be stale (backfills/sweeps computed it from stored rows), and two
            // first-time emails from one new sender can race — a repeated create
            // forks the person across contacts/timelines (95 dup contacts on prod,
            // 2026-07-04). findEmailContact is the same resolver the link path uses.
            const existing = await emailQueries.findEmailContact(msg.from_email, companyId);
            if (!existing) {
                await mailAgentQueries.createEmailContact(companyId, {
                    fromName: msg.from_name, fromEmail: msg.from_email,
                });
            }
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

/**
 * MAIL-MUTE-001 — from-only rule subset (DECISION-B).
 * Keep only rules whose EVERY token targets `field === 'from'`. A line that
 * mixes `from:` with subject/body/any (or a bare `any` token) is NOT a mute
 * rule and is dropped whole. Same-line negation tokens (`-from:`) are kept
 * verbatim — matchEmail honors them when the subset is matched.
 * @param {{rules:Array}} parsed — output of parseRules / safeParseRules
 * @returns {Array} the from-only rule lines
 */
function fromOnlyRules(parsed) {
    const rules = (parsed && parsed.rules) || [];
    return rules.filter(r => r.tokens.length > 0 && r.tokens.every(t => t.field === 'from'));
}

/**
 * MAIL-MUTE-001 Contract 1 — is this inbound sender `from:`-muted for the company?
 * Reuses the ~60s getActiveState cache (no extra mail_agent_settings read, NFR-2),
 * filters to from-only rules, and delegates to the EXISTING matchEmail (no fork, C-2)
 * so regex / quoted / same-line negation behave byte-identically to the task path.
 * Fail-open: any error → false (FR-10). Inactive → false immediately (C-4).
 * @param {string} companyId
 * @param {object} msg — normalized inbound (from_name/from_email/subject/body_text)
 * @returns {Promise<boolean>} true iff a from-only rule matches
 */
async function isSenderMuted(companyId, msg) {
    try {
        const { active, settings } = await getActiveState(companyId);
        if (!active || !settings) return false;
        const parsed = safeParseRules(settings.exclusion_rules);
        const fromOnly = fromOnlyRules(parsed);
        if (fromOnly.length === 0) return false;
        return matchEmail({ rules: fromOnly }, buildRuleInput(msg)).excluded;
    } catch (e) {
        console.error('[MailAgent] isSenderMuted failed:', e.message);
        return false;
    }
}

/**
 * MAIL-MUTE-001 Contract 2 — literal from-only sender set for the Pulse-list SQL.
 * Projects ONLY literal, non-negated `from:` `contains` tokens (kind==='contains'
 * && !negate) into { emails, domains }; regex and negated tokens are deliberately
 * NOT projected (OQ-MM-4 — they mute new inbound via isSenderMuted, but do not
 * retro-hide an existing thread from the list). Token value is already lower-cased
 * at parse time. Fail-open: any error / inactive → { emails:[], domains:[] } (FR-10, C-4).
 * @param {string} companyId
 * @returns {Promise<{emails:string[], domains:string[]}>}
 */
async function getMutedSenderSet(companyId) {
    try {
        const { active, settings } = await getActiveState(companyId);
        if (!active || !settings) return { emails: [], domains: [] };
        const parsed = safeParseRules(settings.exclusion_rules);
        const fromOnly = fromOnlyRules(parsed);
        const emails = new Set();
        const domains = new Set();
        for (const rule of fromOnly) {
            for (const t of rule.tokens) {
                // Only literal, positive from: tokens can be expressed as SQL membership.
                if (t.kind !== 'contains' || t.negate) continue;
                const value = String(t.value || '');
                if (!value) continue;
                if (value.startsWith('@')) {
                    // @host.tld → bare domain.
                    const domain = value.slice(1);
                    if (domain) domains.add(domain);
                } else if (value.includes('@')) {
                    // local@host.tld → full address.
                    emails.add(value);
                } else if (value.includes('.')) {
                    // bare host.tld → domain. A word with no '@' and no '.' goes nowhere.
                    domains.add(value);
                }
            }
        }
        return { emails: [...emails], domains: [...domains] };
    } catch (e) {
        console.error('[MailAgent] getMutedSenderSet failed:', e.message);
        return { emails: [], domains: [] };
    }
}

module.exports = { isActive, reviewInboundEmail, dryRun, invalidateCache, isSenderMuted, getMutedSenderSet };
