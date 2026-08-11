'use strict';

const googleLsaQueries = require('../db/googleLsaQueries');

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

function timezoneOffsetMinutes(value, timeZone) {
    const name = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: 'longOffset',
    }).formatToParts(value).find(part => part.type === 'timeZoneName')?.value || '';
    if (name === 'GMT') return 0;
    const match = name.match(/^GMT([+-])(\d{2}):(\d{2})$/);
    if (!match) throw new Error('Invalid timezone offset');
    const sign = match[1] === '+' ? 1 : -1;
    return sign * ((Number(match[2]) * 60) + Number(match[3]));
}

function localParts(value, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(value);
    const part = type => Number(parts.find(item => item.type === type)?.value);
    return [
        part('year'),
        part('month'),
        part('day'),
        part('hour'),
        part('minute'),
        part('second'),
    ];
}

function parseProviderCreationDateTime(value, timeZone) {
    if (typeof value !== 'string' || typeof timeZone !== 'string' || !timeZone) {
        throw new Error('Invalid Local Services Ads creation time');
    }
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    const match = value.match(
        /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/
    );
    if (!match) throw new Error('Invalid Local Services Ads creation time');
    const expected = match.slice(1, 7).map(Number);
    const milliseconds = Number((match[7] || '').padEnd(3, '0').slice(0, 3));
    const utcGuess = new Date(Date.UTC(
        expected[0],
        expected[1] - 1,
        expected[2],
        expected[3],
        expected[4],
        expected[5],
        milliseconds
    ));
    let resolved = new Date(
        utcGuess.getTime() - timezoneOffsetMinutes(utcGuess, timeZone) * 60_000
    );
    resolved = new Date(
        utcGuess.getTime() - timezoneOffsetMinutes(resolved, timeZone) * 60_000
    );
    if (localParts(resolved, timeZone).some((part, index) => part !== expected[index])) {
        throw new Error('Invalid Local Services Ads creation time');
    }
    return resolved;
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

function baseResult(lead) {
    return {
        lsaLeadId: lead.id,
        matchStatus: 'unmatched',
        matchedContactId: null,
        matchedLeadId: null,
        matchedCallId: null,
        matchMethod: null,
        matchConfidence: null,
        matchedAt: null,
        matchVersion: MATCH_VERSION,
        normalizedPhone: lead.normalized_phone,
        providerCreatedAt: lead.provider_created_at,
        selectedEvidence: null,
    };
}

function buildMatchResults(leads, evidenceRows, now) {
    const evidenceByLead = new Map();
    for (const evidence of evidenceRows) {
        const key = String(evidence.lsa_lead_id);
        if (!evidenceByLead.has(key)) evidenceByLead.set(key, []);
        evidenceByLead.get(key).push(evidence);
    }

    return leads.map(lead => {
        const result = baseResult(lead);
        if (lead.lead_type !== 'PHONE_CALL') {
            result.matchStatus = 'ineligible';
            return result;
        }
        if (!lead.normalized_phone) {
            result.matchStatus = 'no_phone';
            return result;
        }
        const selected = chooseEvidence(evidenceByLead.get(String(lead.id)) || []);
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

function buildAttributions(matchResults, jobs) {
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
            || String(left.lsaLeadId).localeCompare(String(right.lsaLeadId))
        ));
    }

    const ownersByJob = new Map();
    for (const job of jobs) {
        const acquiredAt = dateMillis(job.acquired_at);
        if (acquiredAt === null) continue;
        const phoneResults = matchedByPhone.get(job.normalized_phone) || [];
        for (let index = 0; index < phoneResults.length; index++) {
            const result = phoneResults[index];
            const leadAt = dateMillis(result.providerCreatedAt);
            const nextAt = dateMillis(phoneResults[index + 1]?.providerCreatedAt);
            const windowStart = leadAt - JOB_LOOKBACK_MS;
            const naturalEnd = leadAt + JOB_WINDOW_MS;
            const windowEnd = nextAt === null ? naturalEnd : Math.min(nextAt, naturalEnd);
            if (acquiredAt < windowStart || acquiredAt >= windowEnd) continue;
            const candidate = {
                result,
                distance: Math.abs(acquiredAt - leadAt),
            };
            const current = ownersByJob.get(String(job.job_id));
            if (!current
                || candidate.distance < current.distance
                || (
                    candidate.distance === current.distance
                    && String(result.lsaLeadId)
                        .localeCompare(String(current.result.lsaLeadId)) < 0
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
            lsaLeadId: owner.result.lsaLeadId,
            matchedJobId: job.job_id,
            matchedContactId: job.contact_id,
            evidenceCallId: evidence.call_id || null,
            evidenceLeadId: evidence.crm_lead_id || null,
            matchMethod: evidence.match_method,
            matchConfidence: Number(evidence.match_confidence),
        }];
    });
}

async function matchCompany({
    companyId,
    connectionId,
    expectedLeaseExpiresAt,
    now = new Date(),
}, dependencies = {}) {
    const queries = dependencies.queries || googleLsaQueries;
    const [leads, evidence] = await Promise.all([
        queries.listMatchableLeads(companyId, connectionId),
        queries.listMatchEvidence(companyId, connectionId),
    ]);
    const results = buildMatchResults(leads, evidence, now);
    const phones = Array.from(new Set(results
        .filter(result => result.matchStatus === 'matched')
        .map(result => result.normalizedPhone)));
    const jobs = await queries.listJobsForPhones(companyId, phones);
    const attributions = buildAttributions(results, jobs);
    return queries.replaceMatchResults({
        companyId,
        connectionId,
        expectedLeaseExpiresAt,
        results,
        attributions,
        now,
    });
}

module.exports = {
    CALL_WINDOW_MS,
    CRM_LEAD_WINDOW_MS,
    JOB_LOOKBACK_MS,
    JOB_WINDOW_MS,
    MATCH_VERSION,
    MIN_ATTRIBUTION_CONFIDENCE,
    _buildAttributions: buildAttributions,
    _buildMatchResults: buildMatchResults,
    _chooseEvidence: chooseEvidence,
    matchCompany,
    normalizeUsPhone,
    parseProviderCreationDateTime,
};
