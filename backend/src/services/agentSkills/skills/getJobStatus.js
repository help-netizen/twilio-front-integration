/**
 * agentSkills / skills / getJobStatus
 * (AGENT-SKILLS-001, spec §4.3 / architecture §6 · task T5 — FR-S3 / FR-C3)
 *
 * READ · requiredLevel L1. Answers "what's going on with my repair?" for a
 * specific or the most-relevant open job.
 *
 * OUTPUT (speech-safe, provider-neutral):
 *   { ok, jobId, serviceName, statusLabel(phrase), statusStage(internal-key,
 *     NOT spoken), appointmentWindow|null, technicianEtaText|null, nextAction, speak }
 *
 * HARD RULES:
 *   - NEVER read the raw `blanc_status` aloud — map via statusMap (spec §4.10).
 *     `statusStage` carries the internal nextAction hint key for the caller's
 *     branching logic; it is explicitly NOT spoken.
 *   - `technicianEtaText` is framed as "the tech will text before arriving" — it
 *     NEVER contains the technician's name or number (spec §2.5, ASK-SEC-03).
 *   - A booked-not-started job (`Submitted` + a schedule window) offers reschedule
 *     — there is NO "Scheduled" label (spec §4.10).
 *   - `jobId` omitted → the most relevant open job.
 *
 * ISOLATION: the job is fetched company-scoped via getJobById(jobId, companyId);
 * a foreign / cross-contact job id resolves to a safe "I can't find that one"
 * shape and falls back to the caller's OWN open job — never another customer's job.
 *
 * LEAD AWARENESS (AGENT-SKILLS-002 §3.3): when the contact has NO open job but DOES
 * have an open lead (a submitted request, or an insurance-email lead with no job yet),
 * we return an informative `ok` shape describing the LEAD state — status phrase + a
 * proposed-slot window range — instead of a flat "no open job" refusal, so a lead-only
 * existing customer isn't told "nothing on file." Jobs always take precedence; the lead
 * path is only reached when `jobs.length === 0`. No `jobId` is fabricated for a lead.
 * The open-lead read is the NON-SUPPRESSING, company-scoped `getOpenLeadsByContact` (T3).
 */

'use strict';

const jobsService = require('../../jobsService');
const leadsService = require('../../leadsService');
const { statusMap, zbSubstatusMap } = require('../statusMap');
const resultShapes = require('../resultShapes');

const TZ = 'America/New_York';

// Lead statuses that read as brand-new / not-yet-actioned (AGENT-SKILLS-002 §3.2.1).
// Small inclusion set (not a new module); the lead-side equivalent of statusMap, which
// only covers job blanc_status. Terminal tokens (Lost/Converted) never reach here — the
// getOpenLeadsByContact read already excludes them.
const NEW_LEAD_STATUSES = new Set(['submitted', 'new', 'review']);

/**
 * Format a job's start/end (ISO strings) into a speech-safe window RANGE, never an
 * exact minute. Returns null when there's no usable start.
 * @param {string|null} startIso
 * @param {string|null} endIso
 * @returns {string|null}
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
 * Choose the most relevant open job when no jobId is supplied: prefer a job with
 * the soonest FUTURE window, else the most recently updated open job.
 * @param {object[]} jobs Open jobs (rowToJob shape).
 * @returns {object|null}
 */
function pickMostRelevantJob(jobs) {
    if (!Array.isArray(jobs) || jobs.length === 0) return null;
    const now = Date.now();
    const future = jobs
        .filter((j) => j && j.start_date && new Date(j.start_date).getTime() >= now)
        .sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
    if (future.length > 0) return future[0];
    const byUpdated = [...jobs].sort((a, b) => {
        const ax = new Date(a.updated_at || a.created_at || 0).getTime();
        const bx = new Date(b.updated_at || b.created_at || 0).getTime();
        return bx - ax;
    });
    return byUpdated[0];
}

/**
 * True when the job is booked-but-not-started (Submitted WITH a schedule window) —
 * there is no "Scheduled" status, so we detect it structurally (spec §4.10).
 * @param {object} job
 * @returns {boolean}
 */
function isBookedNotStarted(job) {
    return job && job.blanc_status === 'Submitted' && Boolean(job.start_date);
}

/**
 * Caller-friendly phrase for an OPEN lead (AGENT-SKILLS-002 §3.2.1). NEVER reads the
 * raw `Status` token aloud. A proposed slot window wins over a bare status; else a
 * pre-contact status → "we have your request in"; any other non-terminal → "in progress".
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
 * Read the contact's OPEN leads (company-scoped, non-suppressing). Defensive: any
 * failure → [] (degrade to "no open lead", never throw/leak). Keeps the skill at L1.
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
 * Build an informative (refusal-free) lead-status shape for a contact who has an open
 * lead but no open job (AGENT-SKILLS-002 §3.3). No fabricated `jobId`; the speak reflects
 * the lead state and offers to book. Only status phrase + window range — no lead PII.
 * @param {object} lead The newest open lead (rowToLead shape).
 * @returns {{ ok: true, jobId: null, hasOpenLead: true, statusLabel: string, leadProposedWindow: string|null, nextAction: string, speak: string }}
 */
function buildLeadOnlyResult(lead) {
    const window = formatWindow(lead.LeadDateTime, lead.LeadEndDateTime);
    const phrase = leadStatusPhrase(lead.Status, window);
    const speak = window
        ? `I don't see an open repair yet, but I have your request — ${phrase}. Want me to lock that in?`
        : `I don't see an open repair yet, but I have your request — ${phrase}. Want me to get you booked?`;
    return resultShapes.ok(speak, {
        jobId: null,
        hasOpenLead: true,
        statusLabel: phrase,
        leadProposedWindow: window,
        nextAction: window ? 'offer_book_on_lead' : 'offer_find_slot',
    });
}

/**
 * Build the caller-friendly status view for one job. Applies the ZB substatus
 * overlay (en-route / in-progress) when it is more specific than the parent
 * blanc_status, and derives the ETA framing + nextAction from the stage.
 * @param {object} job A single job (rowToJob shape).
 * @returns {{ ok: true, jobId: string, serviceName: string, statusLabel: string, statusStage: string, appointmentWindow: string|null, technicianEtaText: string|null, nextAction: string, speak: string }}
 */
function buildJobStatusResult(job) {
    // Base mapping from the real FSM status (never spoken raw).
    const base = statusMap(job.blanc_status);
    // A live ZB substatus (en-route / in-progress) can be more specific.
    const zbOverlay = zbSubstatusMap(job.zb_status);
    const chosen = zbOverlay || base;

    const window = formatWindow(job.start_date, job.end_date);

    // Booked-not-started (Submitted + window) → phrase it as scheduled & offer
    // reschedule, WITHOUT inventing a "Scheduled" label.
    let statusLabel = chosen.phrase;
    let nextAction = chosen.nextAction || 'none';
    if (!zbOverlay && isBookedNotStarted(job) && window) {
        statusLabel = `You're booked in for ${window}.`;
        nextAction = 'offer_reschedule';
    }

    // ETA framing — text-before-arriving only; NEVER the tech's name/number.
    let technicianEtaText = null;
    if (nextAction === 'give_eta_text' || chosen.nextAction === 'give_eta_text') {
        technicianEtaText = 'Your technician will text you before arriving.';
    }

    // Compose the spoken line. `statusStage` is the internal hint key (not spoken).
    const speakParts = [statusLabel];
    if (window && nextAction !== 'offer_reschedule') {
        speakParts.push(`Your appointment window is ${window}.`);
    }
    if (technicianEtaText) speakParts.push(technicianEtaText);

    return {
        ok: true,
        jobId: String(job.id),
        serviceName: job.service_name || 'your service',
        statusLabel,
        statusStage: chosen.nextAction || 'none',
        appointmentWindow: window,
        technicianEtaText,
        nextAction,
        speak: speakParts.join(' '),
    };
}

/**
 * Resolve and report the status of a job. Follows the skill `run` contract.
 *
 * @param {string} companyId Tenant scope.
 * @param {{ contactId: number|null }} verifiedContext Server-verified identity (contactId is authoritative for ownership).
 * @param {{ jobId?: string }} input Per-call payload; `jobId` optional.
 * @returns {Promise<object>} the status result, or a safe refusal/fallback shape.
 */
async function run(companyId, verifiedContext, input) {
    const contactId = verifiedContext && verifiedContext.contactId != null ? verifiedContext.contactId : null;
    if (!companyId || contactId == null) {
        return resultShapes.refusal("I couldn't pull up your job just now — let me have a teammate follow up with you.");
    }

    const requestedJobId = input && input.jobId != null ? input.jobId : null;

    // --- Path A: a specific jobId was requested. Fetch company-scoped and confirm
    //     it belongs to the VERIFIED contact. A foreign / cross-contact id is
    //     treated as not-found (never disclose another customer's job) and we fall
    //     through to the caller's own open job.
    if (requestedJobId != null) {
        let job = null;
        try {
            job = await jobsService.getJobById(requestedJobId, companyId);
        } catch (_e) {
            job = null;
        }
        if (job && String(job.contact_id) === String(contactId)) {
            return buildJobStatusResult(job);
        }
        // else: fall through to own-job resolution below.
    }

    // --- Path B: no (valid/owned) jobId → most relevant OPEN job for this contact.
    const jobsResult = await jobsService.listJobs({ contactId, onlyOpen: true, companyId, limit: 100 });
    const jobs = jobsResult && Array.isArray(jobsResult.results) ? jobsResult.results : [];

    if (jobs.length === 0) {
        // No open JOB — but a lead-only existing customer (submitted request /
        // insurance-email lead) should hear their real state, not "nothing on file".
        // Check the same non-suppressing open-lead read; a lead → informative ok shape.
        const openLeads = await readOpenLeads(contactId, companyId);
        if (openLeads.length > 0) {
            return buildLeadOnlyResult(openLeads[0]);
        }
        return resultShapes.refusal(
            "I don't see an open job on your account right now — is there something new I can help you book?",
        );
    }

    // Multiple open jobs and the caller didn't scope one → ask which (E2), unless a
    // specific (but unowned/unknown) jobId was requested, in which case still guide
    // them to pick from their own jobs.
    if (jobs.length > 1) {
        return resultShapes.refusal(
            `You have ${jobs.length} jobs in progress. Which one would you like an update on — do you know the appliance or service?`,
        );
    }

    return buildJobStatusResult(jobs[0]);
}

module.exports = { run };
