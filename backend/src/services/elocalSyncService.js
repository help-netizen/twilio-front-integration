'use strict';

const elocalQueries = require('../db/elocalQueries');
const elocalAdapter = require('./elocalAdapter');
const elocalAttributionService = require('./elocalAttributionService');
const { localDateInTZ } = require('../utils/companyTime');

const BACKFILL_DAYS = 731;
const BACKFILL_CHUNK_DAYS = 30;
const ROLLING_WINDOW_DAYS = 30;
const LEASE_MS = 15 * 60 * 1000;

function addDays(dateString, days) {
    const [year, month, day] = dateString.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return date.toISOString().slice(0, 10);
}

function buildRanges(connection, now) {
    const today = localDateInTZ(
        now,
        connection.company_timezone || 'America/New_York'
    );
    if (connection.synced_through_date) {
        return [{
            startDate: addDays(today, -(ROLLING_WINDOW_DAYS - 1)),
            endDate: today,
        }];
    }
    const ranges = [];
    let startDate = addDays(today, -(BACKFILL_DAYS - 1));
    while (startDate <= today) {
        const boundedEnd = addDays(startDate, BACKFILL_CHUNK_DAYS - 1);
        const endDate = boundedEnd > today ? today : boundedEnd;
        ranges.push({ startDate, endDate });
        startDate = addDays(endDate, 1);
    }
    return ranges;
}

function nowFrom(dependencies) {
    if (typeof dependencies.now === 'function') return dependencies.now();
    if (dependencies.now instanceof Date) return new Date(dependencies.now);
    return new Date();
}

function errorCode(error) {
    return typeof error?.code === 'string'
        ? error.code
        : 'ELOCAL_SYNC_FAILED';
}

function errorMessage(error) {
    const messages = {
        ELOCAL_CONFIGURATION_MISSING: 'eLocal API access is not configured.',
        ELOCAL_ACCESS_DENIED: 'eLocal API access was denied.',
        ELOCAL_QUERY_FAILED: 'eLocal could not complete the requested query.',
        SYNC_CLAIM_LOST: 'The eLocal sync lease is no longer active.',
    };
    return messages[errorCode(error)] || 'eLocal synchronization failed.';
}

function apiKeyFor(connection) {
    const reference = connection.api_key_reference || 'ELOCAL_API_KEY';
    const value = process.env[reference];
    if (typeof value !== 'string' || !value) {
        const error = new Error('eLocal API access is not configured.');
        error.code = 'ELOCAL_CONFIGURATION_MISSING';
        throw error;
    }
    return value;
}

async function refreshClaim(queries, companyId, connectionId, currentLease, now) {
    const nextLease = new Date(now.getTime() + LEASE_MS);
    const refreshed = await queries.refreshLease(
        companyId,
        connectionId,
        currentLease,
        nextLease
    );
    if (!refreshed) {
        const error = new Error('eLocal sync claim was lost.');
        error.code = 'SYNC_CLAIM_LOST';
        throw error;
    }
    return nextLease;
}

async function syncCompany(companyId, connectionId, dependencies = {}) {
    const queries = dependencies.queries || elocalQueries;
    const adapter = dependencies.adapter || elocalAdapter;
    const attribution = dependencies.attribution || elocalAttributionService;
    const startedAt = nowFrom(dependencies);
    let leaseExpiresAt = new Date(startedAt.getTime() + LEASE_MS);
    const connection = await queries.claimConnection(
        companyId,
        connectionId,
        startedAt,
        leaseExpiresAt
    );
    if (!connection) return { status: 'skipped' };

    try {
        const apiKey = apiKeyFor(connection);
        const ranges = buildRanges(connection, startedAt);
        let callCount = 0;
        let webLeadCount = 0;
        for (const range of ranges) {
            const result = await adapter.fetchCampaignResults({
                campaignIds: connection.campaign_ids,
                apiKey,
                startDate: range.startDate,
                endDate: range.endDate,
            });
            callCount += result.calls.length;
            webLeadCount += result.webLeads.length;
            await queries.commitCallsChunk({
                companyId,
                connectionId,
                rows: result.calls,
                chunkStart: range.startDate,
                chunkEnd: range.endDate,
                now: nowFrom(dependencies),
                expectedLeaseExpiresAt: leaseExpiresAt,
            });
            leaseExpiresAt = await refreshClaim(
                queries,
                companyId,
                connectionId,
                leaseExpiresAt,
                nowFrom(dependencies)
            );
        }

        const matchResult = await attribution.matchCompany({
            companyId,
            connectionId,
            expectedLeaseExpiresAt: leaseExpiresAt,
            now: nowFrom(dependencies),
        }, dependencies.attributionDependencies || {});
        await queries.completeSync({
            companyId,
            connectionId,
            callCount,
            webLeadCount,
            now: nowFrom(dependencies),
            expectedLeaseExpiresAt: leaseExpiresAt,
        });
        return {
            status: 'ok',
            ranges: ranges.length,
            calls: callCount,
            webLeads: webLeadCount,
            matchedLeads: matchResult.matchedLeads,
            attributedJobs: matchResult.attributedJobs,
        };
    } catch (error) {
        const code = errorCode(error);
        if (code !== 'SYNC_CLAIM_LOST') {
            await queries.failSync({
                companyId,
                connectionId,
                errorCode: code,
                errorMessage: errorMessage(error),
                now: nowFrom(dependencies),
                expectedLeaseExpiresAt: leaseExpiresAt,
            });
        }
        throw error;
    }
}

function createElocalScheduler(dependencies = {}) {
    const queries = dependencies.queries || elocalQueries;
    const runner = dependencies.syncCompany || syncCompany;
    const activeRuns = new Set();

    function launch(connection) {
        const promise = Promise.resolve()
            .then(() => runner(
                connection.company_id,
                connection.id,
                dependencies.syncDependencies || {}
            ))
            .catch((error) => {
                console.warn(`[ElocalSync] code=${errorCode(error)}`);
            })
            .finally(() => activeRuns.delete(promise));
        activeRuns.add(promise);
    }

    async function tick(tickNow = new Date()) {
        if (activeRuns.size > 0) {
            return { claimed: 0, active: activeRuns.size };
        }
        const due = await queries.listDueConnections(tickNow, 1);
        if (!due[0]) return { claimed: 0, active: 0 };
        launch(due[0]);
        return { claimed: 1, active: activeRuns.size };
    }

    async function waitForIdle() {
        await Promise.allSettled([...activeRuns]);
    }

    return { tick, waitForIdle, _activeRuns: activeRuns };
}

const singleton = createElocalScheduler();

function registerScheduler(registry) {
    registry.register('elocal', tickNow => singleton.tick(tickNow));
}

module.exports = {
    BACKFILL_CHUNK_DAYS,
    BACKFILL_DAYS,
    LEASE_MS,
    ROLLING_WINDOW_DAYS,
    buildRanges,
    createElocalScheduler,
    registerScheduler,
    syncCompany,
    waitForIdle: singleton.waitForIdle,
    _apiKeyFor: apiKeyFor,
};
