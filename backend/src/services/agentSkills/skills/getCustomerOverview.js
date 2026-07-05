/**
 * agentSkills / skills / getCustomerOverview
 * (AGENT-SKILLS-001, spec §4.2 / architecture §6 · task T5 — FR-S2 / FR-C2)
 *
 * READ · requiredLevel L1 (the gate lets a phone-matched caller in; an L0 caller
 * gets the soft `needsVerification` shape from the choke-point, never disclosure).
 *
 * PURPOSE: a one-line snapshot to ROUTE the conversation. Low-sensitivity only:
 *   { ok, openJobsCount, nextAppointment|null, lastJobStatus(phrase)|null,
 *     hasOpenEstimate, hasUnpaidInvoice,
 *     hasOpenLead, openLeadStatus(phrase)|null, leadProposedWindow|null, openLeadCount,
 *     speak }
 *
 * HARD PRIVACY (spec §2.5, §4.2): NO amounts, NO addresses. `hasOpenEstimate` /
 * `hasUnpaidInvoice` are EXISTENCE booleans (not counts, not totals). `lastJobStatus`
 * is a mapped phrase via statusMap — NEVER a raw `blanc_status` code.
 *
 * LEAD AWARENESS (AGENT-SKILLS-002 §3.2): an existing customer whose ONLY record is a
 * pending lead (a submitted request, or a MAIL-AGENT / insurance-email lead with no job
 * yet) must be recognized with real state instead of `openJobsCount:0` → "no jobs". We
 * read the contact's OPEN leads via `leadsService.getOpenLeadsByContact` — the
 * NON-SUPPRESSING, company-scoped read (T3) — so the lead surfaces even when a job also
 * exists (the plain `getLeadByContact` hides it in that case). Only the lead's STATUS
 * PHRASE and a proposed-slot WINDOW RANGE are surfaced; never the lead amount or address.
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
const leadsService = require('../../leadsService');
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

// Lead statuses that read as brand-new / not-yet-actioned. Kept as an inclusion set
// (mirrors CLOSED_ESTIMATE_STATUSES' small-object style — NOT a new module) so the
// "we have your request in" phrasing is driven off the shipped pre-contact tokens.
// There is NO statusMap for lead statuses (statusMap is job blanc_status only), so
// this is the lead-side equivalent. Terminal tokens (Lost/Converted) never reach here
// — the getOpenLeadsByContact read already excludes them (AGENT-SKILLS-002 §3.2.1).
const NEW_LEAD_STATUSES = new Set(['submitted', 'new', 'review']);

/**
 * Caller-friendly phrase for an OPEN lead (AGENT-SKILLS-002 §3.2.1). NEVER reads the
 * raw `Status` token aloud. When the lead carries a proposed slot window, the "penciled
 * in" phrasing wins (it is more informative than a bare status). Otherwise a pre-contact
 * status → "we have your request in"; any other non-terminal status → "in progress".
 * @param {string|null} status The lead's raw `Status` (never spoken directly).
 * @param {string|null} proposedWindow A speech-safe window range, or null.
 * @returns {string} A speech-safe phrase (always non-empty for an open lead).
 */
function leadStatusPhrase(status, proposedWindow) {
    if (proposedWindow) return `you're penciled in for ${proposedWindow}`;
    const token = String(status || '').trim().toLowerCase();
    if (NEW_LEAD_STATUSES.has(token)) return 'we have your request in';
    return 'your request is in progress';
}

/**
 * Read the contact's OPEN leads (company-scoped, non-suppressing) for surfacing.
 * Defensive: any failure → [] (degrade to "no open lead", never throw/leak). Keeps the
 * overview at L1 even if the leads read faults (spec §3.2 isolation + graceful-degrade).
 * @param {number} contactId Server-verified contact.
 * @param {string} companyId Tenant scope.
 * @returns {Promise<object[]>} rowToLead shapes, newest open first, or [].
 */
async function readOpenLeads(contactId, companyId) {
    try {
        const leads = await leadsService.getOpenLeadsByContact(contactId, companyId);
        return Array.isArray(leads) ? leads : [];
    } catch (_e) {
        return [];
    }
}

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
 * @returns {Promise<{ ok: boolean, openJobsCount: number, nextAppointment: { jobId: string, window: string }|null, lastJobStatus: string|null, hasOpenEstimate: boolean, hasUnpaidInvoice: boolean, hasOpenLead: boolean, openLeadStatus: string|null, leadProposedWindow: string|null, openLeadCount: number, speak: string }>}
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
            hasOpenLead: false,
            openLeadStatus: null,
            leadProposedWindow: null,
            openLeadCount: 0,
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

    // Existence booleans (no amounts) + the contact's open leads (non-suppressing).
    // Run in parallel; each fails closed (booleans → false, leads → []).
    const [openEstimate, unpaidInvoice, openLeads] = await Promise.all([
        hasOpenEstimate(companyId, contactId),
        hasUnpaidInvoice(companyId, contactId),
        readOpenLeads(contactId, companyId),
    ]);

    // Lead surfacing — the newest open lead is "the" lead (read is ordered
    // lead_date_time DESC NULLS LAST, id DESC). Only a status phrase + a window RANGE
    // are surfaced; never the lead's amount or address (spec §3.2, still L1).
    const openLeadCount = openLeads.length;
    const hasOpenLead = openLeadCount > 0;
    const topLead = hasOpenLead ? openLeads[0] : null;
    const leadProposedWindow = topLead ? formatWindow(topLead.LeadDateTime, topLead.LeadEndDateTime) : null;
    const openLeadStatus = topLead ? leadStatusPhrase(topLead.Status, leadProposedWindow) : null;

    // Compose a speech-safe summary. Multiple open jobs → ask which to scope (E2).
    // Jobs take precedence in the spoken line; a lead-only customer (no open jobs but an
    // open lead) speaks its LEAD state instead of "no jobs" so Sara routes to booking.
    let speak;
    if (openJobsCount === 0) {
        if (hasOpenLead) {
            if (leadProposedWindow) {
                // A held slot exists → route to bookOnLead confirm.
                speak = `I see your request — ${openLeadStatus}. Want me to lock that in, or find you another time?`;
            } else {
                // Request in, no slot yet → route to recommendSlots → bookOnLead.
                speak = `I see we have your request in — ${openLeadStatus}. Want me to find you a time?`;
            }
        } else {
            speak = "I don't see any open jobs on your account right now — is there something new I can help you book?";
        }
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
        hasOpenLead,
        openLeadStatus,
        leadProposedWindow,
        openLeadCount,
    });
}

module.exports = { run };
