'use strict';

const googleAdsQueries = require('../db/googleAdsQueries');
const googleAdsAdapter = require('./googleAdsAdapter');
const googleAdsConnectionService = require('./googleAdsConnectionService');
const googleLsaAttributionService = require('./googleLsaAttributionService');
const { decryptRefreshToken } = require('./googleAdsCredentials');
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

function toDateString(value) {
    if (value instanceof Date) {
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, '0');
        const day = String(value.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    return String(value).slice(0, 10);
}

function buildRanges(connection, now) {
    const through = connection.synced_through_date
        ? toDateString(connection.synced_through_date)
        : null;
    const today = localDateInTZ(
        now,
        connection.account_timezone || 'America/New_York'
    );
    if (through) {
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
        : 'GOOGLE_ADS_SYNC_FAILED';
}

function errorMessage(error) {
    const messages = {
        AUTH_REFRESH_FAILED: 'Google Ads authorization must be refreshed.',
        ACCOUNT_ACCESS_DENIED: 'Google Ads account access was denied.',
        GOOGLE_ADS_QUERY_FAILED: 'Google Ads could not complete the requested query.',
        UNSUPPORTED_CURRENCY: 'Google Ads accounts must use USD for this connector.',
        GOOGLE_ADS_ENCRYPTION_KEY_MISSING: 'Google Ads token encryption is not configured.',
        GOOGLE_ADS_ENCRYPTION_KEY_INVALID: 'Google Ads token encryption is misconfigured.',
        GOOGLE_ADS_TOKEN_ENVELOPE_INVALID: 'The stored Google Ads authorization is invalid.',
        GOOGLE_ADS_TOKEN_DECRYPT_FAILED: 'The stored Google Ads authorization could not be decrypted.',
        SYNC_CLAIM_LOST: 'The Google Ads sync lease is no longer active.',
    };
    return messages[errorCode(error)] || 'Google Ads synchronization failed.';
}

function reconnectRequired(code) {
    return code === 'AUTH_REFRESH_FAILED'
        || code === 'ACCOUNT_ACCESS_DENIED'
        || code === 'GOOGLE_ADS_TOKEN_ENVELOPE_INVALID'
        || code === 'GOOGLE_ADS_TOKEN_DECRYPT_FAILED';
}

async function syncCompany(companyId, connectionId, dependencies = {}) {
    const queries = dependencies.queries || googleAdsQueries;
    const adapter = dependencies.adapter || googleAdsAdapter;
    const lsaAttribution = dependencies.lsaAttribution
        || googleLsaAttributionService;
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
        const refreshToken = decryptRefreshToken(
            connection.refresh_token_encrypted
        );
        const shared = googleAdsConnectionService.sharedOAuthCredentials();
        const accessToken = await adapter.refreshAccessToken({
            ...shared,
            refreshToken,
        });
        const lsaRows = await adapter.fetchLocalServicesLeads({
            customerId: connection.customer_id,
            developerToken: shared.developerToken,
            accessToken,
            accountTimezone: connection.account_timezone,
        });
        await queries.commitLsaLeads({
            companyId,
            connectionId,
            customerId: connection.customer_id,
            rows: lsaRows,
            now: nowFrom(dependencies),
            expectedLeaseExpiresAt: leaseExpiresAt,
        });
        await lsaAttribution.matchCompany({
            companyId,
            connectionId,
            expectedLeaseExpiresAt: leaseExpiresAt,
            now: nowFrom(dependencies),
        }, dependencies.lsaDependencies || {});
        const ranges = buildRanges(connection, startedAt);
        let rowCount = 0;

        for (let index = 0; index < ranges.length; index++) {
            const range = ranges[index];
            const performanceRows = await adapter.fetchCampaignPerformance({
                customerId: connection.customer_id,
                developerToken: shared.developerToken,
                accessToken,
                startDate: range.startDate,
                endDate: range.endDate,
            });
            rowCount += performanceRows.length;
            const finished = index === ranges.length - 1;
            await queries.commitPerformanceChunk({
                companyId,
                connectionId,
                channelId: connection.channel_id,
                customerId: connection.customer_id,
                rows: performanceRows,
                chunkStart: range.startDate,
                chunkEnd: range.endDate,
                finished,
                now: nowFrom(dependencies),
                expectedLeaseExpiresAt: leaseExpiresAt,
            });

            if (!finished) {
                const nextLease = new Date(nowFrom(dependencies).getTime() + LEASE_MS);
                const refreshed = await queries.refreshLease(
                    companyId,
                    connectionId,
                    leaseExpiresAt,
                    nextLease
                );
                if (!refreshed) {
                    const error = new Error('Google Ads sync claim was lost.');
                    error.code = 'SYNC_CLAIM_LOST';
                    throw error;
                }
                leaseExpiresAt = nextLease;
            }
        }
        return {
            status: 'ok',
            ranges: ranges.length,
            rows: rowCount,
        };
    } catch (error) {
        const code = errorCode(error);
        if (code !== 'SYNC_CLAIM_LOST') {
            await queries.failSync({
                companyId,
                connectionId,
                connectionStatus: reconnectRequired(code)
                    ? 'reconnect_required'
                    : 'connected',
                errorCode: code,
                errorMessage: errorMessage(error),
                now: nowFrom(dependencies),
                expectedLeaseExpiresAt: leaseExpiresAt,
            });
        }
        throw error;
    }
}

function createGoogleAdsScheduler(dependencies = {}) {
    const queries = dependencies.queries || googleAdsQueries;
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
                console.warn(`[GoogleAdsSync] code=${errorCode(error)}`);
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

const singleton = createGoogleAdsScheduler();

function registerScheduler(registry) {
    registry.register('google_ads', tickNow => singleton.tick(tickNow));
}

module.exports = {
    BACKFILL_CHUNK_DAYS,
    BACKFILL_DAYS,
    LEASE_MS,
    ROLLING_WINDOW_DAYS,
    buildRanges,
    createGoogleAdsScheduler,
    registerScheduler,
    syncCompany,
    waitForIdle: singleton.waitForIdle,
};
