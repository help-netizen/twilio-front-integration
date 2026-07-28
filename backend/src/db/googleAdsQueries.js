'use strict';

const db = require('./connection');

function requireCompanyId(companyId) {
    if (!companyId) {
        const error = new Error('companyId is required');
        error.code = 'COMPANY_ID_REQUIRED';
        throw error;
    }
}

function requireConnectionId(connectionId) {
    if (!connectionId) {
        const error = new Error('connectionId is required');
        error.code = 'CONNECTION_ID_REQUIRED';
        throw error;
    }
}

function queryFor(client = null) {
    return client?.query ? client.query.bind(client) : db.query;
}

async function getConnectionByCompany(companyId, client = null, forUpdate = false) {
    requireCompanyId(companyId);
    const { rows } = await queryFor(client)(
        `SELECT *
         FROM google_ads_connections
         WHERE company_id = $1
         ${forUpdate ? 'FOR UPDATE' : ''}`,
        [companyId]
    );
    return rows[0] || null;
}

async function getConnectionById(companyId, connectionId, client = null) {
    requireCompanyId(companyId);
    requireConnectionId(connectionId);
    const { rows } = await queryFor(client)(
        `SELECT *
         FROM google_ads_connections
         WHERE company_id = $1
           AND id = $2`,
        [companyId, connectionId]
    );
    return rows[0] || null;
}

async function ensureGoogleAdsChannel(companyId, client = null) {
    requireCompanyId(companyId);
    const { rows } = await queryFor(client)(
        `INSERT INTO lead_source_channels (
            company_id,
            channel_key,
            display_name,
            description,
            metadata,
            is_active
         )
         VALUES (
            $1,
            'google_ads',
            'Google Ads',
            'Google Ads campaign acquisition and spend',
            '{"system":true,"provider_key":"google_ads"}'::JSONB,
            true
         )
         ON CONFLICT (company_id, channel_key) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            description = EXCLUDED.description,
            is_active = true,
            metadata = lead_source_channels.metadata || EXCLUDED.metadata,
            updated_at = NOW()
         RETURNING *`,
        [companyId]
    );
    return rows[0];
}

async function upsertConnection({
    companyId,
    channelId,
    customerId,
    refreshTokenEncrypted,
    currencyCode,
    accountTimezone,
    actorId = null,
}, client = null) {
    requireCompanyId(companyId);
    const { rows } = await queryFor(client)(
        `INSERT INTO google_ads_connections (
            company_id,
            channel_id,
            customer_id,
            refresh_token_encrypted,
            status,
            last_sync_status,
            currency_code,
            account_timezone,
            created_by,
            updated_by
         )
         VALUES ($1, $2, $3, $4, 'connected', 'pending', $5, $6, $7, $7)
         ON CONFLICT (company_id) DO UPDATE SET
            channel_id = EXCLUDED.channel_id,
            refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
            status = 'connected',
            last_sync_status = 'pending',
            synced_from_date = NULL,
            synced_through_date = NULL,
            last_sync_started_at = NULL,
            last_sync_finished_at = NULL,
            last_synced_at = NULL,
            sync_lease_expires_at = NULL,
            last_error_code = NULL,
            last_error = NULL,
            currency_code = EXCLUDED.currency_code,
            account_timezone = EXCLUDED.account_timezone,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
         WHERE google_ads_connections.customer_id = EXCLUDED.customer_id
         RETURNING *`,
        [
            companyId,
            channelId,
            customerId,
            refreshTokenEncrypted,
            currencyCode,
            accountTimezone,
            actorId,
        ]
    );
    return rows[0] || null;
}

async function disconnectConnection(companyId, actorId = null, client = null) {
    requireCompanyId(companyId);
    const { rows } = await queryFor(client)(
        `UPDATE google_ads_connections
         SET status = 'disconnected',
             refresh_token_encrypted = NULL,
             sync_lease_expires_at = NULL,
             updated_by = $2,
             updated_at = NOW()
         WHERE company_id = $1
         RETURNING *`,
        [companyId, actorId]
    );
    return rows[0] || null;
}

async function requestSync(companyId, now = new Date(), client = null) {
    requireCompanyId(companyId);
    const { rows } = await queryFor(client)(
        `UPDATE google_ads_connections
         SET last_sync_status = CASE
                 WHEN sync_lease_expires_at >= $2::TIMESTAMPTZ
                 THEN last_sync_status
                 ELSE 'pending'
             END,
             last_error_code = CASE
                 WHEN sync_lease_expires_at >= $2::TIMESTAMPTZ
                 THEN last_error_code
                 ELSE NULL
             END,
             last_error = CASE
                 WHEN sync_lease_expires_at >= $2::TIMESTAMPTZ
                 THEN last_error
                 ELSE NULL
             END,
             updated_at = NOW()
         WHERE company_id = $1
           AND status = 'connected'
         RETURNING id, status, last_sync_status`,
        [companyId, now]
    );
    return rows[0] || null;
}

async function listDueConnections(now = new Date(), limit = 1, client = null) {
    const safeLimit = Math.max(1, Math.min(10, Number(limit) || 1));
    const { rows } = await queryFor(client)(
        `SELECT id, company_id
         FROM google_ads_connections
         WHERE status = 'connected'
           AND (
                sync_lease_expires_at IS NULL
                OR sync_lease_expires_at < $1::TIMESTAMPTZ
           )
           AND (
                last_sync_status IN ('pending', 'error')
                OR (
                    last_sync_status = 'running'
                    AND sync_lease_expires_at < $1::TIMESTAMPTZ
                )
                OR last_synced_at IS NULL
                OR last_synced_at < $1::TIMESTAMPTZ - INTERVAL '24 hours'
           )
         ORDER BY
            CASE WHEN last_sync_status = 'pending' THEN 0 ELSE 1 END,
            last_synced_at ASC NULLS FIRST,
            company_id
         LIMIT $2`,
        [now, safeLimit]
    );
    return rows;
}

async function claimConnection(
    companyId,
    connectionId,
    now,
    leaseExpiresAt,
    client = null
) {
    requireCompanyId(companyId);
    requireConnectionId(connectionId);
    const { rows } = await queryFor(client)(
        `UPDATE google_ads_connections
         SET last_sync_status = 'running',
             last_sync_started_at = $3::TIMESTAMPTZ,
             last_sync_finished_at = NULL,
             sync_lease_expires_at = $4::TIMESTAMPTZ,
             last_error_code = NULL,
             last_error = NULL,
             updated_at = NOW()
         WHERE company_id = $1
           AND id = $2
           AND status = 'connected'
           AND (
                sync_lease_expires_at IS NULL
                OR sync_lease_expires_at < $3::TIMESTAMPTZ
           )
         RETURNING *`,
        [companyId, connectionId, now, leaseExpiresAt]
    );
    return rows[0] || null;
}

async function refreshLease(
    companyId,
    connectionId,
    currentLeaseExpiresAt,
    leaseExpiresAt,
    client = null
) {
    requireCompanyId(companyId);
    requireConnectionId(connectionId);
    const { rowCount } = await queryFor(client)(
        `UPDATE google_ads_connections
         SET sync_lease_expires_at = $4::TIMESTAMPTZ,
             updated_at = NOW()
         WHERE company_id = $1
           AND id = $2
           AND status = 'connected'
           AND last_sync_status = 'running'
           AND sync_lease_expires_at = $3::TIMESTAMPTZ`,
        [companyId, connectionId, currentLeaseExpiresAt, leaseExpiresAt]
    );
    return rowCount > 0;
}

async function commitPerformanceChunk({
    companyId,
    connectionId,
    channelId,
    customerId,
    rows,
    chunkStart,
    chunkEnd,
    finished,
    now,
    expectedLeaseExpiresAt,
}) {
    requireCompanyId(companyId);
    requireConnectionId(connectionId);
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query(
            `SELECT id
             FROM google_ads_connections
             WHERE company_id = $1
               AND id = $2
               AND status = 'connected'
               AND last_sync_status = 'running'
               AND sync_lease_expires_at = $3::TIMESTAMPTZ
             FOR UPDATE`,
            [companyId, connectionId, expectedLeaseExpiresAt]
        );
        if (!locked.rows[0]) {
            const error = new Error('Google Ads sync claim is no longer active.');
            error.code = 'SYNC_CLAIM_LOST';
            throw error;
        }

        for (const row of rows) {
            await client.query(
                `INSERT INTO lead_source_performance_daily (
                    company_id,
                    provider_key,
                    external_account_id,
                    external_campaign_id,
                    external_campaign_name,
                    channel_id,
                    performance_date,
                    cost_micros,
                    impressions,
                    clicks,
                    conversions,
                    conversions_value
                 )
                 VALUES (
                    $1, 'google_ads', $2, $3, $4, $5, $6::DATE,
                    $7::BIGINT, $8::BIGINT, $9::BIGINT, $10::NUMERIC, $11::NUMERIC
                 )
                 ON CONFLICT (
                    company_id,
                    provider_key,
                    external_account_id,
                    external_campaign_id,
                    performance_date
                 ) DO UPDATE SET
                    external_campaign_name = EXCLUDED.external_campaign_name,
                    channel_id = EXCLUDED.channel_id,
                    cost_micros = EXCLUDED.cost_micros,
                    impressions = EXCLUDED.impressions,
                    clicks = EXCLUDED.clicks,
                    conversions = EXCLUDED.conversions,
                    conversions_value = EXCLUDED.conversions_value,
                    updated_at = NOW()`,
                [
                    companyId,
                    customerId,
                    row.external_campaign_id,
                    row.external_campaign_name,
                    channelId,
                    row.performance_date,
                    row.cost_micros,
                    row.impressions,
                    row.clicks,
                    row.conversions,
                    row.conversions_value,
                ]
            );
        }

        const updated = await client.query(
            `UPDATE google_ads_connections
             SET synced_from_date = LEAST(
                     COALESCE(synced_from_date, $3::DATE),
                     $3::DATE
                 ),
                 synced_through_date = GREATEST(
                     COALESCE(synced_through_date, $4::DATE),
                     $4::DATE
                 ),
                 last_sync_status = CASE WHEN $5 THEN 'ok' ELSE 'running' END,
                 last_sync_finished_at = CASE
                     WHEN $5 THEN $6::TIMESTAMPTZ
                     ELSE last_sync_finished_at
                 END,
                 last_synced_at = CASE
                     WHEN $5 THEN $6::TIMESTAMPTZ
                     ELSE last_synced_at
                 END,
                 sync_lease_expires_at = CASE
                     WHEN $5 THEN NULL
                     ELSE sync_lease_expires_at
                 END,
                 last_error_code = NULL,
                 last_error = NULL,
                 updated_at = NOW()
             WHERE company_id = $1
               AND id = $2
               AND status = 'connected'
               AND last_sync_status = 'running'
               AND sync_lease_expires_at = $7::TIMESTAMPTZ
             RETURNING *`,
            [
                companyId,
                connectionId,
                chunkStart,
                chunkEnd,
                finished,
                now,
                expectedLeaseExpiresAt,
            ]
        );
        if (!updated.rows[0]) {
            const error = new Error('Google Ads sync claim is no longer active.');
            error.code = 'SYNC_CLAIM_LOST';
            throw error;
        }
        await client.query('COMMIT');
        return updated.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function failSync({
    companyId,
    connectionId,
    connectionStatus,
    errorCode,
    errorMessage,
    now,
    expectedLeaseExpiresAt,
}, client = null) {
    requireCompanyId(companyId);
    requireConnectionId(connectionId);
    const { rows } = await queryFor(client)(
        `UPDATE google_ads_connections
         SET status = $3,
             last_sync_status = 'error',
             last_sync_finished_at = $6::TIMESTAMPTZ,
             sync_lease_expires_at = NULL,
             last_error_code = $4,
             last_error = $5,
             updated_at = NOW()
         WHERE company_id = $1
           AND id = $2
           AND status <> 'disconnected'
           AND sync_lease_expires_at = $7::TIMESTAMPTZ
         RETURNING *`,
        [
            companyId,
            connectionId,
            connectionStatus,
            errorCode,
            errorMessage,
            now,
            expectedLeaseExpiresAt,
        ]
    );
    return rows[0] || null;
}

module.exports = {
    claimConnection,
    commitPerformanceChunk,
    disconnectConnection,
    ensureGoogleAdsChannel,
    failSync,
    getConnectionByCompany,
    getConnectionById,
    listDueConnections,
    refreshLease,
    requestSync,
    upsertConnection,
};
