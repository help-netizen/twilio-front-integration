/**
 * agentSkills / statusMap
 *
 * The SINGLE place a raw job status becomes a caller-friendly phrase
 * (AGENT-SKILLS-001, spec §4.10 / architecture §6.1). A skill NEVER emits a raw
 * `blanc_status` code — it maps here.
 *
 * Reconciled to the REAL FSM: `jobsService.BLANC_STATUSES`
 *   ['Submitted','Waiting for parts','Follow Up with Client','Visit completed',
 *    'Job is Done','Rescheduled','Canceled','On the way']
 *
 * There is NO `Scheduled` label — a booked-but-not-started job is `Submitted`
 * WITH a schedule window, so "you're scheduled" is driven by the presence of a
 * schedule window (see PHRASES.Submitted.nextAction = 'offer_reschedule_if_window'),
 * not by a status label. The roadmap's illustrative
 * `Scheduled`/`Review`/`Enroute`/`In Progress` set is deliberately NOT encoded.
 *
 * We import BLANC_STATUSES from jobsService so this map can't silently drift from
 * the FSM; a dev-time check asserts every real status has a phrase.
 */

'use strict';

const { BLANC_STATUSES } = require('../jobsService');

/**
 * Neutral, code-free phrase for an unknown / unmapped status. Never leaks the
 * raw value (spec §4.10: "unmapped/unknown status → a neutral safe phrase + no
 * code leak").
 * @type {string}
 */
const UNKNOWN_PHRASE = 'Let me check the latest on that for you.';

/**
 * blanc_status → { phrase, nextAction } (spec §4.10 CORRECTED table).
 * `phrase` is the speech-safe line the agent may say. `nextAction` is an
 * internal hint key (NOT spoken) the skill uses to decide the follow-up.
 * @type {Object<string, { phrase: string, nextAction: string }>}
 */
const PHRASES = {
    Submitted: {
        phrase: "We've got your request and are getting it scheduled.",
        // booked-not-started == Submitted + a schedule window → offer reschedule
        nextAction: 'offer_reschedule_if_window',
    },
    'Waiting for parts': {
        phrase: "We're waiting on a part to finish the repair.",
        nextAction: 'set_expectation',
    },
    'Follow Up with Client': {
        phrase: 'Our team needs to follow up with you to move forward.',
        nextAction: 'capture_callback',
    },
    'Visit completed': {
        phrase: 'The technician has completed the visit.',
        nextAction: 'offer_review_or_new_job',
    },
    'Job is Done': {
        phrase: 'The job is complete.',
        nextAction: 'offer_review_or_new_job',
    },
    Rescheduled: {
        phrase: 'Your appointment has been rescheduled.',
        nextAction: 'confirm_new_window',
    },
    'On the way': {
        phrase: 'Your technician is on the way.',
        // ETA is framed as a text; never the tech's name/number
        nextAction: 'give_eta_text',
    },
    Canceled: {
        phrase: 'That appointment is canceled.',
        nextAction: 'offer_rebook',
    },
};

/**
 * Zenbooker substatus (`zb_status`) → phrase. Optional overlay used when a job
 * carries a live ZB substatus more specific than the parent blanc_status
 * (spec §4.10 last row). Keyed by normalized (lowercased) value.
 * @type {Object<string, { phrase: string, nextAction: string }>}
 */
const ZB_SUBSTATUS_PHRASES = {
    'en-route': {
        phrase: 'Your technician is on the way.',
        nextAction: 'give_eta_text',
    },
    'in-progress': {
        phrase: 'The technician is working on it now.',
        nextAction: 'set_expectation',
    },
};

/**
 * Map a raw `blanc_status` to a caller-friendly `{ phrase, nextAction }`.
 * Unknown / null / non-string → the neutral UNKNOWN_PHRASE with no code leak.
 * @param {string} blancStatus The raw job status (never spoken directly).
 * @returns {{ phrase: string, nextAction: string|null }}
 */
function statusMap(blancStatus) {
    if (typeof blancStatus === 'string' && Object.prototype.hasOwnProperty.call(PHRASES, blancStatus)) {
        const entry = PHRASES[blancStatus];
        return { phrase: entry.phrase, nextAction: entry.nextAction };
    }
    return { phrase: UNKNOWN_PHRASE, nextAction: null };
}

/**
 * Map a Zenbooker substatus (`zb_status`) to a phrase overlay, or null when the
 * substatus is unknown / absent (caller should then fall back to statusMap on
 * the parent blanc_status).
 * @param {string} zbStatus The raw ZB substatus.
 * @returns {{ phrase: string, nextAction: string|null }|null}
 */
function zbSubstatusMap(zbStatus) {
    if (typeof zbStatus !== 'string') return null;
    const key = zbStatus.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ZB_SUBSTATUS_PHRASES, key)) {
        const entry = ZB_SUBSTATUS_PHRASES[key];
        return { phrase: entry.phrase, nextAction: entry.nextAction };
    }
    return null;
}

// --- Dev-time drift guard --------------------------------------------------
// If the real FSM adds a status we don't map, surface it early (warn, don't
// crash — statusMap already returns a safe phrase for the unmapped value).
if (Array.isArray(BLANC_STATUSES)) {
    const unmapped = BLANC_STATUSES.filter(
        (s) => !Object.prototype.hasOwnProperty.call(PHRASES, s),
    );
    if (unmapped.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
            `[agentSkills/statusMap] BLANC_STATUSES has unmapped status(es): ${unmapped.join(', ')}`,
        );
    }
}

module.exports = {
    statusMap,
    zbSubstatusMap,
    UNKNOWN_PHRASE,
    // exported for tests / MCP projection; not for direct spoken use
    PHRASES,
    ZB_SUBSTATUS_PHRASES,
};
