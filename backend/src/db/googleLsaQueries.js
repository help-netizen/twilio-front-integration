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

async function listMatchableLeads(companyId, connectionId, client = null) {
    requireCompanyId(companyId);
    requireConnectionId(connectionId);
    const { rows } = await queryFor(client)(
        `SELECT
             id,
             lead_type,
             normalized_phone,
             provider_created_at
         FROM google_lsa_leads
         WHERE company_id = $1
           AND connection_id = $2
         ORDER BY provider_created_at ASC, id ASC`,
        [companyId, connectionId]
    );
    return rows;
}

async function listMatchEvidence(companyId, connectionId, client = null) {
    requireCompanyId(companyId);
    requireConnectionId(connectionId);
    const { rows } = await queryFor(client)(
        `WITH target_lsa AS (
             SELECT id, normalized_phone, provider_created_at
             FROM google_lsa_leads
             WHERE company_id = $1
               AND connection_id = $2
               AND lead_type = 'PHONE_CALL'
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
                 lsa.id AS lsa_lead_id,
                 call.id AS call_id,
                 call.contact_id,
                 COALESCE(call.started_at, call.created_at) AS evidence_at,
                 ABS(EXTRACT(EPOCH FROM (
                     COALESCE(call.started_at, call.created_at)
                     - lsa.provider_created_at
                 ))) AS delta_seconds
             FROM target_lsa lsa
             JOIN calls call
               ON call.company_id = $1
              AND LOWER(call.direction) = 'inbound'
              AND RIGHT(
                    REGEXP_REPLACE(COALESCE(call.from_number, ''), '[^0-9]', '', 'g'),
                    10
                  ) = lsa.normalized_phone
              AND COALESCE(call.started_at, call.created_at)
                    BETWEEN lsa.provider_created_at - INTERVAL '15 minutes'
                        AND lsa.provider_created_at + INTERVAL '15 minutes'
         ),
         call_contact_candidates AS (
             SELECT
                 nearby.lsa_lead_id,
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
                 nearby.lsa_lead_id,
                 phone_contact.contact_id,
                 NULL::BIGINT AS crm_lead_id,
                 nearby.call_id,
                 'nearby_call_phone'::TEXT AS match_method,
                 95::SMALLINT AS match_confidence,
                 nearby.delta_seconds,
                 nearby.evidence_at
             FROM nearby_calls nearby
             JOIN target_lsa lsa
               ON lsa.id = nearby.lsa_lead_id
             JOIN phone_contacts phone_contact
               ON phone_contact.normalized_phone = lsa.normalized_phone
             WHERE nearby.contact_id IS NULL
         ),
         crm_lead_candidates AS (
             SELECT
                 lsa.id AS lsa_lead_id,
                 crm_lead.contact_id,
                 crm_lead.id AS crm_lead_id,
                 NULL::BIGINT AS call_id,
                 'nearby_crm_lead_contact'::TEXT AS match_method,
                 90::SMALLINT AS match_confidence,
                 ABS(EXTRACT(EPOCH FROM (
                     crm_lead.created_at - lsa.provider_created_at
                 ))) AS delta_seconds,
                 crm_lead.created_at AS evidence_at
             FROM target_lsa lsa
             JOIN leads crm_lead
               ON crm_lead.company_id = $1
              AND crm_lead.contact_id IS NOT NULL
              AND (
                  RIGHT(
                      REGEXP_REPLACE(COALESCE(crm_lead.phone, ''), '[^0-9]', '', 'g'),
                      10
                  ) = lsa.normalized_phone
                  OR RIGHT(
                      REGEXP_REPLACE(COALESCE(crm_lead.second_phone, ''), '[^0-9]', '', 'g'),
                      10
                  ) = lsa.normalized_phone
              )
              AND crm_lead.created_at
                    BETWEEN lsa.provider_created_at - INTERVAL '24 hours'
                        AND lsa.provider_created_at + INTERVAL '24 hours'
             JOIN contacts contact
               ON contact.company_id = $1
              AND contact.id = crm_lead.contact_id
              AND contact.deleted_at IS NULL
         ),
         phone_only_candidates AS (
             SELECT
                 lsa.id AS lsa_lead_id,
                 phone_contact.contact_id,
                 NULL::BIGINT AS crm_lead_id,
                 NULL::BIGINT AS call_id,
                 'phone_only'::TEXT AS match_method,
                 60::SMALLINT AS match_confidence,
                 NULL::NUMERIC AS delta_seconds,
                 NULL::TIMESTAMPTZ AS evidence_at
             FROM target_lsa lsa
             JOIN phone_contacts phone_contact
               ON phone_contact.normalized_phone = lsa.normalized_phone
         )
         SELECT * FROM call_contact_candidates
         UNION ALL
         SELECT * FROM call_phone_candidates
         UNION ALL
         SELECT * FROM crm_lead_candidates
         UNION ALL
         SELECT * FROM phone_only_candidates
         ORDER BY
             lsa_lead_id,
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
             FROM google_ads_connections
             WHERE company_id = $1
               AND id = $2
               AND status = 'connected'
               AND last_sync_status = 'running'
               AND sync_lease_expires_at = $3::TIMESTAMPTZ
             FOR UPDATE`,
            [companyId, connectionId, expectedLeaseExpiresAt]
        );
        if (!lock.rows[0]) {
            const error = new Error('Google Ads sync claim is no longer active.');
            error.code = 'SYNC_CLAIM_LOST';
            throw error;
        }

        await client.query(
            `DELETE FROM google_lsa_job_attributions attribution
             USING google_lsa_leads lsa
             WHERE attribution.company_id = $1
               AND lsa.company_id = $1
               AND lsa.connection_id = $2
               AND attribution.lsa_lead_id = lsa.id`,
            [companyId, connectionId]
        );

        for (const result of results) {
            await client.query(
                `UPDATE google_lsa_leads
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
                    result.lsaLeadId,
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
                `INSERT INTO google_lsa_job_attributions (
                    company_id,
                    lsa_lead_id,
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
                    attribution.lsaLeadId,
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
            `UPDATE google_ads_connections
             SET lsa_last_matched_at = $4::TIMESTAMPTZ,
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
            const error = new Error('Google Ads sync claim is no longer active.');
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

module.exports = {
    listJobsForPhones,
    listMatchableLeads,
    listMatchEvidence,
    replaceMatchResults,
};
