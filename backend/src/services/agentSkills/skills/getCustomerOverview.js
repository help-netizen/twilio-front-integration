/**
 * agentSkills / skills / getCustomerOverview
 * (AGENT-SKILLS-001, spec §4.2 / architecture §6 · task T5 — FR-S2 / FR-C2)
 *
 * READ · requiredLevel L1 (the gate lets a phone-matched caller in; an L0 caller
 * gets the soft `needsVerification` shape from the choke-point, never disclosure).
 *
 * PURPOSE: a one-line snapshot to ROUTE the conversation. Low-sensitivity only:
 *   { ok, openJobsCount, nextAppointment|null, lastJobStatus(phrase)|null,
 *     hasOpenEstimate, hasUnpaidInvoice, speak }
 *
 * HARD PRIVACY (spec §2.5, §4.2): NO amounts, NO addresses. `hasOpenEstimate` /
 * `hasUnpaidInvoice` are EXISTENCE booleans (not counts, not totals). `lastJobStatus`
 * is a mapped phrase via statusMap — NEVER a raw `blanc_status` code.
 *
 * WINDOW DERIVATION (the load-bearing code-vs-architecture note, spec §4.2):
 *   `scheduleService.getScheduleItems` does NOT filter by contactId, so the next
 *   appointment window is derived from `jobsService.listJobs({ contactId })` — jobs
 *   carry `start_date` / `end_date`. We do NOT pass `{contactId}` into
 *   getScheduleItems expecting a filter.
 *
 * ISOLATION: every query is scoped to `companyId` AND the server-verified
 * `contactId` (from `verifiedContext`, never from `input`).
 */

'use strict';

const jobsService = require('../../jobsService');
const estimatesService = require('../../estimatesService');
const invoicesService = require('../../invoicesService');
const { statusMap } = require('../statusMap');
const resultShapes = require('../resultShapes');

// Timezone for all spoken date/time framing (project convention: America/New_York).
const TZ = 'America/New_York';

// Estimate statuses that count as NO-LONGER-OPEN (an "open" estimate is anything
// still actionable: draft / sent / approved). Kept as an exclusion set so a new
// estimate status can't silently flip an estimate to "closed".
const CLOSED_ESTIMATE_STATUSES = new Set(['declined', 'void', 'voided', 'expired', 'converted', 'archived']);

// Invoice statuses that are NOT owed money (so never "unpaid"), independent of the
// balance signal below.
const NON_OWED_INVOICE_STATUSES = new Set(['void', 'voided', 'refunded', 'paid']);

/**
 * Format a job's `start_date`/`end_date` (ISO strings, from rowToJob) into a
 * speech-safe window RANGE, never an exact minute (spec §4.4 guardrail is reused
 * here for consistency). Returns null when there's no usable start.
 * @param {string|null} startIso
 * @param {string|null} endIso
 * @returns {string|null} e.g. "Tuesday between 10 AM and 12 PM" or "Tuesday around 10 AM".
 */
function formatWindow(startIso, endIso) {
    if (!startIso) return null;
    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) return null;

    const day = start.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' });
    const startTime = start.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

    const end = endIso ? new Date(endIso) : null;
    if (end && !Number.isNaN(end.getTime()) && end.getTime() > start.getTime()) {
        const endTime = end.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
        return `${day} between ${startTime} and ${endTime}`;
    }
    return `${day} around ${startTime}`;
}

/**
 * Pick the "next appointment" from a set of open jobs: the earliest FUTURE
 * start_date; if none are in the future, the soonest by start_date. Jobs without a
 * start_date are ignored (nothing scheduled).
 * @param {object[]} jobs Jobs from listJobs (rowToJob shape).
 * @returns {object|null} the chosen job, or null.
 */
function pickNextAppointmentJob(jobs) {
    const withStart = jobs.filter((j) => j && j.start_date);
    if (withStart.length === 0) return null;
    const now = Date.now();
    const future = withStart
        .filter((j) => new Date(j.start_date).getTime() >= now)
        .sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
    if (future.length > 0) return future[0];
    // No future window — return the soonest upcoming/most-recent scheduled job.
    return withStart.sort((a, b) => new Date(a.start_date) - new Date(b.start_date))[0];
}

/**
 * Pick the "last job status" job: the most recently updated/created open job (the
 * one the caller most likely means). Falls back to the first job.
 * @param {object[]} jobs
 * @returns {object|null}
 */
function pickLastStatusJob(jobs) {
    if (!Array.isArray(jobs) || jobs.length === 0) return null;
    const sorted = [...jobs].sort((a, b) => {
        const ax = new Date(a.updated_at || a.created_at || 0).getTime();
        const bx = new Date(b.updated_at || b.created_at || 0).getTime();
        return bx - ax;
    });
    return sorted[0];
}

/**
 * Existence check: does the contact have an OPEN estimate (company-scoped)?
 * Reduced to a boolean — no amounts, no line items surfaced at L1. Defensive: any
 * error → false (degrade gracefully, never leak).
 * @param {string} companyId
 * @param {number} contactId
 * @returns {Promise<boolean>}
 */
async function hasOpenEstimate(companyId, contactId) {
    try {
        const { rows } = await estimatesService.listEstimates(companyId, { contactId, limit: 50 });
        if (!Array.isArray(rows)) return false;
        return rows.some((e) => !CLOSED_ESTIMATE_STATUSES.has(String(e.status || '').toLowerCase()));
    } catch (_e) {
        return false;
    }
}

/**
 * Existence check: does the contact have an UNPAID invoice (company-scoped)?
 * "Unpaid" = a positive balance_due AND a status that isn't already settled/void.
 * Reduced to a boolean — no totals surfaced at L1. Defensive: any error → false.
 * @param {string} companyId
 * @param {number} contactId
 * @returns {Promise<boolean>}
 */
async function hasUnpaidInvoice(companyId, contactId) {
    try {
        const { rows } = await invoicesService.listInvoices(companyId, { contactId, limit: 50 });
        if (!Array.isArray(rows)) return false;
        return rows.some((inv) => {
            const status = String(inv.status || '').toLowerCase();
            if (NON_OWED_INVOICE_STATUSES.has(status)) return false;
            const balance = Number(inv.balance_due);
            return Number.isFinite(balance) && balance > 0;
        });
    } catch (_e) {
        return false;
    }
}

/**
 * Build the one-line customer snapshot. Follows the skill `run` contract.
 *
 * @param {string} companyId Tenant scope.
 * @param {{ contactId: number|null, customerName: string|null }} verifiedContext Server-verified identity (contactId is authoritative).
 * @param {object} input Per-call payload (identity block; `contactId` here is only a claim and is NOT trusted for scoping).
 * @returns {Promise<{ ok: boolean, openJobsCount: number, nextAppointment: { jobId: string, window: string }|null, lastJobStatus: string|null, hasOpenEstimate: boolean, hasUnpaidInvoice: boolean, speak: string }>}
 */
async function run(companyId, verifiedContext, input) {
    // Scope to the SERVER-verified contact — never `input.contactId` (a claim).
    const contactId = verifiedContext && verifiedContext.contactId != null ? verifiedContext.contactId : null;
    if (!companyId || contactId == null) {
        // Should not happen (the gate guarantees L1 = a resolved contact), but be
        // defensive: return a safe empty snapshot rather than leaking or throwing.
        return resultShapes.ok("I don't see anything on file yet — I'd be happy to help you get something booked.", {
            openJobsCount: 0,
            nextAppointment: null,
            lastJobStatus: null,
            hasOpenEstimate: false,
            hasUnpaidInvoice: false,
        });
    }

    // Open jobs for this contact, company-scoped.
    const jobsResult = await jobsService.listJobs({ contactId, onlyOpen: true, companyId, limit: 100 });
    const jobs = jobsResult && Array.isArray(jobsResult.results) ? jobsResult.results : [];
    const openJobsCount = jobs.length;

    // Next appointment window derived from jobs' start_date/end_date (NOT schedule-by-contact).
    const nextJob = pickNextAppointmentJob(jobs);
    const nextWindow = nextJob ? formatWindow(nextJob.start_date, nextJob.end_date) : null;
    const nextAppointment = nextJob && nextWindow ? { jobId: String(nextJob.id), window: nextWindow } : null;

    // Last job status → mapped phrase (never a raw code).
    const lastJob = pickLastStatusJob(jobs);
    const lastJobStatus = lastJob ? statusMap(lastJob.blanc_status).phrase : null;

    // Existence booleans (no amounts). Run in parallel; each fails closed to false.
    const [openEstimate, unpaidInvoice] = await Promise.all([
        hasOpenEstimate(companyId, contactId),
        hasUnpaidInvoice(companyId, contactId),
    ]);

    // Compose a speech-safe summary. Multiple open jobs → ask which to scope (E2).
    let speak;
    if (openJobsCount === 0) {
        speak = "I don't see any open jobs on your account right now — is there something new I can help you book?";
    } else if (openJobsCount > 1) {
        speak = `You have ${openJobsCount} jobs in progress. Which one would you like to look at — do you know the appliance or service?`;
    } else {
        const parts = ['I found your account.'];
        if (nextAppointment) parts.push(`Your next appointment is ${nextAppointment.window}.`);
        else if (lastJobStatus) parts.push(lastJobStatus);
        speak = parts.join(' ');
    }

    return resultShapes.ok(speak, {
        openJobsCount,
        nextAppointment,
        lastJobStatus,
        hasOpenEstimate: openEstimate,
        hasUnpaidInvoice: unpaidInvoice,
    });
}

module.exports = { run };
