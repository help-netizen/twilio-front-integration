'use strict';

/**
 * Canonical Yelp sample messages for YELP-LEAD-AUTORESPONDER-001 tests.
 * NOT a *.test.js file → jest does not run it as a suite; the 7 suites require it.
 *
 * Shapes match NormalizedInboundMessage (backend/src/services/mail/MailProvider.js):
 * from_email holds the bare address; the display name lives in from_name.
 */

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// The STABLE Yelp conversation id — embedded in the message body (NOT the varying
// reply+<hex>@messaging.yelp.com relay address). This is the threading key for
// YELP-CONVO-BOOKING-001: the first email carries it as
// `message_to_business_conversation/<id>` and every reply carries it URL-encoded as
// `%2Fthread%2F<id>`. Real Yelp ids are base64url-ish ([A-Za-z0-9_-]+), not hex.
const CONV_ID = '9Xk2mZ7bQ1';

// A real Yelp new-lead body: an intro line, the "<Name> requested a quote … for a
// <service>" header, a labeled free-text problem, a City/ST/ZIP line, and the
// tracking link carrying utm_source=request_a_quote_first_message AND the stable
// conv-id in first-message form (message_to_business_conversation/<CONV_ID>).
const Y_NEW_BODY = [
    'Kim L. sent you a new quote request on Yelp.',
    '',
    'Kim requested a quote from ABC Homes for a dishwasher repair.',
    '',
    'What can we help you with?',
    "My Maytag dishwasher is stuck in mid cycle and won't drain.",
    '',
    'In what area do you need this service?',
    'Newton, MA 02467',
    '',
    'Respond to Kim by replying directly to this email.',
    'View the request: https://www.yelp.com/message_to_business_conversation/9Xk2mZ7bQ1?utm_source=request_a_quote_first_message&utm_medium=email',
].join('\n');

function yNew(overrides = {}) {
    return {
        provider_message_id: 'ymsg-NEW-1',
        provider_thread_id: 'ythr-NEW-1',
        from_email: 'reply+8160b36a1c2d3e4f@messaging.yelp.com',
        from_name: 'Kim L.',
        subject: 'New quote request from Kim',
        body_text: Y_NEW_BODY,
        snippet: 'Kim requested a quote',
        internal_at: '2026-07-10T12:00:00.000Z',
        labelIds: ['INBOX'],
        is_outbound: false,
        ...overrides,
    };
}

// YELP-TIMELINE-DEDUP-001 — a SECOND, DISTINCT conversation id (base64url-ish,
// different from CONV_ID). Proves "a 2nd conversation resolves to a DISTINCT
// timeline" (AC1) independent of the relay hex.
const CONV_ID_2 = '7Yr4nP2wT9';

// A Yelp new-lead message carrying CONV_ID_2 in FIRST-form
// (message_to_business_conversation/<CONV_ID_2>) from YET ANOTHER relay hex — so a
// distinct conversation is keyed on its own conv-id, never the sender.
const Y_NEW_OTHER_BODY = [
    'Dana P. sent you a new quote request on Yelp.',
    '',
    'Dana requested a quote from ABC Homes for a dryer repair.',
    '',
    'What can we help you with?',
    'My dryer stopped heating last night.',
    '',
    'In what area do you need this service?',
    'Quincy, MA 02169',
    '',
    'Respond to Dana by replying directly to this email.',
    'View the request: https://www.yelp.com/message_to_business_conversation/7Yr4nP2wT9?utm_source=request_a_quote_first_message&utm_medium=email',
].join('\n');

function yNewOtherConvo(overrides = {}) {
    return {
        provider_message_id: 'ymsg-NEW-2',
        provider_thread_id: 'ythr-NEW-2',
        from_email: 'reply+1122334455667788@messaging.yelp.com',
        from_name: 'Dana P.',
        subject: 'New quote request from Dana',
        body_text: Y_NEW_OTHER_BODY,
        snippet: 'Dana requested a quote',
        internal_at: '2026-07-10T12:20:00.000Z',
        labelIds: ['INBOX'],
        is_outbound: false,
        ...overrides,
    };
}

// A @messaging.yelp.com relay message whose body carries NO parseable conv-id
// (utm_source=request_a_quote_new_message but no message_to_business_conversation/
// and no %2Fthread%2F). parseConversationId(yNoConvo()) MUST return null → the
// subsuming branch suppresses it ({skipped:'yelp_no_convo'}), zero timeline/contact.
function yNoConvo(overrides = {}) {
    return {
        provider_message_id: 'ymsg-NOCONV-1',
        provider_thread_id: 'ythr-NEW-1',
        from_email: 'reply+9900aabbccddeeff@messaging.yelp.com',
        from_name: 'Kim L.',
        subject: 'Re: New quote request from Kim',
        body_text: Y_REPLY_BODY,
        snippet: 'no conv id in this body',
        internal_at: '2026-07-10T13:30:00.000Z',
        labelIds: ['INBOX'],
        is_outbound: false,
        ...overrides,
    };
}

// A customer follow-up inside an existing thread → NOT a new lead.
const Y_REPLY_BODY = [
    'Kim sent you a message in response to your message.',
    '',
    "Yes, tomorrow afternoon works for me. My number is on file.",
    '',
    'View the conversation: https://www.yelp.com/messaging/abc?utm_source=request_a_quote_new_message',
].join('\n');

function yReply(overrides = {}) {
    return {
        provider_message_id: 'ymsg-REPLY-1',
        provider_thread_id: 'ythr-NEW-1',
        from_email: 'reply+8160b36a1c2d3e4f@messaging.yelp.com',
        from_name: 'Kim L.',
        subject: 'Re: New quote request from Kim',
        body_text: Y_REPLY_BODY,
        snippet: 'Yes, tomorrow afternoon works',
        internal_at: '2026-07-10T13:00:00.000Z',
        labelIds: ['INBOX'],
        is_outbound: false,
        ...overrides,
    };
}

// ── YELP-CONVO-BOOKING-001 fixtures — respondable replies (threading by conv-id) ──
//
// A RESPONDABLE customer reply inside an existing Yelp conversation. Two properties
// are load-bearing for the threading design and are DELIBERATELY set here:
//   (1) the body carries the conv-id in URL-ENCODED reply form: `%2Fthread%2F<CONV_ID>`
//       (the same stable id as yNew's first-message form) — this is the thread key;
//   (2) the utm is `request_a_quote_new_message_respondable` (a customer reply, NOT a
//       first message), so detectYelpReply matches and detectYelpLead does NOT;
//   (3) from_email uses a DIFFERENT reply+<hex>@ than yNew (and than yReply2) — the
//       whole point: the per-message-varying relay address must NOT be the thread key.
const Y_REPLY_RESPONDABLE_BODY = [
    'Kim sent you a message in response to your quote request.',
    '',
    'Yes, tomorrow afternoon works for me. You can reach me at 617-555-0148.',
    '',
    'Respond to Kim by replying directly to this email.',
    'View the conversation: https://www.yelp.com/mail/click?url=https%3A%2F%2Fwww.yelp.com%2Fmessaging%2Fthread%2F9Xk2mZ7bQ1&utm_source=request_a_quote_new_message_respondable&utm_medium=email',
].join('\n');

function yReplyRespondable(overrides = {}) {
    return {
        provider_message_id: 'ymsg-REPLY-1',
        provider_thread_id: 'ythr-NEW-1',
        from_email: 'reply+aa11bb22cc33dd44@messaging.yelp.com',
        from_name: 'Kim L.',
        subject: 'Re: New quote request from Kim',
        body_text: Y_REPLY_RESPONDABLE_BODY,
        snippet: 'Yes, tomorrow afternoon works',
        internal_at: '2026-07-10T13:00:00.000Z',
        labelIds: ['INBOX'],
        is_outbound: false,
        ...overrides,
    };
}

// A SECOND respondable reply on the SAME conversation (same %2Fthread%2F<CONV_ID>)
// with YET ANOTHER reply+<hex>@ — drives YCB-CID-03 / YCB-IDEM-05: three different
// relay hexes (yNew 8160…, yReplyRespondable aa11…, this ee55…) all resolve to ONE
// conversation because the parser reads only the body conv-id.
function yReply2(overrides = {}) {
    return {
        provider_message_id: 'ymsg-REPLY-2',
        provider_thread_id: 'ythr-NEW-1',
        from_email: 'reply+ee55ff66aa77bb88@messaging.yelp.com',
        from_name: 'Kim L.',
        subject: 'Re: New quote request from Kim',
        body_text: Y_REPLY_RESPONDABLE_BODY,
        snippet: 'Following up',
        internal_at: '2026-07-10T14:00:00.000Z',
        labelIds: ['INBOX'],
        is_outbound: false,
        ...overrides,
    };
}

// Yelp's own confirmation to the business → NOT (wrong sender domain). It echoes
// the request text (as real Yelp confirmations do), so the ONLY thing keeping it
// out of detection is the notify.yelp.com sender domain — which makes the domain
// gate genuinely load-bearing under sabotage YLA-N-01.
function yConfirm(overrides = {}) {
    return {
        provider_message_id: 'ymsg-CONFIRM-1',
        provider_thread_id: 'ythr-CONFIRM-1',
        from_email: 'no-reply@notify.yelp.com',
        from_name: 'Yelp',
        subject: 'Good news! Your request was sent.',
        body_text: [
            'Good news! Your request was sent.',
            'Kim requested a quote from ABC Homes for a dishwasher repair.',
            "We'll let you know when the business responds to your request.",
        ].join('\n'),
        snippet: 'Good news!',
        internal_at: '2026-07-10T12:05:00.000Z',
        labelIds: ['INBOX'],
        is_outbound: false,
        ...overrides,
    };
}

// A wholly unrelated inbound email → NOT.
function nonYelp(overrides = {}) {
    return {
        provider_message_id: 'gmsg-NONYELP-1',
        provider_thread_id: 'gthr-1',
        from_email: 'jane@gmail.com',
        from_name: 'Jane Doe',
        subject: 'Question about my invoice',
        body_text: 'Hi, can you resend my last invoice? Thanks, Jane',
        snippet: 'Question about my invoice',
        internal_at: '2026-07-10T12:10:00.000Z',
        labelIds: ['INBOX'],
        is_outbound: false,
        ...overrides,
    };
}

// ── YELP-LEAD-AUTORESPONDER-002 fixtures (durable task+agent refactor) ────────

/**
 * A claimed kind='agent' task row as the worker sees it after the claim UPDATE …
 * RETURNING *. Defaults model a NON-opted task (max_attempts=1) so the retry
 * regression guard (A-01) is the zero-config case. Override agent_type / attempt_count
 * / max_attempts / agent_input per case.
 */
function taskRow(overrides = {}) {
    return {
        id: 1,
        company_id: DEFAULT_COMPANY_ID,
        kind: 'agent',
        agent_type: 'yelp_lead',
        agent_status: 'running',
        status: 'open',
        attempt_count: 0,
        max_attempts: 1,
        next_attempt_at: null,
        agent_input: {},
        lead_id: 55,
        created_at: '2026-07-10T12:00:00.000Z',
        ...overrides,
    };
}

/**
 * The agent_input JSON a real detector enqueue writes (spec §2 contract). Keys are
 * customer_name / service_type / problem_text (the handler maps them to buildGreeting's
 * name / service / problem).
 */
function yelpInput(overrides = {}) {
    return {
        claim_id: 7,
        provider_message_id: 'ymsg-NEW-1',
        lead_id: 55,
        reply_to: 'reply+8160b36a1c2d3e4f@messaging.yelp.com',
        thread_token: '8160b36a1c2d3e4f',
        customer_name: 'Kim',
        service_type: 'dishwasher repair',
        problem_text: "My Maytag dishwasher is stuck in mid cycle and won't drain.",
        zip: '02467',
        ...overrides,
    };
}

/**
 * A `yelp_conversations` row as the intercept / handler sees it (YELP-CONVO-BOOKING-001,
 * mig 164). Defaults model a mid-conversation OPEN row for CONV_ID with lead 55, its
 * last_reply_to pointing at yReplyRespondable's hex. Override per case.
 */
function convRow(overrides = {}) {
    return {
        id: 1,
        company_id: DEFAULT_COMPANY_ID,
        conversation_id: CONV_ID,
        lead_id: 55,
        lead_uuid: 'lead-uuid-0001',
        phase: 'collect',
        status: 'open',
        collected: {},
        offered_slots: null,
        chosen_slot: null,
        last_reply_to: 'reply+aa11bb22cc33dd44@messaging.yelp.com',
        last_thread_token: 'aa11bb22cc33dd44',
        turn_count: 1,
        last_inbound_message_id: 'ymsg-REPLY-1',
        ...overrides,
    };
}

/**
 * A claimed `yelp_convo` turn task as the worker hands it to the handler. Mirrors the
 * RAW enqueue in yelpLeadService.maybeHandleYelpReply (agent_type='yelp_convo',
 * max_attempts=3, subject_type='lead'). Override agent_input per case.
 */
function convTask(overrides = {}) {
    const { agent_input: inputOverrides, ...rest } = overrides;
    return taskRow({
        agent_type: 'yelp_convo',
        max_attempts: 3,
        lead_id: 55,
        agent_input: {
            conversation_id: CONV_ID,
            inbound_provider_message_id: 'ymsg-REPLY-1',
            inbound_body_text: Y_REPLY_RESPONDABLE_BODY,
            reply_to: 'reply+aa11bb22cc33dd44@messaging.yelp.com',
            thread_token: 'aa11bb22cc33dd44',
            lead_id: 55,
            lead_uuid: 'lead-uuid-0001',
            ...(inputOverrides || {}),
        },
        ...rest,
    });
}

module.exports = {
    DEFAULT_COMPANY_ID,
    CONV_ID,
    CONV_ID_2,
    Y_NEW_BODY,
    Y_NEW_OTHER_BODY,
    Y_REPLY_BODY,
    Y_REPLY_RESPONDABLE_BODY,
    yNew,
    yNewOtherConvo,
    yNoConvo,
    yReply,
    yReplyRespondable,
    yReply2,
    yConfirm,
    nonYelp,
    taskRow,
    yelpInput,
    convRow,
    convTask,
};
