'use strict';

const CALL_WINDOW_MS = 15 * 60 * 1000;
const CRM_LEAD_WINDOW_MS = 24 * 60 * 60 * 1000;
const JOB_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const JOB_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const MATCH_VERSION = 1;
const MIN_ATTRIBUTION_CONFIDENCE = 90;

function normalizeUsPhone(value) {
    if (typeof value !== 'string') return null;
    const digits = value.replace(/[^0-9]/g, '');
    if (digits.length < 10) return null;
    const normalizedPhone = digits.slice(-10);
    return {
        normalizedPhone,
        phoneE164: `+1${normalizedPhone}`,
    };
}

function dateMillis(value) {
    const milliseconds = value instanceof Date
        ? value.getTime()
        : new Date(value).getTime();
    return Number.isFinite(milliseconds) ? milliseconds : null;
}

function chooseEvidence(evidence) {
    if (evidence.length === 0) return { status: 'unmatched', evidence: null };
    const topConfidence = Math.max(...evidence.map(row => Number(row.match_confidence)));
    const top = evidence.filter(row => Number(row.match_confidence) === topConfidence);
    const deltas = top
        .filter(row => row.delta_seconds !== null && row.delta_seconds !== undefined)
        .map(row => Number(row.delta_seconds))
        .filter(Number.isFinite);
    const minimumDelta = deltas.length > 0 ? Math.min(...deltas) : null;
    const finalists = minimumDelta === null
        ? top
        : top.filter(row => Number(row.delta_seconds) === minimumDelta);
    const contactIds = new Set(finalists.map(row => String(row.contact_id)));
    if (contactIds.size !== 1) return { status: 'ambiguous', evidence: null };
    return { status: 'selected', evidence: finalists[0] };
}

function buildPhoneMatchResults(items, evidenceRows, now, options = {}) {
    const itemId = options.itemId || (item => item.id);
    const evidenceItemId = options.evidenceItemId
        || (evidence => evidence.provider_item_id);
    const isEligible = options.isEligible || (() => true);
    const evidenceByItem = new Map();
    for (const evidence of evidenceRows) {
        const key = String(evidenceItemId(evidence));
        if (!evidenceByItem.has(key)) evidenceByItem.set(key, []);
        evidenceByItem.get(key).push(evidence);
    }

    return items.map(item => {
        const id = itemId(item);
        const result = {
            itemId: id,
            matchStatus: 'unmatched',
            matchedContactId: null,
            matchedLeadId: null,
            matchedCallId: null,
            matchMethod: null,
            matchConfidence: null,
            matchedAt: null,
            matchVersion: MATCH_VERSION,
            normalizedPhone: item.normalized_phone,
            providerCreatedAt: item.provider_created_at,
            selectedEvidence: null,
        };
        if (!isEligible(item)) {
            result.matchStatus = 'ineligible';
            return result;
        }
        if (!item.normalized_phone) {
            result.matchStatus = 'no_phone';
            return result;
        }
        const selected = chooseEvidence(evidenceByItem.get(String(id)) || []);
        if (selected.status === 'ambiguous') {
            result.matchStatus = 'ambiguous';
            return result;
        }
        if (!selected.evidence) return result;
        const evidence = selected.evidence;
        result.matchMethod = evidence.match_method;
        result.matchConfidence = Number(evidence.match_confidence);
        if (result.matchConfidence < MIN_ATTRIBUTION_CONFIDENCE) {
            result.matchStatus = 'diagnostic';
            return result;
        }
        result.matchStatus = 'matched';
        result.matchedContactId = evidence.contact_id;
        result.matchedLeadId = evidence.crm_lead_id || null;
        result.matchedCallId = evidence.call_id || null;
        result.matchedAt = now;
        result.selectedEvidence = evidence;
        return result;
    });
}

function buildWindowedJobAttributions(matchResults, jobs) {
    const matchedByPhone = new Map();
    for (const result of matchResults) {
        if (result.matchStatus !== 'matched') continue;
        if (!matchedByPhone.has(result.normalizedPhone)) {
            matchedByPhone.set(result.normalizedPhone, []);
        }
        matchedByPhone.get(result.normalizedPhone).push(result);
    }
    for (const phoneResults of matchedByPhone.values()) {
        phoneResults.sort((left, right) => (
            dateMillis(left.providerCreatedAt) - dateMillis(right.providerCreatedAt)
            || String(left.itemId).localeCompare(String(right.itemId))
        ));
    }

    const ownersByJob = new Map();
    for (const job of jobs) {
        const acquiredAt = dateMillis(job.acquired_at);
        if (acquiredAt === null) continue;
        const phoneResults = matchedByPhone.get(job.normalized_phone) || [];
        for (let index = 0; index < phoneResults.length; index++) {
            const result = phoneResults[index];
            const itemAt = dateMillis(result.providerCreatedAt);
            const nextAt = dateMillis(phoneResults[index + 1]?.providerCreatedAt);
            const windowStart = itemAt - JOB_LOOKBACK_MS;
            const naturalEnd = itemAt + JOB_WINDOW_MS;
            const windowEnd = nextAt === null ? naturalEnd : Math.min(nextAt, naturalEnd);
            if (acquiredAt < windowStart || acquiredAt >= windowEnd) continue;
            const candidate = {
                result,
                distance: Math.abs(acquiredAt - itemAt),
            };
            const current = ownersByJob.get(String(job.job_id));
            if (!current
                || candidate.distance < current.distance
                || (
                    candidate.distance === current.distance
                    && String(result.itemId)
                        .localeCompare(String(current.result.itemId)) < 0
                )) {
                ownersByJob.set(String(job.job_id), candidate);
            }
        }
    }

    return jobs.flatMap(job => {
        const owner = ownersByJob.get(String(job.job_id));
        if (!owner) return [];
        const evidence = owner.result.selectedEvidence;
        return [{
            itemId: owner.result.itemId,
            matchedJobId: job.job_id,
            matchedContactId: job.contact_id,
            evidenceCallId: evidence.call_id || null,
            evidenceLeadId: evidence.crm_lead_id || null,
            matchMethod: evidence.match_method,
            matchConfidence: Number(evidence.match_confidence),
        }];
    });
}

module.exports = {
    CALL_WINDOW_MS,
    CRM_LEAD_WINDOW_MS,
    JOB_LOOKBACK_MS,
    JOB_WINDOW_MS,
    MATCH_VERSION,
    MIN_ATTRIBUTION_CONFIDENCE,
    buildPhoneMatchResults,
    buildWindowedJobAttributions,
    chooseEvidence,
    normalizeUsPhone,
};
