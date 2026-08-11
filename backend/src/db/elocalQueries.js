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

async function ensureElocalChannel(companyId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client);
    const { rows } = await query(
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
            'elocal',
            'eLocal',
            'eLocal pay-per-call acquisition and spend',
            '{"system":true,"provider_key":"elocal"}'::JSONB,
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
    await query(
        `WITH duplicate AS (
             SELECT id, channel_key
             FROM lead_source_channels
             WHERE company_id = $1
               AND channel_key IN (
                    'source_04a1ea464d394d519efd30a5988341f8',
                    'source_88cdf671ddacd95240fc98b1eef48ec2'
               )
         )
         UPDATE lead_source_aliases alias
         SET channel_id = $2,
             updated_at = NOW()
         FROM duplicate
         WHERE alias.company_id = $1
           AND alias.channel_id = duplicate.id
           AND (
              (duplicate.channel_key = 'source_04a1ea464d394d519efd30a5988341f8'
               AND alias.normalized_source = 'elocal')
              OR
              (duplicate.channel_key = 'source_88cdf671ddacd95240fc98b1eef48ec2'
               AND alias.normalized_source = 'elocals')
           )`,
        [companyId, rows[0].id]
    );
    await query(
        `UPDATE lead_source_channels
         SET is_active = false,
             metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
                 'merged_into_channel_key', 'elocal',
                 'elocal_attribution_001_merged', true
             ),
             updated_at = NOW()
         WHERE company_id = $1
           AND channel_key IN (
                'source_04a1ea464d394d519efd30a5988341f8',
                'source_88cdf671ddacd95240fc98b1eef48ec2'
           )`,
        [companyId]
    );
    return rows[0];
}

async function upsertConnection({
    companyId,
    channelId,
    campaignIds,
    apiKeyReference = 'ELOCAL_API_KEY',
}, client = null) {
    requireCompanyId(companyId);
    const { rows } = await queryFor(client)(
        `INSERT INTO elocal_connections (
            company_id,
            channel_id,
            campaign_ids,
            api_key_reference,
            status,
            last_sync_status
         )
         VALUES ($1, $2, $3::TEXT[], $4, 'connected', 'pending')
         ON CONFLICT (company_id) DO UPDATE SET
            channel_id = EXCLUDED.channel_id,
            campaign_ids = EXCLUDED.campaign_ids,
            api_key_reference = EXCLUDED.api_key_reference,
            status = 'connected',
            last_sync_status = 'pending',
            sync_lease_expires_at = NULL,
            last_error_code = NULL,
            last_error = NULL,
            updated_at = NOW()
         RETURNING *`,
        [companyId, channelId, campaignIds, apiKeyReference]
    );
    return rows[0];
}

async function listDueConnections(now = new Date(), limit = 1, client = null) {
    const safeLimit = Math.max(1, Math.min(10, Number(limit) || 1));
    const { rows } = await queryFor(client)(
        `SELECT id, company_id
         FROM elocal_connections
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
        `WITH claimed AS (
             UPDATE elocal_connections
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
             RETURNING *
         )
         SELECT claimed.*,
                COALESCE(NULLIF(company.timezone, ''), 'America/New_York')
                    AS company_timezone
         FROM claimed
         JOIN companies company
           ON company.id = claimed.company_id
         WHERE claimed.company_id = $1`,
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
        `UPDATE elocal_connections
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

async function commitCallsChunk({
    companyId,
    connectionId,
    rows,
    chunkStart,
    chunkEnd,
    now,
    expectedLeaseExpiresAt,
}) {
    requireCompanyId(companyId);
    requireConnectionId(connectionId);
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const lock = await client.query(
            `SELECT id
             FROM elocal_connections
             WHERE company_id = $1
               AND id = $2
               AND status = 'connected'
               AND last_sync_status = 'running'
               AND sync_lease_expires_at = $3::TIMESTAMPTZ
             FOR UPDATE`,
            [companyId, connectionId, expectedLeaseExpiresAt]
        );
        if (!lock.rows[0]) {
            const error = new Error('eLocal sync claim is no longer active.');
            error.code = 'SYNC_CLAIM_LOST';
            throw error;
        }

        for (const row of rows) {
            await client.query(
                `INSERT INTO elocal_leads (
                    company_id,
                    connection_id,
                    campaign_id,
                    external_call_id,
                    caller_phone_e164,
                    normalized_phone,
                    cost_cents,
                    supply_event_status,
                    supply_event_status_reason,
                    billable,
                    call_at,
                    service_zip_code,
                    service_city,
                    service_state_abbr,
                    campaign_name,
                    category_name,
                    call_duration_seconds,
                    call_quality_tags,
                    forwarding_number,
                    external_campaign_id,
                    lead_source_id,
                    first_seen_at,
                    last_seen_at
                 )
                 VALUES (
                    $1, $2, $3, $4, $5, $6, $7::BIGINT, $8, $9, $10,
                    $11::TIMESTAMPTZ, $12, $13, $14, $15, $16, $17,
                    $18::JSONB, $19, $20, $21, $22::TIMESTAMPTZ, $22::TIMESTAMPTZ
                 )
                 ON CONFLICT (company_id, external_call_id) DO UPDATE SET
                    connection_id = EXCLUDED.connection_id,
                    campaign_id = EXCLUDED.campaign_id,
                    caller_phone_e164 = EXCLUDED.caller_phone_e164,
                    normalized_phone = EXCLUDED.normalized_phone,
                    cost_cents = EXCLUDED.cost_cents,
                    supply_event_status = EXCLUDED.supply_event_status,
                    supply_event_status_reason = EXCLUDED.supply_event_status_reason,
                    billable = EXCLUDED.billable,
                    call_at = EXCLUDED.call_at,
                    service_zip_code = EXCLUDED.service_zip_code,
                    service_city = EXCLUDED.service_city,
                    service_state_abbr = EXCLUDED.service_state_abbr,
                    campaign_name = EXCLUDED.campaign_name,
                    category_name = EXCLUDED.category_name,
                    call_duration_seconds = EXCLUDED.call_duration_seconds,
                    call_quality_tags = EXCLUDED.call_quality_tags,
                    forwarding_number = EXCLUDED.forwarding_number,
                    external_campaign_id = EXCLUDED.external_campaign_id,
                    lead_source_id = EXCLUDED.lead_source_id,
                    last_seen_at = EXCLUDED.last_seen_at`,
                [
                    companyId,
                    connectionId,
                    row.campaign_id,
                    row.external_call_id,
                    row.caller_phone_e164,
                    row.normalized_phone,
                    row.cost_cents,
                    row.supply_event_status,
                    row.supply_event_status_reason,
                    row.billable,
                    row.call_at,
                    row.service_zip_code,
                    row.service_city,
                    row.service_state_abbr,
                    row.campaign_name,
                    row.category_name,
                    row.call_duration_seconds,
                    JSON.stringify(row.call_quality_tags || []),
                    row.forwarding_number,
                    row.external_campaign_id,
                    row.lead_source_id,
                    now,
                ]
            );
        }

        const updated = await client.query(
            `UPDATE elocal_connections
             SET synced_from_date = LEAST(
                     COALESCE(synced_from_date, $4::DATE),
                     $4::DATE
                 ),
                 synced_through_date = GREATEST(
                     COALESCE(synced_through_date, $5::DATE),
                     $5::DATE
                 ),
                 updated_at = NOW()
             WHERE company_id = $1
               AND id = $2
               AND status = 'connected'
               AND last_sync_status = 'running'
               AND sync_lease_expires_at = $3::TIMESTAMPTZ
             RETURNING id`,
            [
                companyId,
                connectionId,
                expectedLeaseExpiresAt,
                chunkStart,
                chunkEnd,
            ]
        );
        if (!updated.rows[0]) {
            const error = new Error('eLocal sync claim is no longer active.');
            error.code = 'SYNC_CLAIM_LOST';
            throw error;
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function listMatchableLeads(companyId, connectionId, client = null) {
    requireCompanyId(companyId);
    requireConnectionId(connectionId);
    const { rows } = await queryFor(client)(
        `SELECT
             id,
             normalized_phone,
             call_at AS provider_created_at
         FROM elocal_leads
         WHERE company_id = $1
           AND connection_id = $2
         ORDER BY call_at ASC, id ASC`,
        [companyId, connectionId]
    );
    return rows;
}

async function listMatchEvidence(companyId, connectionId, client = null) {
    requireCompanyId(companyId);
    requireConnectionId(connectionId);
    const { rows } = await queryFor(client)(
        `WITH target_elocal AS (
             SELECT id, normalized_phone, call_at AS provider_created_at
             FROM elocal_leads
             WHERE company_id = $1
               AND connection_id = $2
               AND normalized_phone IS NOT NULL
         ),
         phone_contacts AS (
             SELECT DISTINCT
                 contact.id AS contact_id,
                 phone.normalized_phone
             FROM contact_phones phone
             JOIN contacts contact
               ON contact.company_id = $1
              AND contact.id = phone.contact_id
              AND contact.deleted_at IS NULL
             WHERE phone.company_id = $1

             UNION

             SELECT DISTINCT
                 contact.id AS contact_id,
                 RIGHT(REGEXP_REPLACE(value.phone, '[^0-9]', '', 'g'), 10)
                     AS normalized_phone
             FROM contacts contact
             CROSS JOIN LATERAL (
                 VALUES (contact.phone_e164), (contact.secondary_phone)
             ) value(phone)
             WHERE contact.company_id = $1
               AND contact.deleted_at IS NULL
               AND LENGTH(REGEXP_REPLACE(COALESCE(value.phone, ''), '[^0-9]', '', 'g'))
                   >= 10
         ),
         nearby_calls AS (
             SELECT
                 provider.id AS elocal_lead_id,
                 crm_call.id AS call_id,
                 crm_call.contact_id,
                 COALESCE(crm_call.started_at, crm_call.created_at) AS evidence_at,
                 ABS(EXTRACT(EPOCH FROM (
                     COALESCE(crm_call.started_at, crm_call.created_at)
                     - provider.provider_created_at
                 ))) AS delta_seconds
             FROM target_elocal provider
             JOIN calls crm_call
               ON crm_call.company_id = $1
              AND LOWER(crm_call.direction) = 'inbound'
              AND RIGHT(
                    REGEXP_REPLACE(COALESCE(crm_call.from_number, ''), '[^0-9]', '', 'g'),
                    10
                  ) = provider.normalized_phone
              AND COALESCE(crm_call.started_at, crm_call.created_at)
                    BETWEEN provider.provider_created_at - INTERVAL '15 minutes'
                        AND provider.provider_created_at + INTERVAL '15 minutes'
         ),
         call_contact_candidates AS (
             SELECT
                 nearby.elocal_lead_id,
                 contact.id AS contact_id,
                 NULL::BIGINT AS crm_lead_id,
                 nearby.call_id,
                 'nearby_call_contact'::TEXT AS match_method,
                 100::SMALLINT AS match_confidence,
                 nearby.delta_seconds,
                 nearby.evidence_at
             FROM nearby_calls nearby
             JOIN contacts contact
               ON contact.company_id = $1
              AND contact.id = nearby.contact_id
              AND contact.deleted_at IS NULL
         ),
         call_phone_candidates AS (
             SELECT
                 nearby.elocal_lead_id,
                 phone_contact.contact_id,
                 NULL::BIGINT AS crm_lead_id,
                 nearby.call_id,
                 'nearby_call_phone'::TEXT AS match_method,
                 95::SMALLINT AS match_confidence,
                 nearby.delta_seconds,
                 nearby.evidence_at
             FROM nearby_calls nearby
             JOIN target_elocal provider
               ON provider.id = nearby.elocal_lead_id
             JOIN phone_contacts phone_contact
               ON phone_contact.normalized_phone = provider.normalized_phone
             WHERE nearby.contact_id IS NULL
         ),
         crm_lead_candidates AS (
             SELECT
                 provider.id AS elocal_lead_id,
                 crm_lead.contact_id,
                 crm_lead.id AS crm_lead_id,
                 NULL::BIGINT AS call_id,
                 'nearby_crm_lead_contact'::TEXT AS match_method,
                 90::SMALLINT AS match_confidence,
                 ABS(EXTRACT(EPOCH FROM (
                     crm_lead.created_at - provider.provider_created_at
                 ))) AS delta_seconds,
                 crm_lead.created_at AS evidence_at
             FROM target_elocal provider
             JOIN leads crm_lead
               ON crm_lead.company_id = $1
              AND crm_lead.contact_id IS NOT NULL
              AND (
                  RIGHT(
                      REGEXP_REPLACE(COALESCE(crm_lead.phone, ''), '[^0-9]', '', 'g'),
                      10
                  ) = provider.normalized_phone
                  OR RIGHT(
                      REGEXP_REPLACE(COALESCE(crm_lead.second_phone, ''), '[^0-9]', '', 'g'),
                      10
                  ) = provider.normalized_phone
              )
              AND crm_lead.created_at
                    BETWEEN provider.provider_created_at - INTERVAL '24 hours'
                        AND provider.provider_created_at + INTERVAL '24 hours'
             JOIN contacts contact
               ON contact.company_id = $1
              AND contact.id = crm_lead.contact_id
              AND contact.deleted_at IS NULL
         ),
         phone_only_candidates AS (
             SELECT
                 provider.id AS elocal_lead_id,
                 phone_contact.contact_id,
                 NULL::BIGINT AS crm_lead_id,
                 NULL::BIGINT AS call_id,
                 'phone_only'::TEXT AS match_method,
                 60::SMALLINT AS match_confidence,
                 NULL::NUMERIC AS delta_seconds,
                 NULL::TIMESTAMPTZ AS evidence_at
             FROM target_elocal provider
             JOIN phone_contacts phone_contact
               ON phone_contact.normalized_phone = provider.normalized_phone
         )
         SELECT * FROM call_contact_candidates
         UNION ALL
         SELECT * FROM call_phone_candidates
         UNION ALL
         SELECT * FROM crm_lead_candidates
         UNION ALL
         SELECT * FROM phone_only_candidates
         ORDER BY
             elocal_lead_id,
             match_confidence DESC,
             delta_seconds ASC NULLS LAST,
             contact_id,
             call_id NULLS LAST,
             crm_lead_id NULLS LAST`,
        [companyId, connectionId]
    );
    return rows;
}

async function listJobsForPhones(companyId, normalizedPhones, client = null) {
    requireCompanyId(companyId);
    if (!Array.isArray(normalizedPhones) || normalizedPhones.length === 0) return [];
    const { rows } = await queryFor(client)(
        `WITH requested_phones AS (
             SELECT DISTINCT UNNEST($2::TEXT[]) AS normalized_phone
         ),
         phone_contacts AS (
             SELECT DISTINCT
                 requested.normalized_phone,
                 contact.id AS contact_id
             FROM requested_phones requested
             JOIN contact_phones phone
               ON phone.company_id = $1
              AND phone.normalized_phone = requested.normalized_phone
             JOIN contacts contact
               ON contact.company_id = $1
              AND contact.id = phone.contact_id
              AND contact.deleted_at IS NULL

             UNION

             SELECT DISTINCT
                 requested.normalized_phone,
                 contact.id AS contact_id
             FROM requested_phones requested
             JOIN contacts contact
               ON contact.company_id = $1
              AND contact.deleted_at IS NULL
              AND (
                  RIGHT(
                      REGEXP_REPLACE(COALESCE(contact.phone_e164, ''), '[^0-9]', '', 'g'),
                      10
                  ) = requested.normalized_phone
                  OR RIGHT(
                      REGEXP_REPLACE(COALESCE(contact.secondary_phone, ''), '[^0-9]', '', 'g'),
                      10
                  ) = requested.normalized_phone
              )
         )
         SELECT DISTINCT ON (phone_contact.normalized_phone, job.id)
             phone_contact.normalized_phone,
             job.id AS job_id,
             job.contact_id,
             job.lead_id,
             COALESCE(crm_lead.created_at, job.created_at) AS acquired_at
         FROM phone_contacts phone_contact
         JOIN jobs job
           ON job.company_id = $1
          AND job.contact_id = phone_contact.contact_id
         LEFT JOIN leads crm_lead
           ON crm_lead.company_id = $1
          AND crm_lead.id = job.lead_id
         WHERE NOT EXISTS (
             SELECT 1
             FROM google_lsa_job_attributions lsa_attribution
             WHERE lsa_attribution.company_id = $1
               AND lsa_attribution.matched_job_id = job.id
               AND lsa_attribution.match_confidence >= 90
         )
         ORDER BY phone_contact.normalized_phone, job.id`,
        [companyId, normalizedPhones]
    );
    return rows;
}

async function replaceMatchResults({
    companyId,
    connectionId,
    expectedLeaseExpiresAt,
    results,
    attributions,
    now,
}) {
    requireCompanyId(companyId);
    requireConnectionId(connectionId);
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const lock = await client.query(
            `SELECT id
             FROM elocal_connections
             WHERE company_id = $1
               AND id = $2
               AND status = 'connected'
               AND last_sync_status = 'running'
               AND sync_lease_expires_at = $3::TIMESTAMPTZ
             FOR UPDATE`,
            [companyId, connectionId, expectedLeaseExpiresAt]
        );
        if (!lock.rows[0]) {
            const error = new Error('eLocal sync claim is no longer active.');
            error.code = 'SYNC_CLAIM_LOST';
            throw error;
        }

        await client.query(
            `DELETE FROM elocal_job_attributions attribution
             USING elocal_leads provider
             WHERE attribution.company_id = $1
               AND provider.company_id = $1
               AND provider.connection_id = $2
               AND attribution.elocal_lead_id = provider.id`,
            [companyId, connectionId]
        );

        for (const result of results) {
            await client.query(
                `UPDATE elocal_leads
                 SET match_status = $4,
                     matched_contact_id = $5,
                     matched_lead_id = $6,
                     matched_call_id = $7,
                     match_method = $8,
                     match_confidence = $9,
                     matched_at = $10::TIMESTAMPTZ,
                     last_match_attempt_at = $11::TIMESTAMPTZ,
                     match_version = $12
                 WHERE company_id = $1
                   AND connection_id = $2
                   AND id = $3`,
                [
                    companyId,
                    connectionId,
                    result.elocalLeadId,
                    result.matchStatus,
                    result.matchedContactId,
                    result.matchedLeadId,
                    result.matchedCallId,
                    result.matchMethod,
                    result.matchConfidence,
                    result.matchedAt,
                    now,
                    result.matchVersion,
                ]
            );
        }

        for (const attribution of attributions) {
            await client.query(
                `INSERT INTO elocal_job_attributions (
                    company_id,
                    elocal_lead_id,
                    matched_job_id,
                    matched_contact_id,
                    evidence_call_id,
                    evidence_lead_id,
                    match_method,
                    match_confidence,
                    matched_at
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::TIMESTAMPTZ)`,
                [
                    companyId,
                    attribution.elocalLeadId,
                    attribution.matchedJobId,
                    attribution.matchedContactId,
                    attribution.evidenceCallId,
                    attribution.evidenceLeadId,
                    attribution.matchMethod,
                    attribution.matchConfidence,
                    now,
                ]
            );
        }

        const updated = await client.query(
            `UPDATE elocal_connections
             SET last_matched_at = $4::TIMESTAMPTZ,
                 updated_at = NOW()
             WHERE company_id = $1
               AND id = $2
               AND status = 'connected'
               AND last_sync_status = 'running'
               AND sync_lease_expires_at = $3::TIMESTAMPTZ
             RETURNING id`,
            [companyId, connectionId, expectedLeaseExpiresAt, now]
        );
        if (!updated.rows[0]) {
            const error = new Error('eLocal sync claim is no longer active.');
            error.code = 'SYNC_CLAIM_LOST';
            throw error;
        }
        await client.query('COMMIT');
        return {
            matchedLeads: results.filter(result => result.matchStatus === 'matched').length,
            attributedJobs: attributions.length,
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function completeSync({
    companyId,
    connectionId,
    callCount,
    webLeadCount,
    now,
    expectedLeaseExpiresAt,
}, client = null) {
    requireCompanyId(companyId);
    requireConnectionId(connectionId);
    const { rows } = await queryFor(client)(
        `UPDATE elocal_connections
         SET last_sync_status = 'ok',
             last_sync_finished_at = $4::TIMESTAMPTZ,
             last_synced_at = $4::TIMESTAMPTZ,
             sync_lease_expires_at = NULL,
             last_call_count = $5,
             last_web_lead_count = $6,
             last_error_code = NULL,
             last_error = NULL,
             updated_at = NOW()
         WHERE company_id = $1
           AND id = $2
           AND status = 'connected'
           AND last_sync_status = 'running'
           AND sync_lease_expires_at = $3::TIMESTAMPTZ
         RETURNING *`,
        [
            companyId,
            connectionId,
            expectedLeaseExpiresAt,
            now,
            callCount,
            webLeadCount,
        ]
    );
    if (!rows[0]) {
        const error = new Error('eLocal sync claim is no longer active.');
        error.code = 'SYNC_CLAIM_LOST';
        throw error;
    }
    return rows[0];
}

async function failSync({
    companyId,
    connectionId,
    errorCode,
    errorMessage,
    now,
    expectedLeaseExpiresAt,
}, client = null) {
    requireCompanyId(companyId);
    requireConnectionId(connectionId);
    const { rows } = await queryFor(client)(
        `UPDATE elocal_connections
         SET last_sync_status = 'error',
             last_sync_finished_at = $4::TIMESTAMPTZ,
             sync_lease_expires_at = NULL,
             last_error_code = $5,
             last_error = $6,
             updated_at = NOW()
         WHERE company_id = $1
           AND id = $2
           AND status = 'connected'
           AND last_sync_status = 'running'
           AND sync_lease_expires_at = $3::TIMESTAMPTZ
         RETURNING *`,
        [
            companyId,
            connectionId,
            expectedLeaseExpiresAt,
            now,
            errorCode,
            errorMessage,
        ]
    );
    return rows[0] || null;
}

module.exports = {
    claimConnection,
    commitCallsChunk,
    completeSync,
    ensureElocalChannel,
    failSync,
    listDueConnections,
    listJobsForPhones,
    listMatchableLeads,
    listMatchEvidence,
    refreshLease,
    replaceMatchResults,
    upsertConnection,
};
