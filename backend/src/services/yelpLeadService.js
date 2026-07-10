/**
 * yelpLeadService — YELP-LEAD-AUTORESPONDER-001 (Phase 1a, TASK-YLA-004).
 *
 * Purely additive to the Mail Secretary. When a Yelp *new-lead* email is ingested,
 * detect it, atomically claim it, parse the labeled Q&A, create a JobSource='Yelp'
 * lead, and send exactly ONE personalized greeting back through the Yelp relay.
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
 *   env/scope gate → detect → CLAIM → parse → createLead → greet+send → markGreeted.
 * CLAIM is a releasable lock: released ONLY when createLead throws (→ next poll
 * re-attempts the lead). Held after the lead exists → greeting at-most-once; a send
 * failure after the lead exists is logged, NOT retried (Yelp = one reply per thread).
 */
'use strict';

const yelpLeadQueries = require('../db/yelpLeadQueries');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// Relay domain gate — the real Yelp From IS reply+<hex>@messaging.yelp.com.
const YELP_RELAY_DOMAIN_RE = /@messaging\.yelp\.com$/i;
// Relay local-part → full reply address + hex thread token.
const YELP_RELAY_ADDR_RE = /(reply\+([0-9a-f]+)@messaging\.yelp\.com)/i;

// First-message signals (either satisfies the second half of the AND-gate).
const FIRST_MESSAGE_UTM_RE = /utm_source=request_a_quote_first_message/i;
const NEW_MESSAGE_UTM_RE = /utm_source=request_a_quote_new_message/i;
const REQUESTED_QUOTE_HEADER_RE = /requested a quote[\s\S]{0,120}?for a\b/i;

function isEnabled() {
    const v = String(process.env.YELP_AUTORESPONDER_ENABLED || '').trim().toLowerCase();
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
            return { handled: true, skipped: 'yelp_lead', reason: 'already_claimed' };
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

        // (5) greeting + send — best-effort; bail the send if there is no relay to
        //     reply to (never misroute). A send failure after the lead exists is
        //     logged and NOT retried.
        let greeted = false;
        let greetingProviderMessageId = null;
        if (parsed.reply_to) {
            let alreadyGreeted = false;
            try {
                alreadyGreeted = await yelpLeadQueries.threadAlreadyGreeted(companyId, parsed.thread_token);
            } catch (e) {
                console.error('[YelpLead] threadAlreadyGreeted check failed (proceeding):', e && e.message);
            }
            if (!alreadyGreeted) {
                try {
                    const body = await require('./yelpGreetingService').buildGreeting({
                        name: parsed.name,
                        service: parsed.service,
                        problem: parsed.problem,
                    });
                    const subject = `Re: ${parsed.service || 'your'} request`;
                    const sent = await require('./emailService').sendEmail(companyId, {
                        to: parsed.reply_to,
                        subject,
                        body,
                    });
                    greeted = true;
                    greetingProviderMessageId = (sent && sent.provider_message_id) || null;
                } catch (e) {
                    console.error('[YelpLead] greeting send failed (not retried):', e && e.message);
                }
            }
        }

        // (6) markGreeted — finalize the claim (records lead_id, thread token,
        //     greeting id). Claim is HELD (never released after the lead exists).
        try {
            await yelpLeadQueries.markGreeted(claimId, {
                leadId,
                threadToken: parsed.thread_token,
                greetingProviderMessageId,
                status: greeted ? 'greeted' : 'handled_no_send',
            });
        } catch (e) {
            console.error('[YelpLead] markGreeted failed:', e && e.message);
        }

        // (7) one structured log line.
        console.log(
            '[YelpLead] handled company=%s msg=%s lead=%s greeted=%s',
            companyId, msg.provider_message_id, leadId, greeted
        );

        return { handled: true, skipped: 'yelp_lead', leadId, greeted };
    } catch (e) {
        // Fail-open: an unexpected error must NOT crash ingest; let the normal
        // pipeline continue by reporting not-handled.
        console.error('[YelpLead] unexpected error (fail-open):', e && e.message);
        return { handled: false };
    }
}

module.exports = {
    detectYelpLead,
    parseYelpLead,
    maybeHandleYelpLead,
    DEFAULT_COMPANY_ID,
};
