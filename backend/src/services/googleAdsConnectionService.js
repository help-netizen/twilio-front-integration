'use strict';

const db = require('../db/connection');
const googleAdsQueries = require('../db/googleAdsQueries');
const googleAdsAdapter = require('./googleAdsAdapter');
const {
    encryptRefreshToken,
    normalizeCustomerId,
    serializeConnectionStatus,
} = require('./googleAdsCredentials');

class GoogleAdsConnectionError extends Error {
    constructor(code, message, httpStatus = 400) {
        super(message);
        this.name = 'GoogleAdsConnectionError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function requireCompanyId(companyId) {
    if (!companyId) {
        throw new GoogleAdsConnectionError(
            'COMPANY_CONTEXT_REQUIRED',
            'A company context is required.',
            400
        );
    }
}

function sharedOAuthCredentials() {
    const credentials = {
        clientId: process.env.GOOGLE_ADS_CLIENT_ID,
        clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
        developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    };
    if (!credentials.clientId
        || !credentials.clientSecret
        || !credentials.developerToken) {
        throw new GoogleAdsConnectionError(
            'GOOGLE_ADS_CONFIGURATION_MISSING',
            'Google Ads is not configured for this Albusto deployment.',
            503
        );
    }
    return credentials;
}

function assertSameCustomer(existing, customerId) {
    if (existing && existing.customer_id !== customerId) {
        throw new GoogleAdsConnectionError(
            'CUSTOMER_MISMATCH',
            'This company is already bound to a different Google Ads customer.',
            409
        );
    }
}

async function connectCompany({
    companyId,
    customerId,
    refreshToken,
    actorId = null,
}, dependencies = {}) {
    requireCompanyId(companyId);
    const queries = dependencies.queries || googleAdsQueries;
    const adapter = dependencies.adapter || googleAdsAdapter;
    const database = dependencies.db || db;
    const normalizedCustomerId = normalizeCustomerId(customerId);

    const existing = await queries.getConnectionByCompany(companyId);
    assertSameCustomer(existing, normalizedCustomerId);

    const providerAccount = await adapter.fetchAccountMetadata({
        ...sharedOAuthCredentials(),
        customerId: normalizedCustomerId,
        refreshToken,
    });
    const refreshTokenEncrypted = encryptRefreshToken(refreshToken);

    const client = await database.pool.connect();
    try {
        await client.query('BEGIN');
        const locked = await queries.getConnectionByCompany(
            companyId,
            client,
            true
        );
        assertSameCustomer(locked, normalizedCustomerId);
        const channel = await queries.ensureGoogleAdsChannel(companyId, client);
        const connection = await queries.upsertConnection({
            companyId,
            channelId: channel.id,
            customerId: normalizedCustomerId,
            refreshTokenEncrypted,
            currencyCode: providerAccount.currency_code,
            accountTimezone: providerAccount.account_timezone,
            actorId,
        }, client);
        if (!connection) {
            throw new GoogleAdsConnectionError(
                'CUSTOMER_MISMATCH',
                'This company is already bound to a different Google Ads customer.',
                409
            );
        }
        await client.query('COMMIT');
        return serializeConnectionStatus(connection);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function getConnectionStatus(companyId, dependencies = {}) {
    requireCompanyId(companyId);
    const queries = dependencies.queries || googleAdsQueries;
    const row = await queries.getConnectionByCompany(companyId);
    return serializeConnectionStatus(row);
}

async function getMarketplaceConnectionState(companyId, dependencies = {}) {
    requireCompanyId(companyId);
    const queries = dependencies.queries || googleAdsQueries;
    const row = await queries.getConnectionByCompany(companyId);
    if (!row) return null;
    return {
        status: row.status,
        created_at: row.created_at || null,
        last_synced_at: row.last_synced_at || null,
    };
}

async function disconnectCompany(companyId, actorId = null, dependencies = {}) {
    requireCompanyId(companyId);
    const queries = dependencies.queries || googleAdsQueries;
    await queries.disconnectConnection(companyId, actorId);
    return { status: 'disconnected' };
}

async function requestCompanySync(companyId, dependencies = {}) {
    requireCompanyId(companyId);
    const queries = dependencies.queries || googleAdsQueries;
    const row = await queries.requestSync(companyId, dependencies.now || new Date());
    if (!row) {
        throw new GoogleAdsConnectionError(
            'GOOGLE_ADS_NOT_CONNECTED',
            'Google Ads is not connected for this company.',
            409
        );
    }
    return { status: row.last_sync_status };
}

module.exports = {
    GoogleAdsConnectionError,
    connectCompany,
    disconnectCompany,
    getConnectionStatus,
    getMarketplaceConnectionState,
    requestCompanySync,
    sharedOAuthCredentials,
};
