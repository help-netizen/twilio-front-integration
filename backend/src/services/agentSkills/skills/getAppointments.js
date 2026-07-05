/**
 * agentSkills / skills / getAppointments
 * (AGENT-SKILLS-001, spec §4.4 / architecture §6 · task T5 — FR-S4 / FR-C8)
 *
 * READ · requiredLevel L1. Answers "when is my appointment / do I have anything
 * scheduled?"
 *
 * OUTPUT (speech-safe, provider-neutral):
 *   { ok, appointments: [ { jobId, serviceName, date, window, statusLabel(phrase) } ], speak }
 *
 * WINDOW DERIVATION (the load-bearing note, spec §4.4 / §4.2-note):
 *   Appointments come from `jobsService.listJobs({ contactId, companyId })` — jobs
 *   carry `start_date` / `end_date`. `scheduleService.getScheduleItems` does NOT
 *   accept a `contactId` filter, so it CANNOT be the contact-scoped source; the
 *   jobs (which each carry their own window) are. A job is an "appointment" only
 *   when it has a `start_date` (a scheduled visit).
 *
 * GUARDRAILS:
 *   - The window is stated as a RANGE ("between 10 AM and 12 PM") — never an exact
 *     minute (spec §4.4).
 *   - `statusLabel` is a mapped phrase (statusMap), never a raw code.
 *   - Empty → `appointments: []` + `speak` says nothing is scheduled and offers to
 *     book (E7). Never an error.
 *
 * ISOLATION: scoped to `companyId` AND the server-verified `contactId`.
 */

'use strict';

const jobsService = require('../../jobsService');
const { statusMap } = require('../statusMap');
const resultShapes = require('../resultShapes');

const TZ = 'America/New_York';

/**
 * A short spoken date for an appointment (e.g. "Tuesday, July 8"). Null when the
 * start is unusable.
 * @param {string|null} startIso
 * @returns {string|null}
 */
function formatDate(startIso) {
    if (!startIso) return null;
    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) return null;
    return start.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' });
}

/**
 * A speech-safe time window RANGE (never an exact minute). Null when the start is
 * unusable.
 * @param {string|null} startIso
 * @param {string|null} endIso
 * @returns {string|null}
 */
function formatWindow(startIso, endIso) {
    if (!startIso) return null;
    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) return null;
    const startTime = start.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    const end = endIso ? new Date(endIso) : null;
    if (end && !Number.isNaN(end.getTime()) && end.getTime() > start.getTime()) {
        const endTime = end.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
        return `between ${startTime} and ${endTime}`;
    }
    return `around ${startTime}`;
}

/**
 * List the caller's scheduled appointments. Follows the skill `run` contract.
 *
 * @param {string} companyId Tenant scope.
 * @param {{ contactId: number|null }} verifiedContext Server-verified identity (contactId is authoritative).
 * @param {object} _input Per-call payload (identity block; not used for scoping).
 * @returns {Promise<{ ok: true, appointments: { jobId: string, serviceName: string, date: string, window: string, statusLabel: string }[], speak: string }>}
 */
async function run(companyId, verifiedContext, _input) {
    const contactId = verifiedContext && verifiedContext.contactId != null ? verifiedContext.contactId : null;
    if (!companyId || contactId == null) {
        return resultShapes.ok("I don't see anything scheduled — I'd be happy to help you book a visit.", {
            appointments: [],
        });
    }

    // All jobs for this contact, company-scoped. We keep only the ones that carry a
    // scheduled window (a start_date) — those are the actual appointments — and
    // exclude terminal Canceled jobs (a canceled visit isn't an appointment).
    const jobsResult = await jobsService.listJobs({ contactId, companyId, limit: 100 });
    const jobs = jobsResult && Array.isArray(jobsResult.results) ? jobsResult.results : [];

    const appointments = jobs
        .filter((j) => j && j.start_date && j.blanc_status !== 'Canceled')
        .map((j) => {
            const date = formatDate(j.start_date);
            const window = formatWindow(j.start_date, j.end_date);
            return {
                jobId: String(j.id),
                serviceName: j.service_name || 'your service',
                date: date || '',
                window: window || '',
                statusLabel: statusMap(j.blanc_status).phrase,
                _start: new Date(j.start_date).getTime(),
            };
        })
        // Soonest first.
        .sort((a, b) => a._start - b._start)
        // Drop the internal sort key from the emitted shape.
        .map(({ _start, ...appt }) => appt);

    let speak;
    if (appointments.length === 0) {
        speak = "I don't see anything scheduled on your account — would you like to book a visit?";
    } else if (appointments.length === 1) {
        const a = appointments[0];
        speak = `You have one appointment: ${a.serviceName} on ${a.date} ${a.window}.`.replace(/\s+/g, ' ').trim();
    } else {
        const next = appointments[0];
        speak = `You have ${appointments.length} appointments scheduled. The next is ${next.serviceName} on ${next.date} ${next.window}.`
            .replace(/\s+/g, ' ')
            .trim();
    }

    return resultShapes.ok(speak, { appointments });
}

module.exports = { run };
