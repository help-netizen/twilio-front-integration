'use strict';

const identityResolver = require('./identityResolver');
const jobsService = require('../jobsService');
const leadsService = require('../leadsService');
const resultShapes = require('./resultShapes');

function firstDefined(input, names) {
    for (const name of names) {
        if (input[name] != null && input[name] !== '') return input[name];
    }
    return null;
}

function subjectAmbiguous() {
    return resultShapes.refusal(
        'I see more than one customer on this phone. Which repair are you asking about?',
        { subjectAmbiguous: true },
    );
}

function notAuthorized() {
    return resultShapes.refusal("I don't see a financial document I can discuss for that repair.");
}

function phoneMatchRequired() {
    return resultShapes.refusal(
        "I can't access financial details from this phone. I can have the team follow up.",
        { phoneMatchRequired: true },
    );
}

function isL1(context) {
    return Boolean(context && (context.level === 'L1' || context.level === 'L2'));
}

function sameId(left, right) {
    return left != null && right != null && String(left) === String(right);
}

async function loadLead(companyId, input) {
    const leadUuid = firstDefined(input, ['leadUuid', 'lead_uuid']);
    const leadId = firstDefined(input, ['leadId', 'lead_id']);
    if (leadUuid == null && leadId == null) return null;
    try {
        return leadUuid != null
            ? await leadsService.getLeadByUUID(leadUuid, companyId)
            : await leadsService.getLeadById(leadId, companyId);
    } catch (err) {
        if (err && (err.code === 'LEAD_NOT_FOUND' || err.httpStatus === 404 || err.status === 404)) return false;
        throw err;
    }
}

async function subjectContactMatchesPhone(companyId, matchedPhone, contactId) {
    if (!matchedPhone || contactId == null) return false;
    const resolution = await identityResolver.resolve(companyId, {
        phone: matchedPhone,
        contactId,
    });
    return Boolean(
        resolution &&
        resolution.matchType === 'existing' &&
        sameId(resolution.contactId, contactId),
    );
}

/**
 * Build the finance-only customer/repair scope. This deliberately does not alter
 * identityResolver's take-latest behavior used by booking flows.
 */
async function resolveSubject(companyId, verifiedContext, input = {}) {
    if (!companyId || !isL1(verifiedContext)) {
        return { ok: false, result: phoneMatchRequired() };
    }

    const jobId = firstDefined(input, ['jobId', 'job_id']);
    let job = null;
    if (jobId != null) {
        job = await jobsService.getJobById(jobId, companyId);
        if (!job) return { ok: false, result: notAuthorized() };
    }

    const lead = await loadLead(companyId, input);
    if (lead === false) return { ok: false, result: notAuthorized() };
    if (job && lead && !sameId(job.lead_id, lead.ClientId)) {
        return { ok: false, result: notAuthorized() };
    }

    const hasSubject = Boolean(job || lead);
    const sharedPhone = Number(verifiedContext.phoneCandidateCount || 0) > 1;
    if (sharedPhone && !hasSubject) {
        return { ok: false, result: subjectAmbiguous() };
    }

    const subjectContactId = job?.contact_id ?? lead?.ContactId ?? null;
    if (hasSubject && subjectContactId != null) {
        if (sharedPhone) {
            const matchesPhone = await subjectContactMatchesPhone(
                companyId,
                verifiedContext.matchedPhone,
                subjectContactId,
            );
            if (!matchesPhone) return { ok: false, result: notAuthorized() };
        } else if (verifiedContext.contactId != null && !sameId(subjectContactId, verifiedContext.contactId)) {
            return { ok: false, result: notAuthorized() };
        }
    } else if (hasSubject && lead) {
        const leadPhone = identityResolver.normalizePhoneLast10(lead.Phone);
        if (!leadPhone || leadPhone !== verifiedContext.matchedPhone) {
            return { ok: false, result: notAuthorized() };
        }
    }

    const contactId = subjectContactId ?? verifiedContext.contactId ?? null;
    if (contactId == null && !lead) {
        return { ok: false, result: notAuthorized() };
    }

    return {
        ok: true,
        contactId,
        jobId: job ? job.id : null,
        leadId: lead ? lead.ClientId : (job?.lead_id ?? null),
        leadUuid: lead ? lead.UUID : null,
    };
}

/**
 * Contactless leads are not returned by the general contact identity resolver.
 * For finance only, an exact company-scoped lead plus matching caller phone is L1.
 */
async function deriveLeadPhoneContext(companyId, currentContext, input = {}) {
    if (isL1(currentContext)) return currentContext;
    const phone = identityResolver.normalizePhoneLast10(input.phone);
    if (!phone) return currentContext;
    const lead = await loadLead(companyId, input);
    if (!lead || lead === false) return currentContext;
    if (identityResolver.normalizePhoneLast10(lead.Phone) !== phone) return currentContext;
    return {
        level: 'L1',
        contactId: lead.ContactId || null,
        customerName: [lead.FirstName, lead.LastName].filter(Boolean).join(' ') || null,
        matchedPhone: phone,
        ambiguous: false,
        ambiguousCount: 0,
        phoneCandidateCount: 0,
    };
}

function documentMatchesScope(document, scope) {
    if (!document || !scope) return false;
    if (scope.jobId != null) return sameId(document.job_id, scope.jobId);
    if (scope.leadId != null) return sameId(document.lead_id, scope.leadId);
    return sameId(document.contact_id, scope.contactId);
}

function listFilters(scope) {
    if (scope.jobId != null) return { jobId: scope.jobId };
    if (scope.leadId != null) return { leadId: scope.leadId };
    return { contactId: scope.contactId };
}

module.exports = {
    deriveLeadPhoneContext,
    documentMatchesScope,
    listFilters,
    notAuthorized,
    phoneMatchRequired,
    resolveSubject,
    subjectAmbiguous,
};
