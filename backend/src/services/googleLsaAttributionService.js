'use strict';

const googleLsaQueries = require('../db/googleLsaQueries');
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

function buildMatchResults(leads, evidenceRows, now) {
    return buildPhoneMatchResults(leads, evidenceRows, now, {
        evidenceItemId: evidence => evidence.lsa_lead_id,
        isEligible: lead => lead.lead_type === 'PHONE_CALL',
    }).map(result => {
        const { itemId, ...match } = result;
        return { lsaLeadId: itemId, ...match };
    });
}

function buildAttributions(matchResults, jobs) {
    return buildWindowedJobAttributions(
        matchResults.map(result => ({
            ...result,
            itemId: result.lsaLeadId,
        })),
        jobs
    ).map(attribution => {
        const { itemId, ...match } = attribution;
        return { lsaLeadId: itemId, ...match };
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
