/**
 * emailTimelineService — inbound email → contact → timeline link pipeline
 * (EMAIL-TIMELINE-001, TASK-ET-4). The load-bearing inbound logic, shared by
 * BOTH delivery paths:
 *   • push  → `ingestPushNotification(pushPayload)` (ET-5 route)
 *   • poll  → `ingestPolledForCompany(companyId)` (5-min reconciliation sibling)
 * Both fan a `NormalizedInboundMessage`-shaped object into `linkInboundMessage`.
 *
 * THE SEAM (AC-12): this service imports ONLY the `providerRegistry`
 * (`MailProvider` interface) + the DB query modules. It MUST NOT import
 * `googleapis`, `emailService`, `emailSyncService`, or `emailMailboxService`.
 *
 * Unread + SSE are mirrored 1:1 from how inbound SMS behaves in
 * `conversationsService.handleMessageAdded` — same query functions, same
 * realtime publisher — so email-unread surfaces in the existing Pulse badge and
 * an open timeline refetches live.
 */
const providerRegistry = require('../mail/providerRegistry');
const emailQueries = require('../../db/emailQueries');
const timelinesQueries = require('../../db/timelinesQueries');
const companyQueries = require('../../db/companyQueries');
const queries = require('../../db/queries');
const db = require('../../db/connection');
const realtimeService = require('../realtimeService');
const { toTimelineBody } = require('./emailTimelineBody');

const SENT_DRAFT_LABELS = new Set(['SENT', 'DRAFT']);

/** A small coded error so the route can map an httpStatus → response envelope. */
function codedError(httpStatus, code, message) {
    const err = new Error(message || code);
    err.httpStatus = httpStatus;
    err.code = code;
    return err;
}

/**
 * Shape an email_messages row into the FLAT timeline email item — the exact shape
 * the read projection emits (`buildTimeline` in routes/pulse.js + the items from
 * `emailQueries.getTimelineEmailByContact`) and the frontend `EmailTimelineItem`
 * consumes: `{ id, type, direction, is_outbound, from_email, from_name, to_email,
 * subject, body_text, sent_at, thread_id, sent_by_user_email }`.
 *
 * Keeping this identical to the read projection means the SSE `message.added`
 * email payload is consistent with a `refetchTimeline()`, so a future
 * append-from-SSE renders the same way a refetch does.
 *
 * Accepts either a raw `email_messages` row (e.g. from `linkMessageToContact`,
 * which has `direction` but no derived `is_outbound`) or a projection row (from
 * `getTimelineEmailByContact`, which already carries `is_outbound`). `is_outbound`
 * is derived from `direction` when absent. `body_text` is quote-stripped via
 * `toTimelineBody` (the read projection does the same) — storage is untouched.
 */
function toEmailItem(row) {
    if (!row) return null;
    const isOutbound = typeof row.is_outbound === 'boolean'
        ? row.is_outbound
        : row.direction === 'outbound';
    return {
        id: row.id,
        type: 'email',
        direction: row.direction,
        is_outbound: isOutbound,
        from_email: row.from_email || null,
        from_name: row.from_name || null,
        to_email: row.to_recipients_json || [],
        subject: row.subject || null,
        // Quote-strip the STORED body for display only (storage untouched), exactly
        // as the read projection does.
        body_text: toTimelineBody(row.body_text, { snippet: row.snippet }),
        // RAW HTML body (un-sanitized) — parity with the REST projection; sanitized client-side.
        body_html: row.body_html || null,
        sent_at: row.gmail_internal_at,
        thread_id: row.thread_id,
        sent_by_user_email: row.sent_by_user_email || null,
    };
}

/**
 * Core per-message link (§3 steps a–d). Idempotent and safe-fail: never throws
 * out — logs and returns an `{error}` summary so a single bad message cannot
 * crash the push route or the poll tick.
 *
 * @param {string} companyId
 * @param {import('../mail/MailProvider').NormalizedInboundMessage} msg
 * @returns {Promise<object>} one of:
 *   {skipped:'outbound'|'draft_or_sent'|'muted_sender'|'no_contact'|'no_message'} |
 *   {linked:true, contactId, timelineId, alreadyLinked?:boolean} |
 *   {error:string}
 */
async function linkInboundMessage(companyId, msg, opts = {}) {
    try {
        if (!msg || !msg.provider_message_id) {
            return { skipped: 'no_message' };
        }

        // (a) Exclusion filter — drop non-INBOX-external (FR-IN-3, AC-2).
        //     This is the draft-noise guard: a Gmail draft save/edit carries the
        //     DRAFT label and dies here → zero timeline activity, zero unread,
        //     no matter how many times it is edited. A self-send (mailbox's own
        //     address) is dropped by is_outbound.
        if (msg.is_outbound === true) {
            return { skipped: 'outbound' };
        }
        if (Array.isArray(msg.labelIds) && msg.labelIds.some(l => SENT_DRAFT_LABELS.has(l))) {
            return { skipped: 'draft_or_sent' };
        }

        // (a.5) Mute guard (MAIL-MUTE-001, FR-2/FR-3). A `from:`-muted sender (an
        //     exclusion rule whose every token targets `from`) contributes NOTHING
        //     to Pulse: bail BEFORE the contact lookup so there is no link, no
        //     unread, no bump, no SSE — and, crucially, BEFORE the no-contact agent
        //     branch below (l.114) so a muted first-time sender never auto-creates a
        //     contact/timeline (S1/S7). Gated on !opts.skipAgent (same gate the agent
        //     review uses) so the agent's own re-entry is not double-evaluated.
        //     `isSenderMuted` is already fail-open (returns false on any error /
        //     inactive agent); the extra try/catch keeps FR-10 airtight — a mute-check
        //     problem must NOT early-return and must NOT throw out of the pipeline, so
        //     the email links normally instead.
        if (!opts.skipAgent) {
            let muted = false;
            try {
                muted = await require('../mailAgentService').isSenderMuted(companyId, msg);
            } catch (e) {
                console.error('[EmailTimeline] isSenderMuted failed (fail-open):', e.message);
            }
            if (muted) {
                return { skipped: 'muted_sender' };
            }
        }

        // (b) Contact match (company-scoped + deterministic tie-break upstream).
        //     No contact → stays inbox-only (no link, no unread, no SSE) — but
        //     MAIL-AGENT-001 still gets a look: the agent may decide this is a
        //     lead worth keeping, create the contact, and re-enter this function
        //     (skipAgent guards the recursion).
        const contact = await emailQueries.findEmailContact(msg.from_email, companyId);
        if (!contact) {
            if (!opts.skipAgent) {
                const mailAgentService = require('../mailAgentService');
                await mailAgentService.reviewInboundEmail(companyId, msg, { noContact: true });
            }
            return { skipped: 'no_contact' };
        }
        const contactId = contact.contact_id || contact.id;

        // (c) Resolve the contact's timeline (phone-less analogue; shares the
        //     same single timeline row the SMS/call path reaches).
        const timeline = await timelinesQueries.findOrCreateTimelineByContact(contactId, companyId);
        if (!timeline || !timeline.id) {
            // Contact resolved but timeline could not (e.g. cross-tenant) — bail safely.
            return { skipped: 'no_contact' };
        }
        const timelineId = timeline.id;

        // Idempotency: detect a prior link BEFORE the (no-op) re-link UPDATE, so a
        // redelivered push / poll-overlap does not re-flag unread or re-emit SSE.
        const existing = await emailQueries.getMessageLinkState(msg.provider_message_id, companyId);
        const alreadyLinked = !!(existing && existing.on_timeline && existing.contact_id != null);

        // (d) Link — keyed on unique (company_id, provider_message_id); re-link is
        //     a no-op UPDATE. Returns null if no such message row exists locally.
        const linked = await emailQueries.linkMessageToContact(
            msg.provider_message_id,
            companyId,
            { contact_id: contactId, timeline_id: timelineId, on_timeline: true }
        );
        if (!linked) {
            // The push history-walk touched a message id we have not imported into
            // email_messages yet (or it belongs to another company). Nothing to link.
            return { skipped: 'no_message' };
        }

        // Idempotent re-delivery: a row already on the timeline must not re-unread
        // or re-broadcast. The link UPDATE above is harmless; skip the side effects.
        if (alreadyLinked) {
            return { linked: true, contactId, timelineId, alreadyLinked: true };
        }

        // Unread + live — mirror conversationsService.handleMessageAdded (inbound SMS):
        //   1. contact + timeline unread (so the Pulse unread badge lights up),
        //   2. config-gated Action-Required (keyed 'inbound_email'),
        //   3. SSE message.added carrying the timeline id (open timeline refetches).
        const eventDate = msg.internal_at ? new Date(msg.internal_at) : new Date();

        try {
            await queries.markContactUnread(contactId, eventDate);
        } catch (e) {
            console.error('[EmailTimeline] markContactUnread failed:', e.message);
        }
        try {
            await timelinesQueries.markTimelineUnread(timelineId);
        } catch (e) {
            console.error('[EmailTimeline] markTimelineUnread failed:', e.message);
        }

        // MAIL-AGENT-001: the Mail Secretary agent reviews every linked inbound
        // email (exclusions → LLM triage → maybe task). While it is active it
        // REPLACES the dumb every-email trigger below. Never throws.
        let mailAgentActive = false;
        if (!opts.skipAgent) {
            const mailAgentService = require('../mailAgentService');
            mailAgentActive = await mailAgentService.isActive(companyId);
            if (mailAgentActive) {
                await mailAgentService.reviewInboundEmail(companyId, msg, {
                    contactId,
                    timelineId,
                    contactName: contact.full_name || null,
                });
            }
        }

        // Action Required auto-trigger — same per-company evaluation SMS uses,
        // keyed 'inbound_email' (opt-in via company AR config; default off).
        // Suppressed while the Mail Secretary agent decides instead.
        try {
            const { getTriggerConfig } = require('../arConfigHelper');
            const triggerCfg = await getTriggerConfig(companyId, 'inbound_email');
            // skipAgent = the agent orchestrates this link and creates its own task.
            if (triggerCfg.enabled && !mailAgentActive && !opts.skipAgent) {
                await timelinesQueries.setActionRequired(timelineId, 'new_message', 'system');
                if (triggerCfg.create_task) {
                    const slaMs = (triggerCfg.task_sla_minutes || 10) * 60 * 1000;
                    const dueAt = new Date(Date.now() + slaMs).toISOString();
                    const contactName = contact.full_name || msg.from_email || 'Unknown';
                    await timelinesQueries.createTask({
                        companyId,
                        threadId: timelineId,
                        subjectType: 'contact',
                        subjectId: contactId,
                        title: `New email from ${contactName}`,
                        priority: triggerCfg.task_priority || 'p1',
                        dueAt,
                        createdBy: 'system',
                    });
                }
                realtimeService.broadcast('thread.action_required', {
                    timelineId,
                    reason: 'new_message',
                });
            }
        } catch (e) {
            console.error('[EmailTimeline] Failed to set action_required for inbound email:', e.message);
        }

        // SSE: message.added with the timeline id (mirror the SMS publisher).
        // Email has no conversation; pass a minimal object so the publisher's
        // `conversation.id` read is null-safe.
        try {
            realtimeService.publishMessageAdded(toEmailItem(linked), { id: null }, timelineId);
        } catch (e) {
            console.error('[EmailTimeline] publishMessageAdded failed:', e.message);
        }

        return { linked: true, contactId, timelineId };
    } catch (err) {
        console.error(`[EmailTimeline] linkInboundMessage error (company ${companyId}):`, err.message);
        return { error: err.message };
    }
}

/**
 * Pull recipient email addresses out of either delivery shape (EMAIL-TIMELINE-001
 * follow-up, outbound match-by-recipient). Accepts:
 *   • the push shape — `msg.to` = `[{name,email}, …]` (NormalizedInboundMessage), or
 *   • the stored-row shape — `to_recipients_json`, which is the same array OR a
 *     JSON string of it (JSONB usually arrives parsed, but be defensive).
 * Returns a lower/trim'd, deduped, non-empty list (empty when no recipients) — the
 * same normalization `findEmailContact` applies to a single address.
 */
function extractRecipientEmails(msg) {
    if (!msg) return [];
    let list = msg.to != null ? msg.to : msg.to_recipients_json;
    if (typeof list === 'string') {
        try {
            list = JSON.parse(list);
        } catch (e) {
            return [];
        }
    }
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const r of list) {
        const addr = String((r && r.email) || '').trim().toLowerCase();
        if (addr && !seen.has(addr)) {
            seen.add(addr);
            out.push(addr);
        }
    }
    return out;
}

/**
 * Core per-message link for OUTBOUND email (EMAIL-TIMELINE-001 follow-up). Mirrors
 * `linkInboundMessage` but projects the AGENT's side of the conversation — a reply
 * (incl. one sent directly from Gmail) addressed to a known contact lands on that
 * contact's timeline, RIGHT-aligned. Idempotent and safe-fail: never throws.
 *
 * Differences from inbound, by design:
 *   • Match by RECIPIENT (`msg.to` / `to_recipients_json`), not the From.
 *   • DRAFT excluded via `labelIds` (when present); a genuinely-sent email never
 *     carries DRAFT. The customer's hard rule — draft activity must NOT create
 *     timeline entries — is honored here exactly as inbound honors it.
 *   • NO unread / NO Action-Required: the agent sent it, so it must not light the
 *     Pulse badge or raise a task. We DO publish SSE so an open timeline shows the
 *     outbound bubble live (e.g. a Gmail-sent reply appears without a refetch).
 *
 * @param {string} companyId
 * @param {import('../mail/MailProvider').NormalizedInboundMessage} msg
 * @returns {Promise<object>} one of:
 *   {skipped:'draft'|'no_recipient'|'no_contact'|'no_message'} |
 *   {linked:true, contactId, timelineId, alreadyLinked?:boolean} |
 *   {error:string}
 */
async function linkOutboundMessage(companyId, msg) {
    try {
        if (!msg || !msg.provider_message_id) {
            return { skipped: 'no_message' };
        }

        // (a) Draft guard (the customer's hard rule). Outbound = genuinely sent;
        //     a Gmail draft save/edit carries the DRAFT label and dies here → zero
        //     timeline activity, no matter how many times the draft is edited.
        //     Only enforceable when labelIds are present (push path); the stored-row
        //     poll path has no label column, so its query filters direction only.
        if (Array.isArray(msg.labelIds) && msg.labelIds.includes('DRAFT')) {
            return { skipped: 'draft' };
        }

        // (b) Recipient match (company-scoped). REUSE findEmailContact per recipient;
        //     first matching recipient wins → a single deterministic timeline.
        const recipients = extractRecipientEmails(msg);
        if (recipients.length === 0) {
            return { skipped: 'no_recipient' };
        }
        let contact = null;
        for (const addr of recipients) {
            contact = await emailQueries.findEmailContact(addr, companyId);
            if (contact) break;
        }
        if (!contact) {
            return { skipped: 'no_contact' };
        }
        const contactId = contact.contact_id || contact.id;

        // (c) Resolve the contact's timeline (same single row the inbound/SMS path reaches).
        const timeline = await timelinesQueries.findOrCreateTimelineByContact(contactId, companyId);
        if (!timeline || !timeline.id) {
            return { skipped: 'no_contact' };
        }
        const timelineId = timeline.id;

        // Idempotency: detect a prior link BEFORE the (no-op) re-link UPDATE, so a
        // redelivered push / poll-overlap does not re-emit SSE.
        const existing = await emailQueries.getMessageLinkState(msg.provider_message_id, companyId);
        const alreadyLinked = !!(existing && existing.on_timeline && existing.contact_id != null);

        // (d) Link — keyed on unique (company_id, provider_message_id); re-link is a
        //     no-op UPDATE. Returns null if no such message row exists locally.
        const linked = await emailQueries.linkMessageToContact(
            msg.provider_message_id,
            companyId,
            { contact_id: contactId, timeline_id: timelineId, on_timeline: true }
        );
        if (!linked) {
            return { skipped: 'no_message' };
        }

        // EMAIL-UNREAD-001: an outbound reply means the mailbox owner has read
        // the thread — clear its unread counter so the Pulse row stops showing
        // "unread" after the dispatcher answers from the email workspace.
        if (linked.thread_id) {
            try {
                await emailQueries.markThreadRead(linked.thread_id, companyId);
            } catch (e) {
                console.warn('[EmailTimeline] outbound markThreadRead failed:', e.message);
            }
        }

        // EMAIL-UNREAD-002: replying marks the WHOLE timeline read (timeline +
        // contact + SMS + email flags), guarded against newer inbound events —
        // the thread counter alone left the Pulse row lit (tl/contact flags
        // stayed set when the reply came from the email workspace or Gmail).
        if (!alreadyLinked) {
            const { markReadAfterReply } = require('../replyReadService');
            await markReadAfterReply(companyId, {
                timelineId,
                contactId,
                replyAt: msg.internal_at || null,
            });
        }

        if (alreadyLinked) {
            return { linked: true, contactId, timelineId, alreadyLinked: true };
        }

        // SSE only — NO unread, NO Action-Required (the agent sent it). Mirror the
        // §5 send-path publish so a Gmail-sent reply appears right-aligned live.
        // Email has no conversation; pass a minimal object so the publisher's
        // `conversation.id` read is null-safe.
        try {
            realtimeService.publishMessageAdded(toEmailItem(linked), { id: null }, timelineId);
        } catch (e) {
            console.error('[EmailTimeline] linkOutboundMessage publishMessageAdded failed:', e.message);
        }

        return { linked: true, contactId, timelineId };
    } catch (err) {
        console.error(`[EmailTimeline] linkOutboundMessage error (company ${companyId}):`, err.message);
        return { error: err.message };
    }
}

/**
 * Push entrypoint (ET-5). Decode the provider push envelope → pull the touched
 * messages → link each. Never throws (the route has already fast-acked 200).
 *
 * @param {Object} pushPayload  Provider push envelope (Pub/Sub message).
 * @returns {Promise<object>} {handled:false} | {handled:true, company, processed, linked, skipped}
 */
async function ingestPushNotification(pushPayload) {
    try {
        const provider = providerRegistry.get();
        const decoded = await provider.handlePushNotification(pushPayload);
        if (!decoded || !decoded.companyId) {
            return { handled: false };
        }

        const { companyId, cursor } = decoded;
        const { messages } = await provider.pullChanges(companyId, cursor);
        const list = Array.isArray(messages) ? messages : [];

        let linked = 0;
        let skipped = 0;
        for (const msg of list) {
            // Route by direction: the agent's own sends (from === mailbox / SENT label)
            // go to the outbound projector (recipient-match, no unread); everything
            // else is treated as inbound (which still excludes DRAFT/SENT itself).
            const isOutbound = msg && (msg.is_outbound === true
                || (Array.isArray(msg.labelIds) && msg.labelIds.includes('SENT')));
            const res = isOutbound
                ? await linkOutboundMessage(companyId, msg)
                : await linkInboundMessage(companyId, msg);
            if (res && res.linked) linked++;
            else skipped++;
        }

        return { handled: true, company: companyId, processed: list.length, linked, skipped };
    } catch (err) {
        console.error('[EmailTimeline] ingestPushNotification error:', err.message);
        return { handled: false, error: err.message };
    }
}

/**
 * Poll entrypoint (reconciliation). The EMAIL-001 5-min sync already imports
 * INBOX inbound rows into email_messages; here we scan that company's recently
 * imported INBOUND rows that are not yet linked and link them. The
 * `direction='inbound'` filter IS the draft/sent exclusion for this path.
 *
 * @param {string} companyId
 * @param {{limit?: number}} [opts]
 * @returns {Promise<object>} {company, processed, linked, skipped}
 */
async function ingestPolledForCompany(companyId, { limit = 100 } = {}) {
    try {
        const rows = await emailQueries.listUnlinkedInboundForTimeline(companyId, { limit });
        const list = Array.isArray(rows) ? rows : [];

        let linked = 0;
        let skipped = 0;
        for (const row of list) {
            const msg = {
                provider_message_id: row.provider_message_id,
                from_email: row.from_email,
                from_name: row.from_name,
                subject: row.subject,
                body_text: row.body_text,
                internal_at: row.gmail_internal_at,
                is_outbound: false,
            };
            const res = await linkInboundMessage(companyId, msg);
            if (res && res.linked) linked++;
            else skipped++;
        }

        // Second pass: OUTBOUND reconciliation (EMAIL-TIMELINE-001 follow-up).
        // Drain recently-imported, not-yet-projected outbound rows (emails the agent
        // sent, incl. directly from Gmail) and project them by recipient match. The
        // `direction='outbound'` filter in the query IS the discriminator for this
        // path (stored rows carry no Gmail label). Idempotent + guarded like above.
        const outRows = await emailQueries.listUnlinkedOutboundForTimeline(companyId, { limit });
        const outList = Array.isArray(outRows) ? outRows : [];
        for (const row of outList) {
            const msg = {
                provider_message_id: row.provider_message_id,
                to_recipients_json: row.to_recipients_json,
                subject: row.subject,
                body_text: row.body_text,
                internal_at: row.gmail_internal_at,
            };
            const res = await linkOutboundMessage(companyId, msg);
            if (res && res.linked) linked++;
            else skipped++;
        }

        return { company: companyId, processed: list.length + outList.length, linked, skipped };
    } catch (err) {
        console.error(`[EmailTimeline] ingestPolledForCompany error (company ${companyId}):`, err.message);
        return { company: companyId, processed: 0, linked: 0, skipped: 0, error: err.message };
    }
}

/**
 * Load a company-scoped contact and its full set of email addresses in one query.
 * Returns `{ id, emails: string[] }` (emails = `contacts.email` ∪ `contact_emails`,
 * normalized lower/trim, deduped) or null when the contact is missing/foreign.
 */
async function loadContactWithEmails(companyId, contactId) {
    const result = await db.query(
        `SELECT c.id,
                ARRAY_REMOVE(
                    ARRAY_AGG(DISTINCT lower(btrim(e.addr))) FILTER (WHERE e.addr IS NOT NULL),
                    NULL
                ) AS emails
         FROM contacts c
         LEFT JOIN LATERAL (
             SELECT c.email AS addr
             UNION ALL
             SELECT ce.email FROM contact_emails ce WHERE ce.contact_id = c.id
         ) e ON true
         WHERE c.company_id = $1 AND c.id = $2
         GROUP BY c.id`,
        [companyId, contactId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, emails: Array.isArray(row.emails) ? row.emails : [] };
}

/**
 * Best-effort re-import of a just-sent thread so its row lands in email_messages
 * before we (re)link it (FIX #2 reconcile). Goes through the PROVIDER only
 * (`pullChanges` runs the same history walk + `importGmailThread` hydration that
 * the inbound/poll path uses) so the AC-12 seam is preserved — no `emailService`
 * / `emailSyncService` import here. Safe-fail: never throws; a failure just leaves
 * the retry to find no row, which is logged and degrades to the next sync.
 *
 * `pullChanges` is the provider's normalized history pull; passing `null` as the
 * cursor makes it walk from the mailbox's stored history id (its hydration step
 * re-imports the affected thread regardless of the per-message diff).
 *
 * @param {import('../mail/MailProvider')} provider
 * @param {string} companyId
 * @param {string|null} providerThreadId
 * @returns {Promise<void>}
 */
async function reimportThreadBestEffort(provider, companyId, providerThreadId) {
    try {
        if (!provider || typeof provider.pullChanges !== 'function') return;
        await provider.pullChanges(companyId, null);
    } catch (e) {
        console.error(
            `[EmailTimeline] sendForContact: thread re-import failed ` +
            `(company ${companyId}, thread ${providerThreadId}):`,
            e.message
        );
    }
}

/**
 * Outbound send from the contact timeline (§5 / TASK-ET-8). Reply-in-thread when
 * the contact already has an email thread, else initiate a new thread with an
 * auto subject. After the send, stamp the just-sent row `on_timeline=true` so it
 * renders right-aligned. Returns the created timeline email item for optimistic
 * append.
 *
 * Throws coded errors (`err.httpStatus` + `err.code`) the route maps to a JSON
 * envelope; unexpected errors are wrapped (500) but the coded ones are preserved.
 *
 * @param {string} companyId
 * @param {string|number} contactId
 * @param {{ body: string, toEmail: string, userId?: string, userEmail?: string }} opts
 * @returns {Promise<object>} the timeline email item (buildTimeline §6 shape).
 */
async function sendForContact(companyId, contactId, { body, toEmail, userId, userEmail } = {}) {
    const provider = providerRegistry.get(companyId);

    // 1. Connection guard — a disconnected/absent mailbox cannot send (FR-OUT, E-1).
    let status;
    try {
        status = await provider.getConnectionStatus(companyId);
    } catch (e) {
        throw codedError(409, 'MAILBOX_NOT_CONNECTED', 'Email mailbox is not connected');
    }
    if (!status || !status.connected) {
        throw codedError(409, 'MAILBOX_NOT_CONNECTED', 'Email mailbox is not connected');
    }

    // 2. Contact must exist within this company; toEmail must be one of its addresses.
    const contact = await loadContactWithEmails(companyId, contactId);
    if (!contact) {
        throw codedError(404, 'CONTACT_NOT_FOUND', 'Contact not found');
    }
    const normalizedTo = String(toEmail || '').trim().toLowerCase();
    if (!normalizedTo || !contact.emails.includes(normalizedTo)) {
        throw codedError(422, 'EMAIL_NOT_ON_CONTACT', 'Email is not on the contact');
    }

    try {
        // 3. Reply-vs-initiate: a prior thread → reply in it; none → new thread with
        //    auto subject `Message from <company.name>` (no subject field from the UI).
        const threadId = await emailQueries.getNewestThreadIdForContact(companyId, contactId);
        let sendResult;
        if (threadId != null) {
            sendResult = await provider.sendMessage(companyId, {
                to: toEmail,
                body,
                providerThreadId: threadId,
                userId,
                userEmail,
            });
        } else {
            let companyName = 'us';
            try {
                const company = await companyQueries.getCompanyById(companyId);
                if (company && company.name) companyName = company.name;
            } catch (e) {
                console.error('[EmailTimeline] getCompanyById for auto-subject failed:', e.message);
            }
            sendResult = await provider.sendMessage(companyId, {
                to: toEmail,
                subject: `Message from ${companyName}`,
                body,
                userId,
                userEmail,
            });
        }

        // 4. Stamp the just-sent outbound row on the timeline (FR-OUT-4). emailService
        //    re-imports the thread via importGmailThread on send, so the row is
        //    normally already in email_messages — but that import is best-effort
        //    (wrapped in a try/catch that only logs). If it hiccupped, the link below
        //    matches 0 rows and returns null, and the sent email would never surface.
        //    So: link, and if it did not link a REAL row, re-import the thread (via
        //    the provider — keeps the AC-12 seam) and retry once.
        const providerMessageId = sendResult && sendResult.provider_message_id;
        const providerThreadId = sendResult && sendResult.provider_thread_id;
        const timeline = await timelinesQueries.findOrCreateTimelineByContact(contactId, companyId);
        const timelineId = timeline && timeline.id;

        let linkedRow = null;
        if (providerMessageId && timelineId) {
            linkedRow = await emailQueries.linkMessageToContact(providerMessageId, companyId, {
                contact_id: contactId,
                timeline_id: timelineId,
                on_timeline: true,
            });

            // Reconcile: the row was not present yet (import hiccup). Re-pull the
            // thread so the sent message row exists locally, then retry the link.
            if (!linkedRow) {
                await reimportThreadBestEffort(provider, companyId, providerThreadId);
                linkedRow = await emailQueries.linkMessageToContact(providerMessageId, companyId, {
                    contact_id: contactId,
                    timeline_id: timelineId,
                    on_timeline: true,
                });
                if (!linkedRow) {
                    // Still cannot link after a re-import — log and fall through to the
                    // best-effort item. Do NOT throw: the email WAS sent.
                    console.warn(
                        `[EmailTimeline] sendForContact: could not link sent message ${providerMessageId} ` +
                        `(company ${companyId}, thread ${providerThreadId}) after re-import; ` +
                        `returning best-effort item — it will appear on the next sync.`
                    );
                }
            }
        }

        // 5. Build the timeline email item (flat read-projection shape). Prefer the
        //    just-linked row; otherwise fall back to the §6 projection (covers the
        //    case where the row exists but linkMessageToContact's RETURNING wasn't
        //    the one we read); last resort, synthesize from what we know so the UI
        //    still gets a right-aligned bubble.
        let item = linkedRow ? toEmailItem(linkedRow) : null;
        if (!item) {
            const rows = await emailQueries.getTimelineEmailByContact(companyId, contactId);
            const match = Array.isArray(rows)
                ? rows.find(r => String(r.provider_thread_id) === String(providerThreadId)
                    && r.direction === 'outbound')
                    || rows[rows.length - 1]
                : null;
            item = match ? toEmailItem(match) : null;
        }
        if (!item) {
            item = toEmailItem({
                id: null,
                thread_id: threadId,
                direction: 'outbound',
                from_name: null,
                from_email: status.email_address || null,
                to_recipients_json: [toEmail],
                subject: null,
                body_text: body || '',
                gmail_internal_at: new Date().toISOString(),
                sent_by_user_email: userEmail || null,
            });
        }

        // 6. Broadcast (§5.4) so an open timeline shows the outbound bubble live.
        //    Email has no conversation; pass a minimal object so the publisher's
        //    `conversation.id` read is null-safe. Never let a publish failure fail
        //    the send.
        if (timelineId) {
            try {
                realtimeService.publishMessageAdded(item, { id: null }, timelineId);
            } catch (e) {
                console.error('[EmailTimeline] sendForContact publishMessageAdded failed:', e.message);
            }
        }

        return item;
    } catch (err) {
        // Preserve already-coded errors (incl. EMAIL-001 reconnect_required → 409).
        if (err && err.httpStatus) throw err;
        if (err && err.statusCode === 409) {
            throw codedError(409, 'MAILBOX_NOT_CONNECTED', 'Email mailbox is not connected');
        }
        console.error(`[EmailTimeline] sendForContact error (company ${companyId}):`, err.message);
        throw codedError(500, 'EMAIL_SEND_FAILED', 'Failed to send email');
    }
}

module.exports = {
    linkInboundMessage,
    linkOutboundMessage,
    extractRecipientEmails,
    ingestPushNotification,
    ingestPolledForCompany,
    sendForContact,
};
