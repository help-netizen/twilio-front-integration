'use strict';

const elocalQueries = require('../db/elocalQueries');
const {
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
} = require('./phoneAttributionCore');

function buildMatchResults(leads, evidenceRows, now) {
    return buildPhoneMatchResults(leads, evidenceRows, now, {
        evidenceItemId: evidence => evidence.elocal_lead_id,
    }).map(result => {
        const { itemId, ...match } = result;
        return { elocalLeadId: itemId, ...match };
    });
}

function buildAttributions(matchResults, jobs) {
    return buildWindowedJobAttributions(
        matchResults.map(result => ({
            ...result,
            itemId: result.elocalLeadId,
        })),
        jobs
    ).map(attribution => {
        const { itemId, ...match } = attribution;
        return { elocalLeadId: itemId, ...match };
    });
}

async function matchCompany({
    companyId,
    connectionId,
    expectedLeaseExpiresAt,
    now = new Date(),
}, dependencies = {}) {
    const queries = dependencies.queries || elocalQueries;
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
};
