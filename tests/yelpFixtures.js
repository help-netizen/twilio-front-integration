'use strict';

/**
 * Canonical Yelp sample messages for YELP-LEAD-AUTORESPONDER-001 tests.
 * NOT a *.test.js file → jest does not run it as a suite; the 7 suites require it.
 *
 * Shapes match NormalizedInboundMessage (backend/src/services/mail/MailProvider.js):
 * from_email holds the bare address; the display name lives in from_name.
 */

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// A real Yelp new-lead body: an intro line, the "<Name> requested a quote … for a
// <service>" header, a labeled free-text problem, a City/ST/ZIP line, and the
// tracking link carrying utm_source=request_a_quote_first_message.
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
    'View the request: https://www.yelp.com/biz_share/abc?utm_source=request_a_quote_first_message&utm_medium=email',
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

module.exports = {
    DEFAULT_COMPANY_ID,
    Y_NEW_BODY,
    Y_REPLY_BODY,
    yNew,
    yReply,
    yConfirm,
    nonYelp,
    taskRow,
    yelpInput,
};
