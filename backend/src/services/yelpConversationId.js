/**
 * yelpConversationId — YELP-CONVO-BOOKING-001 (Phase A, T-YCB-A2).
 *
 * Pure, dependency-free parser for the STABLE Yelp conversation id embedded in the
 * message BODY. This id — not the per-message-varying reply+<hex>@messaging.yelp.com
 * relay address — is the durable threading key (yelp_conversations.conversation_id).
 *
 * Two body forms carry the same id:
 *   • first email  → `.../message_to_business_conversation/<id>?...`
 *   • every reply  → a tracking URL with the path URL-encoded: `...%2Fthread%2F<id>...`
 *
 * Contract: FAIL-SAFE. Any missing / malformed / adversarial body → `null` (never a
 * partial or garbage key that could cross-thread two real conversations), and the
 * function NEVER throws. It reads ONLY from the body (never from from_email / the
 * reply+<hex> relay), so a rotated reply address cannot fork a conversation.
 *
 * NOTE: real Yelp ids are base64url-ish `[A-Za-z0-9_-]+` (NOT hex).
 */
'use strict';

// A plausible conv-id: base64url alphabet, bounded length so an over-long junk run
// after a valid prefix is rejected (returns null) rather than captured as a key.
const ID_MIN_LEN = 3;
const ID_MAX_LEN = 64;

// First-message form: literal "/message_to_business_conversation/<id>".
const FIRST_FORM_RE = /message_to_business_conversation\/([A-Za-z0-9_-]+)/;
// Reply form: URL-encoded "%2Fthread%2F<id>" (i.e. an encoded ".../thread/<id>").
const REPLY_FORM_RE = /%2Fthread%2F([A-Za-z0-9_-]+)/i;

/**
 * Read the message body (and only body-adjacent text — subject/snippet — NEVER
 * from_email) as a single haystack.
 * @param {object} msg
 * @returns {string}
 */
function bodyHaystack(msg) {
    if (!msg || typeof msg !== 'object') return '';
    // body_text is authoritative; subject/snippet are harmless extra coverage for
    // clients that carry the tracking link there. from_email is intentionally NOT read.
    const parts = [];
    for (const k of ['body_text', 'subject', 'snippet']) {
        const v = msg[k];
        if (typeof v === 'string' && v) parts.push(v);
    }
    return parts.join('\n');
}

function boundedId(match) {
    if (!match || !match[1]) return null;
    const id = match[1];
    if (id.length < ID_MIN_LEN || id.length > ID_MAX_LEN) return null;
    return id;
}

/**
 * Parse the stable Yelp conversation id from a normalized inbound message.
 * @param {object} msg  NormalizedInboundMessage (uses body_text; NOT from_email)
 * @returns {string|null} the conv-id, or null if none / malformed.
 */
function parseConversationId(msg) {
    try {
        const hay = bodyHaystack(msg);
        if (!hay) return null;

        // First-message form wins if present (verbatim path segment, query stripped
        // by the [A-Za-z0-9_-] boundary — a '?' / '/' ends the capture).
        const first = boundedId(hay.match(FIRST_FORM_RE));
        if (first) return first;

        // Reply form (URL-encoded). '%' after the id (e.g. an encoded '?') ends the
        // capture, as does '&' or whitespace.
        const reply = boundedId(hay.match(REPLY_FORM_RE));
        if (reply) return reply;

        return null;
    } catch (e) {
        // Fail-safe: a routing signal, never a crash.
        console.error('[YelpConvId] parseConversationId failed (returning null):', e && e.message);
        return null;
    }
}

/**
 * Best-effort parse of a Yelp lead id, when the body carries the parallel
 * `message_to_business_lead/<id>` form. Same fail-safe contract → null when absent
 * or malformed; reads only the body. Optional/advisory (no Phase-A routing depends
 * on it); provided because it is cheap and mirrors parseConversationId.
 * @param {object} msg
 * @returns {string|null}
 */
function parseLeadId(msg) {
    try {
        const hay = bodyHaystack(msg);
        if (!hay) return null;
        return boundedId(hay.match(/message_to_business_lead\/([A-Za-z0-9_-]+)/));
    } catch (e) {
        console.error('[YelpConvId] parseLeadId failed (returning null):', e && e.message);
        return null;
    }
}

module.exports = { parseConversationId, parseLeadId };
