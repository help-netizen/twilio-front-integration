/**
 * yelpLeadService — YELP-LEAD-AUTORESPONDER-002 (durable task+agent refactor).
 *
 * Purely additive to the Mail Secretary. When a Yelp *new-lead* email is ingested,
 * detect it, atomically claim it, parse the labeled Q&A, create a JobSource='Yelp'
 * lead, and ENQUEUE ONE durable `agent_type='yelp_lead'` task. The greeting is no
 * longer built/sent inline here — the shared agentWorker claims the task and the
 * `yelp_lead` handler (agentHandlers.js) builds + sends the single greeting, then
 * closes the task. Moving the send off the mail-ingest hot path makes it retryable
 * (≤3, backoff), Pulse-visible when stuck, and free of Mail-Secretary coupling.
 *
 * Public helpers (all pure except the orchestrator):
 *   detectYelpLead(msg)              → boolean. Both required: relay domain AND a
 *                                      first-message signal. Replies/confirmations → false.
 *   parseYelpLead(msg)               → { name, last_name, service, problem, zip, city,
 *                                        state, reply_to, thread_token, magic_link }.
 *                                      Fail-safe: missing field → null; never throws.
 *   maybeHandleYelpLead(companyId,msg) → orchestrator. NEVER throws (fail-open).
 *
 * LOCKED order in maybeHandleYelpLead:
 *   env/scope gate → detect → CLAIM → parse → createLead → attachLead → ENQUEUE.
 * CLAIM is a releasable lock: released ONLY when createLead throws (→ next poll
 * re-attempts the lead — lead at-least-once). Once the lead exists the claim is HELD
 * (greeting at-most-once). If the enqueue INSERT fails after the lead exists we HOLD
 * the claim (never releaseClaim → no dup lead); the claim then sits task_id IS NULL
 * AND greeted_at IS NULL and a re-ingest reconcile (B1) re-enqueues the lost task.
 * greet/buildGreeting/sendEmail/markGreeted/threadAlreadyGreeted moved to the handler.
 */
'use strict';

const yelpLeadQueries = require('../db/yelpLeadQueries');
const yelpConversationQueries = require('../db/yelpConversationQueries');
const { parseConversationId } = require('./yelpConversationId');
const db = require('../db/connection');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// Relay domain gate — the real Yelp From IS reply+<hex>@messaging.yelp.com.
const YELP_RELAY_DOMAIN_RE = /@messaging\.yelp\.com$/i;
// Relay local-part → full reply address + hex thread token.
const YELP_RELAY_ADDR_RE = /(reply\+([0-9a-f]+)@messaging\.yelp\.com)/i;

// YELP-TIMELINE-DEDUP-001 — Yelp SYSTEM-notification senders (welcome/confirmation
// echoes, "New message from ABC Homes" notices). These are NOT the customer relay
// and carry no conv-id; they must NEVER create a junk contact. A no-reply@notify.
// yelp.com confirmation does NOT match YELP_RELAY_DOMAIN_RE, so BOTH gates are
// needed to guarantee no junk contact from any Yelp sender (spec §S5 / G-2).
const YELP_NOTIFY_DOMAIN_RE = /@(?:[a-z0-9-]+\.)*notify\.yelp\.com$/i;
const YELP_NOREPLY_RE = /^no-?reply@(?:[a-z0-9-]+\.)*yelp\.com$/i;

/**
 * Is this inbound from the Yelp customer RELAY (reply+<hex>@messaging.yelp.com)?
 * The one gate the subsuming timeline branch (emailTimelineService) keys on. Reads
 * only from_email; pure and null-safe.
 * @param {object} msg
 * @returns {boolean}
 */
function isYelpRelay(msg) {
    const from = String((msg && msg.from_email) || '').trim().toLowerCase();
    return !!from && YELP_RELAY_DOMAIN_RE.test(from);
}

/**
 * Is this inbound a Yelp SYSTEM notification (no-reply@*yelp.com / *@notify.yelp.com)
 * that is NOT the customer relay? Used to suppress junk-contact creation from Yelp
 * senders that do not enter the relay branch. Pure and null-safe; never overlaps a
 * relay message (a relay is checked first by the caller).
 * @param {object} msg
 * @returns {boolean}
 */
function isYelpNoise(msg) {
    const from = String((msg && msg.from_email) || '').trim().toLowerCase();
    if (!from) return false;
    if (YELP_RELAY_DOMAIN_RE.test(from)) return false; // the relay is handled by isYelpRelay, not here
    return YELP_NOREPLY_RE.test(from) || YELP_NOTIFY_DOMAIN_RE.test(from);
}

// First-message signals (either satisfies the second half of the AND-gate).
const FIRST_MESSAGE_UTM_RE = /utm_source=request_a_quote_first_message/i;
const NEW_MESSAGE_UTM_RE = /utm_source=request_a_quote_new_message/i;
const REQUESTED_QUOTE_HEADER_RE = /requested a quote[\s\S]{0,120}?for a\b/i;

function isEnabled() {
    const v = String(process.env.YELP_AUTORESPONDER_ENABLED || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * YELP-CONVO-BOOKING-001 (Phase B) greeter switch — is the multi-turn BRAIN enabled?
 * When ON, the FIRST Yelp message is greeted by a `yelp_convo` turn-0 task (the brain
 * greets + collects) instead of the `yelp_lead` greeter. Default OFF (dark launch).
 * Independent of YELP_AUTORESPONDER_ENABLED (which gates the plumbing above).
 */
function isConvoEnabled() {
    const v = String(process.env.YELP_CONVO_ENABLED || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Is this inbound message a Yelp NEW-lead (first message)? Both conditions required:
 *   (1) from_email is the @messaging.yelp.com relay, AND
 *   (2) a first-message signal (utm request_a_quote_first_message OR a
 *       "<Name> requested a quote … for a <service>" header line).
 * In-thread customer replies (request_a_quote_new_message) and no-reply@…yelp.com
 * confirmations must NOT match.
 * @param {import('../mail/MailProvider').NormalizedInboundMessage} msg
 * @returns {boolean}
 */
function detectYelpLead(msg) {
    if (!msg || !msg.from_email) return false;
    const from = String(msg.from_email).trim().toLowerCase();
    if (!YELP_RELAY_DOMAIN_RE.test(from)) return false;

    const body = String(msg.body_text || '');
    const firstMessageUtm = FIRST_MESSAGE_UTM_RE.test(body);
    const requestedQuoteHeader = REQUESTED_QUOTE_HEADER_RE.test(body);
    const isReplyUtm = NEW_MESSAGE_UTM_RE.test(body);

    // An explicit in-thread reply is never a new lead (unless it ALSO carries the
    // first-message utm, which real Yelp replies do not).
    if (isReplyUtm && !firstMessageUtm) return false;

    return firstMessageUtm || requestedQuoteHeader;
}

/**
 * Parse a Yelp new-lead email into structured fields. Fail-safe: any field that
 * cannot be recovered is null; NEVER throws.
 * @param {import('../mail/MailProvider').NormalizedInboundMessage} msg
 * @returns {{name:(string|null), last_name:(string|null), service:(string|null),
 *   problem:(string|null), zip:(string|null), city:(string|null), state:(string|null),
 *   reply_to:(string|null), thread_token:(string|null), magic_link:(string|null)}}
 */
function parseYelpLead(msg) {
    const out = {
        name: null, last_name: null, service: null, problem: null,
        zip: null, city: null, state: null,
        reply_to: null, thread_token: null, magic_link: null,
    };
    try {
        const body = String((msg && msg.body_text) || '');
        const fromEmail = String((msg && msg.from_email) || '');

        // --- reply_to + thread_token: primary from from_email local-part, fallback body.
        let relay = fromEmail.match(YELP_RELAY_ADDR_RE);
        if (!relay) {
            // Fallback: a "reply directly to this email" relay in the body.
            relay = body.match(YELP_RELAY_ADDR_RE);
        }
        if (relay) {
            out.reply_to = relay[1];
            out.thread_token = relay[2];
        }

        // --- name + service from "<Name> requested a quote … for a <service>".
        const hdr = body.match(
            /([A-Z][A-Za-z.'’-]+)\s+requested a quote[\s\S]*?for a\s+([A-Za-z0-9 ./&'-]+?)(?:[.\n\r]|$)/i
        );
        if (hdr) {
            out.name = hdr[1].trim();
            out.service = hdr[2].trim().replace(/\s+/g, ' ');
        }

        // --- problem: the customer's free-text answer to a labeled Yelp question.
        const problemLabels = [
            /what can we help you with\??\s*\n+([\s\S]*?)(?:\n\s*\n|$)/i,
            /(?:project|service) details?\s*:?\s*\n*([\s\S]*?)(?:\n\s*\n|$)/i,
            /(?:your |the )?message\s*:?\s*\n+([\s\S]*?)(?:\n\s*\n|$)/i,
        ];
        for (const re of problemLabels) {
            const m = body.match(re);
            if (m && m[1] && m[1].trim()) {
                out.problem = m[1].trim().replace(/[ \t]+/g, ' ');
                break;
            }
        }

        // --- city / state / zip from a "City, ST 12345" line; then loose zip fallback.
        const csz = body.match(/([A-Za-z][A-Za-z .'’-]*),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/);
        if (csz) {
            out.city = csz[1].trim();
            out.state = csz[2].trim().toUpperCase();
            out.zip = csz[3];
        } else {
            const zipOnly = body.match(/\b(\d{5})(?:-\d{4})?\b/);
            if (zipOnly) out.zip = zipOnly[1];
        }

        // --- magic link (the Yelp "view request" tracking URL), best-effort.
        const link = body.match(/https?:\/\/[^\s<>"']*utm_source=request_a_quote_first_message[^\s<>"']*/i);
        if (link) out.magic_link = link[0];
    } catch (e) {
        // Fail-safe: return whatever was recovered so far; never throw.
        console.error('[YelpLead] parseYelpLead failed (returning partial):', e && e.message);
    }
    return out;
}

function splitName(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return { first: null, last: '' };
    const idx = trimmed.indexOf(' ');
    if (idx === -1) return { first: trimmed, last: '' };
    return { first: trimmed.slice(0, idx).trim(), last: trimmed.slice(idx + 1).trim() };
}

function buildLeadFields(parsed) {
    const { first, last } = splitName(parsed.name);
    const commentParts = [];
    if (parsed.service) commentParts.push(`Service: ${parsed.service}`);
    if (parsed.problem) commentParts.push(`Problem: ${parsed.problem}`);
    if (parsed.zip) commentParts.push(`ZIP: ${parsed.zip}`);
    if (parsed.thread_token) commentParts.push(`Yelp thread token: ${parsed.thread_token}`);
    if (parsed.reply_to) commentParts.push(`Reply-to: ${parsed.reply_to}`);

    return {
        FirstName: first,
        LastName: last,
        Phone: null, // Phase 1a: Yelp relay carries no phone.
        City: parsed.city || null,
        State: parsed.state || 'MA',
        PostalCode: parsed.zip || null,
        JobType: parsed.service || null,
        JobSource: 'Yelp',
        Description: parsed.problem || null,
        Comments: commentParts.length ? commentParts.join(' | ') : null,
        Status: 'Submitted',
    };
}

/**
 * Orchestrate the Yelp new-lead autoresponse. NEVER throws — on any unexpected
 * error it logs and returns { handled:false } so the ingest pipeline continues.
 *
 * @param {string} companyId
 * @param {import('../mail/MailProvider').NormalizedInboundMessage} msg
 * @returns {Promise<{handled:boolean, skipped?:string, reason?:string,
 *   leadId?:(number|null), greeted?:boolean}>}
 */
async function maybeHandleYelpLead(companyId, msg) {
    try {
        // (0) env + company scope gate — Phase 1a is the default company only.
        if (!isEnabled() || companyId !== DEFAULT_COMPANY_ID) {
            return { handled: false };
        }

        // (1) detect — both conditions (relay domain AND first-message signal).
        if (!detectYelpLead(msg)) {
            return { handled: false };
        }

        // (2) CLAIM (before parse) — atomic idempotency lock. A lost claim means a
        //     re-ingest of the same message: already handled, do not re-greet.
        let claim;
        try {
            claim = await yelpLeadQueries.claimYelpLead(companyId, msg.provider_message_id);
        } catch (e) {
            console.error('[YelpLead] claim failed (fail-open, letting normal pipeline run):', e && e.message);
            return { handled: false };
        }
        if (!claim || !claim.claimed) {
            // A re-ingest of an already-claimed message. Normally already handled —
            // BUT if a prior cycle crashed between createLead and enqueue, the claim
            // row sits task_id IS NULL AND greeted_at IS NULL: the greeting task was
            // LOST. Re-enqueue it (idempotent) so the existing poll re-scan recovers
            // it with no new cron (B1 reconcile).
            return await reconcileLostTask(companyId, msg);
        }
        const claimId = claim.id;

        // (3) parse — fail-safe, never throws.
        const parsed = parseYelpLead(msg);

        // (4) createLead — if it throws, RELEASE the claim so the next poll retries
        //     (lead at-least-once), and stay committed to the Yelp branch this cycle.
        let lead = null;
        try {
            lead = await require('./leadsService').createLead(buildLeadFields(parsed), companyId);
        } catch (e) {
            console.error('[YelpLead] createLead failed, releasing claim for retry:', e && e.message);
            try {
                await yelpLeadQueries.releaseClaim(claimId);
            } catch (re) {
                console.error('[YelpLead] releaseClaim failed:', re && re.message);
            }
            return { handled: true, skipped: 'yelp_lead', reason: 'lead_create_failed' };
        }
        const leadId = lead && lead.ClientId != null ? parseInt(lead.ClientId, 10) : null;

        // (5) record the lead on the claim row BEFORE the fallible enqueue, so a
        //     reconcile can recover the lead id even if the task INSERT fails.
        try {
            await yelpLeadQueries.attachLead(claimId, leadId);
        } catch (e) {
            console.error('[YelpLead] attachLead failed (continuing to enqueue):', e && e.message);
        }

        // (5b) YELP-CONVO-BOOKING-001 (Phase A) — upsert the durable conversation row
        //      keyed on the STABLE body conv-id (message_to_business_conversation/<id>).
        //      Best-effort: a failure here must NOT break the greeting (which stays on
        //      the yelp_lead task below). lead_uuid drives the Phase-B booking sidestep;
        //      phase='greet' is the entry state. No conv-id in the body → skip (the
        //      greeting still fires; only the multi-turn thread store is unavailable).
        let convId = null;
        try {
            convId = parseConversationId(msg);
            if (convId) {
                await yelpConversationQueries.upsertConversation(companyId, convId, {
                    lead_id: leadId,
                    lead_uuid: (lead && lead.UUID) || null,
                    phase: 'greet',
                    last_reply_to: parsed.reply_to,
                    last_thread_token: parsed.thread_token,
                    last_inbound_message_id: msg.provider_message_id,
                });
            }
        } catch (e) {
            console.error('[YelpConvo] upsertConversation (first-message) failed (non-fatal):', e && e.message);
        }

        // (6) ENQUEUE the greeter (REPLACES the old synchronous greet+send). GREETER
        //     SWITCH (Phase B): when YELP_CONVO_ENABLED is ON and we have a conversation
        //     to thread, the first message is greeted by a `yelp_convo` TURN-0 task (the
        //     brain greets + collects) instead of `yelp_lead` — exactly ONE greeter runs,
        //     never a double-greet. When OFF (or no conv-id to thread), `yelp_lead`
        //     greets exactly as today (Phase A unbroken). The shared agentWorker runs
        //     either — retryable, Pulse-visible when stuck.
        const useConvoGreeter = isConvoEnabled() && !!convId;
        const enqueuedType = useConvoGreeter ? 'yelp_convo' : 'yelp_lead';
        try {
            const taskId = useConvoGreeter
                ? await enqueueYelpConvoGreetingTask(companyId, {
                    claimId, convId, msg, parsed, leadId, leadUuid: (lead && lead.UUID) || null,
                })
                : await enqueueYelpGreetingTask(companyId, {
                    claimId, leadId, parsed, providerMessageId: msg.provider_message_id,
                });
            console.log('[YelpLead] enqueued %s company=%s msg=%s lead=%s task=%s',
                enqueuedType, companyId, msg.provider_message_id, leadId, taskId);
        } catch (e) {
            // Enqueue failed AFTER the lead exists → HOLD the claim (do NOT
            // releaseClaim — the lead already exists; releasing would duplicate it on
            // the next poll). task_id stays NULL → a future reconcile re-enqueues.
            console.error('[YelpLead] enqueue failed after lead created (holding claim for reconcile):', e && e.message);
            return { handled: true, skipped: enqueuedType, reason: 'enqueue_failed', leadId };
        }

        return { handled: true, skipped: enqueuedType, leadId };
    } catch (e) {
        // Fail-open: an unexpected error must NOT crash ingest; let the normal
        // pipeline continue by reporting not-handled.
        console.error('[YelpLead] unexpected error (fail-open):', e && e.message);
        return { handled: false };
    }
}

/**
 * Enqueue the single durable greeting task on the shared agentWorker. INSERTs a
 * `kind='agent', agent_type='yelp_lead', max_attempts=3` task parented to the lead,
 * then stamps its id back on the claim row (so a reconcile knows it was enqueued).
 * `max_attempts=3` opts THIS type (and only this type) into the worker's retry.
 * @returns {Promise<number|null>} the new task id
 */
async function enqueueYelpGreetingTask(companyId, { claimId, leadId, parsed, providerMessageId }) {
    const agentInput = {
        claim_id: claimId,
        provider_message_id: providerMessageId,
        thread_token: parsed.thread_token,
        reply_to: parsed.reply_to,
        lead_id: leadId,
        customer_name: parsed.name,
        service_type: parsed.service,
        problem_text: parsed.problem,
        zip: parsed.zip,
    };
    const title = `Yelp greeting — ${parsed.name || 'new lead'}`;
    const { rows } = await db.query(
        `INSERT INTO tasks (company_id, kind, agent_type, agent_input, agent_status,
                            max_attempts, title, status, created_by, lead_id, subject_type)
         VALUES ($1, 'agent', 'yelp_lead', $2::jsonb, 'queued', 3,
                 $3, 'open', 'automation', $4, 'lead')
         RETURNING id`,
        [companyId, JSON.stringify(agentInput), title, leadId]
    );
    const taskId = rows && rows[0] ? rows[0].id : null;
    // Stamp the task id on the claim row → a reconcile sees "enqueued" and skips.
    await yelpLeadQueries.attachTask(claimId, taskId);
    return taskId;
}

/**
 * YELP-CONVO-BOOKING-001 (Phase B greeter switch) — enqueue the FIRST-message greeting
 * as a `yelp_convo` TURN-0 task (the brain greets + starts collecting) instead of the
 * `yelp_lead` greeter. Mirrors enqueueYelpGreetingTask's durable shape (kind='agent',
 * max_attempts=3 opt-in retry, subject_type='lead', created_by='automation') and stamps
 * the task id on the LEAD claim so a reconcile skips. The convo handler's per-inbound
 * claim KEY is the first message's pmid with a ':greet0' suffix, so it does NOT collide
 * with the lead claim already held on the bare pmid — the handler's own
 * claimYelpLead(inbound_pmid) then makes the greeting at-most-once / retry-safe exactly
 * like a reply turn.
 * @returns {Promise<number|null>} the new task id
 */
async function enqueueYelpConvoGreetingTask(companyId, { claimId, convId, msg, parsed, leadId, leadUuid }) {
    const agentInput = {
        conversation_id: convId,
        inbound_provider_message_id: `${msg.provider_message_id}:greet0`,
        inbound_body_text: (msg && msg.body_text) || null,
        reply_to: parsed.reply_to,
        thread_token: parsed.thread_token,
        lead_id: leadId,
        lead_uuid: leadUuid,
        greeting: true,
    };
    const title = `Yelp greeting — ${parsed.name || 'new lead'}`;
    const { rows } = await db.query(
        `INSERT INTO tasks (company_id, kind, agent_type, agent_input, agent_status,
                            max_attempts, title, status, created_by, lead_id, subject_type)
         VALUES ($1, 'agent', 'yelp_convo', $2::jsonb, 'queued', 3,
                 $3, 'open', 'automation', $4, 'lead')
         RETURNING id`,
        [companyId, JSON.stringify(agentInput), title, leadId]
    );
    const taskId = rows && rows[0] ? rows[0].id : null;
    // Stamp the task id on the LEAD claim row → a reconcile sees "enqueued" and skips.
    try {
        await yelpLeadQueries.attachTask(claimId, taskId);
    } catch (e) {
        console.error('[YelpConvo] attachTask (greeting) failed (non-fatal):', e && e.message);
    }
    return taskId;
}

/**
 * B1 reconcile: a re-ingest lost the claim (already claimed). If the claim row is
 * `task_id IS NULL AND greeted_at IS NULL` the greeting task was lost between
 * createLead and enqueue → re-enqueue it (idempotent). Otherwise (enqueued or
 * greeted) it is a genuine already-handled no-op. Never creates a second lead.
 */
async function reconcileLostTask(companyId, msg) {
    try {
        const existing = await yelpLeadQueries.getClaimByMessage(companyId, msg.provider_message_id);
        const lostTask = existing
            && existing.greeted_at == null
            && existing.task_id == null
            && existing.lead_id != null;
        if (lostTask) {
            const parsed = parseYelpLead(msg);
            const leadId = existing.lead_id != null ? parseInt(existing.lead_id, 10) : null;

            // Defense-in-depth (never double-greet): if THIS Yelp thread was already
            // greeted — e.g. the turn-0 `yelp_convo` greeter already sent and stamped the
            // shared thread_token marker (see agentHandlers.yelp_convo) — do NOT enqueue
            // ANY greeter. This unifies the dedup namespace across the greeter's
            // `<pmid>:greet0` claim and this lost lead claim, so a re-ingest can never
            // produce a second greeting.
            if (parsed.thread_token
                && await yelpLeadQueries.threadAlreadyGreeted(companyId, parsed.thread_token)) {
                console.log('[YelpLead] reconcile skipped — thread already greeted company=%s msg=%s lead=%s',
                    companyId, msg.provider_message_id, leadId);
                return { handled: true, skipped: 'noop', reason: 'already_greeted_thread', leadId };
            }

            // Flag-aware greeter switch — MIRRORS maybeHandleYelpLead step (6): when the
            // convo BRAIN owns the first greeting (YELP_CONVO_ENABLED ON + a stable conv-id
            // to thread), re-enqueue the `yelp_convo` TURN-0 greeter (its per-inbound
            // `<pmid>:greet0` claim de-dupes a duplicate) instead of `yelp_lead` — whose
            // INDEPENDENT thread_token dedup namespace could otherwise double-greet. When
            // OFF (or no conv-id) → `yelp_lead` exactly as before (Phase A unbroken).
            if (isConvoEnabled()) {
                const convId = parseConversationId(msg);
                if (convId) {
                    const taskId = await enqueueYelpConvoGreetingTask(companyId, {
                        claimId: existing.id, convId, msg, parsed, leadId, leadUuid: null,
                    });
                    console.log('[YelpConvo] reconcile re-enqueued lost convo greeter company=%s msg=%s lead=%s task=%s',
                        companyId, msg.provider_message_id, leadId, taskId);
                    return { handled: true, skipped: 'yelp_convo', reason: 'reconciled_enqueue', leadId };
                }
            }

            const taskId = await enqueueYelpGreetingTask(companyId, {
                claimId: existing.id, leadId, parsed, providerMessageId: msg.provider_message_id,
            });
            console.log('[YelpLead] reconcile re-enqueued lost greeting task company=%s msg=%s lead=%s task=%s',
                companyId, msg.provider_message_id, leadId, taskId);
            return { handled: true, skipped: 'yelp_lead', reason: 'reconciled_enqueue', leadId };
        }
    } catch (e) {
        console.error('[YelpLead] reconcile re-enqueue failed (holding claim):', e && e.message);
    }
    return { handled: true, skipped: 'yelp_lead', reason: 'already_claimed' };
}

// ── YELP-CONVO-BOOKING-001 (Phase A) — respondable-reply intercept ────────────

/**
 * Is this inbound a RESPONDABLE Yelp customer reply (an in-thread new message we
 * should thread into an existing conversation)? Both required:
 *   (1) from_email is the @messaging.yelp.com relay, AND
 *   (2) a new-message signal (utm request_a_quote_new_message[_respondable]) WITHOUT
 *       the first-message utm.
 * The first-message case (detectYelpLead) and no-reply@…yelp.com confirmations
 * (wrong domain) must NOT match — this is the complement of a NEW lead.
 * @param {import('../mail/MailProvider').NormalizedInboundMessage} msg
 * @returns {boolean}
 */
function detectYelpReply(msg) {
    if (!msg || !msg.from_email) return false;
    const from = String(msg.from_email).trim().toLowerCase();
    if (!YELP_RELAY_DOMAIN_RE.test(from)) return false;

    const body = String(msg.body_text || '');
    const isReplyUtm = NEW_MESSAGE_UTM_RE.test(body);
    const isFirstUtm = FIRST_MESSAGE_UTM_RE.test(body);
    // A respondable reply carries the new-message utm and is NOT a first message.
    return isReplyUtm && !isFirstUtm;
}

/**
 * Enqueue ONE durable `yelp_convo` turn task on the shared agentWorker for a
 * respondable reply. Mirrors the yelp_lead enqueue shape (kind='agent',
 * max_attempts=3 opt-in retry, subject_type='lead', created_by='automation'). The
 * handler claims the inbound provider_message_id → duplicate enqueues (poll re-scan)
 * are de-duplicated there (at-most-once per inbound), so no claim is needed here.
 * @returns {Promise<number|null>} the new task id
 */
async function enqueueYelpConvoTurnTask(companyId, { conv, convId, msg, replyTo, threadToken }) {
    const leadId = conv && conv.lead_id != null ? parseInt(conv.lead_id, 10) : null;
    const agentInput = {
        conversation_id: convId,
        inbound_provider_message_id: msg.provider_message_id,
        inbound_body_text: (msg && msg.body_text) || null,
        reply_to: replyTo,
        thread_token: threadToken,
        lead_id: leadId,
        lead_uuid: (conv && conv.lead_uuid) || null,
    };
    const title = `Yelp reply — ${convId}`;
    const { rows } = await db.query(
        `INSERT INTO tasks (company_id, kind, agent_type, agent_input, agent_status,
                            max_attempts, title, status, created_by, lead_id, subject_type)
         VALUES ($1, 'agent', 'yelp_convo', $2::jsonb, 'queued', 3,
                 $3, 'open', 'automation', $4, 'lead')
         RETURNING id`,
        [companyId, JSON.stringify(agentInput), title, leadId]
    );
    return rows && rows[0] ? rows[0].id : null;
}

/**
 * Route a respondable Yelp reply to its existing conversation. NEVER throws
 * (fail-open). Behavior:
 *   • gate OFF / non-default company / not a respondable reply → {handled:false}
 *   • no stable conv-id in the body → {handled:false} (fall through)
 *   • conv-id matches NO active (status='open') conversation → {handled:false}
 *     (FALL THROUGH — do NOT create a lead, do NOT enqueue, do NOT write another row)
 *   • known active conversation → refresh last_reply_to to this turn's fresh relay
 *     address + enqueue ONE `yelp_convo` turn task → {handled:true, skipped:'yelp_convo'}
 * @param {string} companyId
 * @param {import('../mail/MailProvider').NormalizedInboundMessage} msg
 * @returns {Promise<{handled:boolean, skipped?:string, conversationId?:string, leadId?:(number|null)}>}
 */
async function maybeHandleYelpReply(companyId, msg) {
    try {
        // (0) env + company scope gate — Phase 1a is the default company only.
        if (!isEnabled() || companyId !== DEFAULT_COMPANY_ID) {
            return { handled: false };
        }

        // (1) detect — relay domain AND respondable new-message signal.
        if (!detectYelpReply(msg)) {
            return { handled: false };
        }

        // (2) parse the STABLE conv-id from the body. No id → routing signal to fall
        //     through (never a partial/garbage key).
        const convId = parseConversationId(msg);
        if (!convId) {
            return { handled: false };
        }

        // (3) look up an ACTIVE conversation. Unknown / terminal → FALL THROUGH: a
        //     stray or late reply is left to the normal pipeline; never mis-attached,
        //     never a new lead, never a write to a non-matching row.
        const conv = await yelpConversationQueries.getByConvId(companyId, convId);
        if (!conv || conv.status !== 'open') {
            return { handled: false };
        }

        // (4) the relay address rotates per message → capture THIS turn's fresh
        //     reply+<hex>@ as where the reply goes (fallback to the stored one).
        const relay = String((msg && msg.from_email) || '').match(YELP_RELAY_ADDR_RE);
        const replyTo = relay ? relay[1] : (conv.last_reply_to || null);
        const threadToken = relay ? relay[2] : (conv.last_thread_token || null);

        // (5) point the conversation at the fresh relay address (best-effort — Phase B
        //     sends to conv.last_reply_to; the enqueue below also carries reply_to).
        try {
            await yelpConversationQueries.updateState(companyId, convId, {
                last_reply_to: replyTo,
                last_thread_token: threadToken,
            });
        } catch (e) {
            console.error('[YelpConvo] updateState(last_reply_to) failed (non-fatal):', e && e.message);
        }

        // (6) enqueue exactly ONE durable turn task (handler de-dupes per inbound).
        const taskId = await enqueueYelpConvoTurnTask(companyId, { conv, convId, msg, replyTo, threadToken });
        console.log('[YelpConvo] enqueued turn company=%s conv=%s msg=%s task=%s',
            companyId, convId, msg.provider_message_id, taskId);

        return { handled: true, skipped: 'yelp_convo', conversationId: convId, leadId: conv.lead_id };
    } catch (e) {
        // Fail-open: an unexpected error must NOT crash ingest; report not-handled so
        // the normal pipeline continues.
        console.error('[YelpConvo] maybeHandleYelpReply unexpected error (fail-open):', e && e.message);
        return { handled: false };
    }
}

module.exports = {
    detectYelpLead,
    detectYelpReply,
    isYelpRelay,
    isYelpNoise,
    parseYelpLead,
    maybeHandleYelpLead,
    maybeHandleYelpReply,
    enqueueYelpGreetingTask,
    enqueueYelpConvoTurnTask,
    enqueueYelpConvoGreetingTask,
    isConvoEnabled,
    DEFAULT_COMPANY_ID,
};
