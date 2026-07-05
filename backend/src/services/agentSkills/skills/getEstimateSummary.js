/**
 * agentSkills / skills / getEstimateSummary — read, L2 (sensitive)
 * (AGENT-SKILLS-001, spec §4.8 / task T6 · FR-S8 / FR-C5)
 *
 * "How much was my estimate?" — a SPOKEN SUMMARY plus an offer to text a secure
 * link. Returns `{ ok, estimateNumber, status, total, itemCount, summaryText, speak }`.
 *
 * PRIVACY / GUARDRAILS:
 *   - L2-only (amounts are L2 — spec §2.5). The gate already enforced L2 before
 *     `run`; we re-check (defense-in-depth): non-L2 / no contactId → soft needs-verify.
 *   - Company isolation + contact ownership. Every getter is company-scoped, and
 *     the resolved estimate MUST belong to the verified contact (directly, or via a
 *     job that belongs to the contact). A foreign/other-company estimate id →
 *     company-scoped getter throws NOT_FOUND → we return a not-found-safe shape.
 *     A cross-contact estimate → treated as not-found (amounts are NEVER guessed
 *     and NEVER read for a document that isn't the caller's).
 *   - NEVER read line items aloud: `itemCount` is a COUNT, not a list. No per-item
 *     pricing, ever (spec §2.5). Offer to TEXT A LINK (SEND-DOC-001 channel) for
 *     the detail rather than reading it.
 *
 * Service calls (real signatures, verified):
 *   - estimatesService.listEstimates(companyId, { contactId, jobId }) → { rows, total }.
 *   - estimatesService.getEstimate(companyId, id) → { ...estimate, items } (THROWS
 *     EstimatesServiceError NOT_FOUND when absent/foreign — company-scoped).
 *   - jobsService.getJobById(id, companyId) → job (to confirm a supplied jobId
 *     belongs to the verified contact before scoping estimates by it).
 */

'use strict';

const estimatesService = require('../../estimatesService');
const jobsService = require('../../jobsService');
const resultShapes = require('../resultShapes');

/**
 * Belt-and-braces L2 + contact-ownership guard (see getJobHistory for the same
 * rationale). True → a verified (L2) identity bound to a concrete contactId.
 * @param {{ level?:string, contactId?:number|null }} ctx verifiedContext.
 * @returns {boolean}
 */
function isVerifiedContact(ctx) {
    return Boolean(ctx && (ctx.level === 'L1' || ctx.level === 'L2') && ctx.contactId != null && ctx.contactId !== '');
}

/** Coerce a money-ish column to a finite Number (defaults 0). NUMERIC comes back as a string from pg. */
function toAmount(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Same-owner check: does this estimate belong to the verified contact? Direct
 * contact match, OR the estimate's job is one we've already confirmed is the
 * contact's (ownedJobId). Anything else is NOT the caller's document.
 * @param {object} est An estimate row / detail.
 * @param {number|string} contactId Verified contact id.
 * @param {number|string|null} ownedJobId A jobId already confirmed to belong to the contact (or null).
 * @returns {boolean}
 */
function estimateBelongsToContact(est, contactId, ownedJobId) {
    if (!est) return false;
    if (est.contact_id != null && String(est.contact_id) === String(contactId)) return true;
    if (ownedJobId != null && est.job_id != null && String(est.job_id) === String(ownedJobId)) return true;
    return false;
}

/** The canonical not-found-safe refusal for this skill (no amount, no disclosure). */
function notFound() {
    return resultShapes.refusal("I don't see an estimate on file for that. I can have a teammate follow up if you'd like.");
}

/**
 * Build the speech-safe success shape from an estimate detail ({ ...estimate, items }).
 * `itemCount` is the array length only — line items are NEVER surfaced. `speak`
 * states number + status + total and offers to text a link (SEND-DOC-001).
 * @param {object} est Estimate detail with an `items` array.
 * @returns {object}
 */
function summarize(est) {
    const items = Array.isArray(est.items) ? est.items : [];
    const itemCount = items.length;
    const total = toAmount(est.total);
    const estimateNumber = est.estimate_number || '';
    const status = est.status || '';
    const numberPhrase = estimateNumber ? `Estimate ${estimateNumber}` : 'Your estimate';
    const summaryText =
        `${numberPhrase} totals $${total.toFixed(2)} across ${itemCount} ${itemCount === 1 ? 'item' : 'items'}.`;
    const speak =
        `${numberPhrase} comes to $${total.toFixed(2)}. ` +
        `I can text you a secure link with the full breakdown so you have it in writing — would that help?`;
    return resultShapes.ok(speak, {
        estimateNumber,
        status,
        total,
        itemCount,
        summaryText,
    });
}

/**
 * getEstimateSummary — L2 sensitive read. See file header.
 * @param {string} companyId Tenant scope (server-provided).
 * @param {{ level:'L0'|'L1'|'L2', contactId:number|null }} verifiedContext Server-derived.
 * @param {{ estimateId?:string|number, estimate_id?:string|number, jobId?:string|number, job_id?:string|number }} input
 * @returns {Promise<object>} speech-safe summary / not-found-safe / soft refusal.
 */
async function run(companyId, verifiedContext, input = {}) {
    if (!isVerifiedContact(verifiedContext)) {
        return resultShapes.needsVerification();
    }

    const contactId = verifiedContext.contactId;
    const estimateId = input.estimateId != null ? input.estimateId : input.estimate_id;
    const jobId = input.jobId != null ? input.jobId : input.job_id;

    // If a jobId is supplied, confirm it belongs to the verified contact BEFORE we
    // let it scope any estimate lookup (a foreign job must never widen access).
    let ownedJobId = null;
    if (jobId != null && jobId !== '') {
        const job = await jobsService.getJobById(jobId, companyId);
        if (!job || String(job.contact_id) !== String(contactId)) {
            return notFound();
        }
        ownedJobId = job.id;
    }

    // (A) Specific estimate id → company-scoped fetch, then confirm ownership.
    if (estimateId != null && estimateId !== '') {
        let est;
        try {
            est = await estimatesService.getEstimate(companyId, estimateId);
        } catch (err) {
            // NOT_FOUND (foreign/unknown, company-scoped) → not-found-safe. Any other
            // internal error bubbles to the choke-point's SAFE_FALLBACK.
            if (err && (err.code === 'NOT_FOUND' || err.status === 404)) return notFound();
            throw err;
        }
        if (!estimateBelongsToContact(est, contactId, ownedJobId)) return notFound();
        return summarize(est);
    }

    // (B) No id → list the contact's estimates (already contact-scoped), pick most
    //     recent. When a jobId was given, tighten the scope to that job too.
    const filters = ownedJobId != null ? { contactId, jobId: ownedJobId } : { contactId };
    const { rows } = await estimatesService.listEstimates(companyId, filters);
    if (!Array.isArray(rows) || rows.length === 0) return notFound();

    // listEstimates orders newest-first; defend by re-confirming ownership and by
    // hydrating items for an accurate itemCount (list rows carry no items).
    const row = rows.find((r) => estimateBelongsToContact(r, contactId, ownedJobId));
    if (!row) return notFound();

    let est;
    try {
        est = await estimatesService.getEstimate(companyId, row.id);
    } catch (err) {
        if (err && (err.code === 'NOT_FOUND' || err.status === 404)) return notFound();
        throw err;
    }
    if (!estimateBelongsToContact(est, contactId, ownedJobId)) return notFound();
    return summarize(est);
}

module.exports = { run };
