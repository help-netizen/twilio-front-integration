'use strict';

/**
 * LEAD-CHANNEL-ANALYTICS-001 Chunk 1b
 *
 * Fresh tenant-safe acquisition-cohort analytics. This intentionally does not
 * reuse analyticsService.js (F014).
 */

const db = require('../db/connection');

const DEFAULT_TIMEZONE = 'America/New_York';
const MAX_RANGE_DAYS = 731;
const VALID_DIMENSIONS = new Set(['channel', 'area', 'technician']);
const COUNT_PRECISION = 10000;

class LeadChannelAnalyticsError extends Error {
    constructor(code, message, httpStatus = 400) {
        super(message);
        this.name = 'LeadChannelAnalyticsError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function parsePeriod(from, to) {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(from || '') || !datePattern.test(to || '')) {
        throw new LeadChannelAnalyticsError(
            'INVALID_PERIOD',
            'from and to are required in YYYY-MM-DD format'
        );
    }

    const validCalendarDate = value => {
        const [year, month, day] = value.split('-').map(Number);
        const parsed = new Date(Date.UTC(year, month - 1, day));
        return parsed.getUTCFullYear() === year
            && parsed.getUTCMonth() === month - 1
            && parsed.getUTCDate() === day;
    };

    if (!validCalendarDate(from) || !validCalendarDate(to)) {
        throw new LeadChannelAnalyticsError(
            'INVALID_PERIOD',
            'from and to must be valid calendar dates'
        );
    }
    if (to < from) {
        throw new LeadChannelAnalyticsError(
            'INVALID_PERIOD',
            'to must be on or after from'
        );
    }

    const utcTime = value => {
        const [year, month, day] = value.split('-').map(Number);
        return Date.UTC(year, month - 1, day);
    };
    const inclusiveDays = (
        (utcTime(to) - utcTime(from)) / (24 * 60 * 60 * 1000)
    ) + 1;
    if (inclusiveDays > MAX_RANGE_DAYS) {
        throw new LeadChannelAnalyticsError(
            'RANGE_TOO_WIDE',
            'date range must not exceed 731 days',
            400
        );
    }
    return { from, to };
}

function requireCompanyId(companyId) {
    if (!companyId) {
        throw new LeadChannelAnalyticsError(
            'TENANT_CONTEXT_REQUIRED',
            'A company context is required',
            403
        );
    }
}

async function getCompanyTimezone(companyId) {
    requireCompanyId(companyId);
    const { rows } = await db.query(
        `SELECT COALESCE(NULLIF(timezone, ''), $2) AS timezone
         FROM companies
         WHERE id = $1`,
        [companyId, DEFAULT_TIMEZONE]
    );
    return rows[0]?.timezone || DEFAULT_TIMEZONE;
}

const COHORT_FACTS_SQL = `
    WITH company_context AS (
        SELECT
            id,
            COALESCE(NULLIF(timezone, ''), $4) AS timezone
        FROM companies
        WHERE id = $1
    ),
    google_channel AS (
        SELECT
            ch.id,
            ch.channel_key,
            ch.display_name
        FROM lead_source_channels ch
        JOIN company_context cc
          ON cc.id = ch.company_id
        WHERE ch.company_id = $1
          AND ch.channel_key = 'google_ads'
          AND ch.is_active = true
    ),
    elocal_channel AS (
        SELECT
            ch.id,
            ch.channel_key,
            ch.display_name
        FROM lead_source_channels ch
        JOIN company_context cc
          ON cc.id = ch.company_id
        WHERE ch.company_id = $1
          AND ch.channel_key = 'elocal'
          AND ch.is_active = true
    ),
    lead_cohort AS (
        SELECT
            l.id,
            l.contact_id,
            l.created_at,
            (
                l.converted_at IS NOT NULL
                OR l.converted_to_job = true
                OR LOWER(BTRIM(COALESCE(l.status, ''))) = 'converted'
                OR EXISTS (
                    SELECT 1
                    FROM jobs converted_job
                    WHERE converted_job.company_id = $1
                      AND converted_job.lead_id = l.id
                )
            ) AS converted,
            CASE
                WHEN lsa_evidence.has_lsa THEN gch.id
                WHEN elocal_evidence.has_elocal THEN ech.id
                WHEN l.gclid IS NOT NULL AND gch.id IS NOT NULL THEN gch.id
                ELSE ch.id
            END AS channel_id,
            COALESCE(
                CASE
                    WHEN lsa_evidence.has_lsa THEN 'google_ads'
                    WHEN elocal_evidence.has_elocal THEN 'elocal'
                    WHEN l.gclid IS NOT NULL AND gch.id IS NOT NULL
                        THEN gch.channel_key
                END,
                ch.channel_key,
                'unattributed'
            ) AS channel_key,
            COALESCE(
                CASE
                    WHEN lsa_evidence.has_lsa THEN 'Google Ads'
                    WHEN elocal_evidence.has_elocal THEN 'eLocal'
                    WHEN l.gclid IS NOT NULL AND gch.id IS NOT NULL
                        THEN gch.display_name
                END,
                ch.display_name,
                'Unattributed'
            ) AS channel_label,
            (
                lsa_evidence.has_lsa
                OR elocal_evidence.has_elocal
                OR (
                    CASE
                        WHEN l.gclid IS NOT NULL AND gch.id IS NOT NULL
                            THEN gch.id
                        ELSE ch.id
                    END IS NOT NULL
                    AND COALESCE(
                        CASE
                            WHEN l.gclid IS NOT NULL AND gch.id IS NOT NULL
                                THEN gch.channel_key
                        END,
                        ch.channel_key,
                        'unattributed'
                    ) <> 'unattributed'
                )
            ) AS channel_attributed,
            CASE
                WHEN NULLIF(BTRIM(st.area), '') IS NULL
                    THEN 'outside_configured_area'
                ELSE 'area_' || MD5(LOWER(BTRIM(st.area)))
            END AS area_key,
            CASE
                WHEN NULLIF(BTRIM(st.area), '') IS NULL
                    THEN 'Outside configured areas'
                ELSE BTRIM(st.area)
            END AS area_label
        FROM leads l
        JOIN company_context cc
          ON cc.id = l.company_id
        LEFT JOIN lead_source_aliases lsa
          ON lsa.company_id = $1
         AND lsa.normalized_source = LOWER(BTRIM(COALESCE(l.job_source, '')))
        LEFT JOIN lead_source_channels ch
          ON ch.company_id = $1
         AND ch.id = lsa.channel_id
         AND ch.is_active = true
        LEFT JOIN google_channel gch
          ON true
        LEFT JOIN elocal_channel ech
          ON true
        LEFT JOIN LATERAL (
            SELECT true AS has_lsa
            FROM jobs attributed_job
            JOIN google_lsa_job_attributions attribution
              ON attribution.company_id = $1
             AND attribution.matched_job_id = attributed_job.id
             AND attribution.match_confidence >= 90
            WHERE attributed_job.company_id = $1
              AND attributed_job.lead_id = l.id
            LIMIT 1
        ) lsa_evidence ON true
        LEFT JOIN LATERAL (
            SELECT true AS has_elocal
            FROM jobs attributed_job
            JOIN elocal_job_attributions attribution
              ON attribution.company_id = $1
             AND attribution.matched_job_id = attributed_job.id
             AND attribution.match_confidence >= 90
            WHERE attributed_job.company_id = $1
              AND attributed_job.lead_id = l.id
              AND NOT EXISTS (
                  SELECT 1
                  FROM google_lsa_job_attributions lsa_attribution
                  WHERE lsa_attribution.company_id = $1
                    AND lsa_attribution.matched_job_id = attributed_job.id
                    AND lsa_attribution.match_confidence >= 90
              )
            LIMIT 1
        ) elocal_evidence ON true
        LEFT JOIN service_territories st
          ON st.company_id = $1
         AND st.zip = SPLIT_PART(BTRIM(COALESCE(l.postal_code, '')), '-', 1)
        WHERE l.company_id = $1
          AND l.created_at >= ($2::date AT TIME ZONE cc.timezone)
          AND l.created_at < (($3::date + 1) AT TIME ZONE cc.timezone)
    ),
    lsa_jobs AS (
        SELECT
            j.id AS job_id,
            j.lead_id,
            j.contact_id,
            gch.id AS channel_id,
            'google_ads'::TEXT AS channel_key,
            'Google Ads'::TEXT AS channel_label,
            true AS channel_attributed,
            CASE
                WHEN NULLIF(BTRIM(st.area), '') IS NULL
                    THEN 'outside_configured_area'
                ELSE 'area_' || MD5(LOWER(BTRIM(st.area)))
            END AS area_key,
            CASE
                WHEN NULLIF(BTRIM(st.area), '') IS NULL
                    THEN 'Outside configured areas'
                ELSE BTRIM(st.area)
            END AS area_label,
            'google_lsa'::TEXT AS attribution_source,
            j.visit_completed_at,
            j.repair_done_at,
            j.blanc_status,
            j.zb_status,
            j.assigned_provider_user_ids
        FROM google_lsa_job_attributions attribution
        JOIN google_lsa_leads lsa_lead
          ON lsa_lead.company_id = $1
         AND lsa_lead.id = attribution.lsa_lead_id
        JOIN jobs j
          ON j.company_id = $1
         AND j.id = attribution.matched_job_id
        JOIN company_context cc
          ON cc.id = lsa_lead.company_id
        LEFT JOIN google_channel gch
          ON true
        LEFT JOIN leads owning_lead
          ON owning_lead.company_id = $1
         AND owning_lead.id = j.lead_id
        LEFT JOIN service_territories st
          ON st.company_id = $1
         AND st.zip = SPLIT_PART(
             BTRIM(COALESCE(owning_lead.postal_code, '')),
             '-',
             1
         )
        WHERE attribution.company_id = $1
          AND attribution.match_confidence >= 90
          AND lsa_lead.lead_type = 'PHONE_CALL'
          AND lsa_lead.provider_created_at
                >= ($2::date AT TIME ZONE cc.timezone)
          AND lsa_lead.provider_created_at
                < (($3::date + 1) AT TIME ZONE cc.timezone)
    ),
    elocal_jobs AS (
        SELECT
            j.id AS job_id,
            j.lead_id,
            j.contact_id,
            ech.id AS channel_id,
            'elocal'::TEXT AS channel_key,
            'eLocal'::TEXT AS channel_label,
            true AS channel_attributed,
            CASE
                WHEN NULLIF(BTRIM(st.area), '') IS NULL
                    THEN 'outside_configured_area'
                ELSE 'area_' || MD5(LOWER(BTRIM(st.area)))
            END AS area_key,
            CASE
                WHEN NULLIF(BTRIM(st.area), '') IS NULL
                    THEN 'Outside configured areas'
                ELSE BTRIM(st.area)
            END AS area_label,
            'elocal'::TEXT AS attribution_source,
            j.visit_completed_at,
            j.repair_done_at,
            j.blanc_status,
            j.zb_status,
            j.assigned_provider_user_ids
        FROM elocal_job_attributions attribution
        JOIN elocal_leads provider_lead
          ON provider_lead.company_id = $1
         AND provider_lead.id = attribution.elocal_lead_id
        JOIN jobs j
          ON j.company_id = $1
         AND j.id = attribution.matched_job_id
        JOIN company_context cc
          ON cc.id = provider_lead.company_id
        LEFT JOIN elocal_channel ech
          ON true
        LEFT JOIN leads owning_lead
          ON owning_lead.company_id = $1
         AND owning_lead.id = j.lead_id
        LEFT JOIN service_territories st
          ON st.company_id = $1
         AND st.zip = SPLIT_PART(
             BTRIM(COALESCE(owning_lead.postal_code, '')),
             '-',
             1
         )
        WHERE attribution.company_id = $1
          AND attribution.match_confidence >= 90
          AND provider_lead.call_at
                >= ($2::date AT TIME ZONE cc.timezone)
          AND provider_lead.call_at
                < (($3::date + 1) AT TIME ZONE cc.timezone)
          AND NOT EXISTS (
              SELECT 1
              FROM google_lsa_job_attributions lsa_attribution
              WHERE lsa_attribution.company_id = $1
                AND lsa_attribution.matched_job_id = j.id
                AND lsa_attribution.match_confidence >= 90
          )
    ),
    fallback_jobs AS (
        SELECT
            j.id AS job_id,
            j.lead_id,
            j.contact_id,
            c.channel_id,
            c.channel_key,
            c.channel_label,
            c.channel_attributed,
            c.area_key,
            c.area_label,
            'fallback'::TEXT AS attribution_source,
            j.visit_completed_at,
            j.repair_done_at,
            j.blanc_status,
            j.zb_status,
            j.assigned_provider_user_ids
        FROM jobs j
        JOIN lead_cohort c
          ON c.id = j.lead_id
        WHERE j.company_id = $1
          AND NOT EXISTS (
              SELECT 1
              FROM google_lsa_job_attributions attribution
              WHERE attribution.company_id = $1
                AND attribution.matched_job_id = j.id
                AND attribution.match_confidence >= 90
          )
          AND NOT EXISTS (
              SELECT 1
              FROM elocal_job_attributions attribution
              WHERE attribution.company_id = $1
                AND attribution.matched_job_id = j.id
                AND attribution.match_confidence >= 90
          )
    ),
    job_acquisition AS (
        SELECT * FROM lsa_jobs
        UNION ALL
        SELECT * FROM elocal_jobs
        UNION ALL
        SELECT * FROM fallback_jobs
    ),
    revenue_by_job AS (
        SELECT
            ja.job_id,
            ROUND(
                (
                    SUM(
                        CASE
                            WHEN pt.transaction_type = 'payment'
                                 AND pt.status = 'completed'
                                THEN pt.amount
                            ELSE 0
                        END
                    )
                    -
                    SUM(
                        CASE
                            WHEN pt.transaction_type = 'refund'
                                 AND pt.status = 'completed'
                                THEN ABS(pt.amount)
                            ELSE 0
                        END
                    )
                ) * 100
            )::bigint AS revenue_net_cents
        FROM job_acquisition ja
        LEFT JOIN payment_transactions pt
          ON pt.company_id = $1
         AND pt.job_id = ja.job_id
         AND pt.voided_at IS NULL
        GROUP BY ja.job_id
    ),
    company_calls AS (
        SELECT
            calls.id,
            calls.contact_id,
            COALESCE(calls.started_at, calls.created_at) AS occurred_at,
            calls.price
        FROM calls
        WHERE calls.company_id = $1
          AND calls.contact_id IS NOT NULL
          AND calls.price IS NOT NULL
    ),
    call_attribution AS (
        SELECT
            chosen.lead_id,
            cc.price
        FROM company_calls cc
        JOIN LATERAL (
            SELECT tenant_lead.id AS lead_id
            FROM leads tenant_lead
            WHERE tenant_lead.company_id = $1
              AND tenant_lead.contact_id = cc.contact_id
            ORDER BY
                ABS(EXTRACT(EPOCH FROM (cc.occurred_at - tenant_lead.created_at))),
                tenant_lead.created_at DESC,
                tenant_lead.id DESC
            LIMIT 1
        ) chosen ON true
        JOIN lead_cohort c
          ON c.id = chosen.lead_id
    ),
    call_cost_by_lead AS (
        SELECT
            ca.lead_id,
            ROUND(SUM(ABS(ca.price)) * 100)::bigint AS call_cost_cents
        FROM call_attribution ca
        GROUP BY ca.lead_id
    ),
    lead_job_technicians AS (
        SELECT DISTINCT
            j.lead_id,
            tech.tech_id
        FROM jobs j
        JOIN lead_cohort c
          ON c.id = j.lead_id
        CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
                WHEN jsonb_typeof(j.assigned_provider_user_ids) = 'array'
                    THEN j.assigned_provider_user_ids
                ELSE '[]'::jsonb
            END
        ) tech(tech_id)
        WHERE j.company_id = $1
          AND NULLIF(BTRIM(tech.tech_id), '') IS NOT NULL
    ),
    technicians_by_lead AS (
        SELECT
            jt.lead_id,
            jsonb_agg(
                jsonb_build_object(
                    'key', jt.tech_id,
                    'label', COALESCE(NULLIF(BTRIM(cu.full_name), ''),
                                      NULLIF(BTRIM(cu.email), ''),
                                      jt.tech_id)
                )
                ORDER BY jt.tech_id
            ) AS technicians
        FROM lead_job_technicians jt
        LEFT JOIN crm_users cu
          ON cu.company_id = $1
         AND cu.id::text = jt.tech_id
        GROUP BY jt.lead_id
    ),
    job_technicians AS (
        SELECT DISTINCT
            ja.job_id,
            tech.tech_id
        FROM job_acquisition ja
        CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
                WHEN jsonb_typeof(ja.assigned_provider_user_ids) = 'array'
                    THEN ja.assigned_provider_user_ids
                ELSE '[]'::jsonb
            END
        ) tech(tech_id)
        WHERE NULLIF(BTRIM(tech.tech_id), '') IS NOT NULL
    ),
    technicians_by_job AS (
        SELECT
            jt.job_id,
            jsonb_agg(
                jsonb_build_object(
                    'key', jt.tech_id,
                    'label', COALESCE(NULLIF(BTRIM(cu.full_name), ''),
                                      NULLIF(BTRIM(cu.email), ''),
                                      jt.tech_id)
                )
                ORDER BY jt.tech_id
            ) AS technicians
        FROM job_technicians jt
        LEFT JOIN crm_users cu
          ON cu.company_id = $1
         AND cu.id::text = jt.tech_id
        GROUP BY jt.job_id
    )
    SELECT
        'lead:' || c.id::TEXT AS id,
        1::INTEGER AS lead_count,
        CASE WHEN c.converted THEN 1 ELSE 0 END::INTEGER AS converted_count,
        c.channel_id,
        c.channel_key,
        c.channel_label,
        c.channel_attributed,
        c.area_key,
        c.area_label,
        0::INTEGER AS visit_completed_count,
        0::INTEGER AS jobs_done_count,
        0::BIGINT AS revenue_net_cents,
        COALESCE(ccbl.call_cost_cents, 0)::bigint AS call_cost_cents,
        0::BIGINT AS google_lsa_windowed_revenue_cents,
        0::BIGINT AS elocal_windowed_revenue_cents,
        COALESCE(tbl.technicians, '[]'::jsonb) AS technicians
    FROM lead_cohort c
    LEFT JOIN call_cost_by_lead ccbl
      ON ccbl.lead_id = c.id
    LEFT JOIN technicians_by_lead tbl
      ON tbl.lead_id = c.id
    UNION ALL
    SELECT
        'job:' || ja.job_id::TEXT AS id,
        0::INTEGER AS lead_count,
        0::INTEGER AS converted_count,
        ja.channel_id,
        ja.channel_key,
        ja.channel_label,
        ja.channel_attributed,
        ja.area_key,
        ja.area_label,
        CASE
            WHEN ja.visit_completed_at IS NOT NULL
              OR LOWER(REPLACE(BTRIM(COALESCE(ja.blanc_status, '')), '_', ' '))
                    IN ('visit completed', 'job is done')
              OR LOWER(REPLACE(BTRIM(COALESCE(ja.zb_status, '')), '_', '-'))
                    IN ('in-progress', 'complete')
                THEN 1
            ELSE 0
        END::INTEGER AS visit_completed_count,
        CASE
            WHEN ja.repair_done_at IS NOT NULL
              OR LOWER(REPLACE(BTRIM(COALESCE(ja.blanc_status, '')), '_', ' '))
                    = 'job is done'
              OR LOWER(BTRIM(COALESCE(ja.zb_status, ''))) = 'complete'
                THEN 1
            ELSE 0
        END::INTEGER AS jobs_done_count,
        COALESCE(rbj.revenue_net_cents, 0)::BIGINT AS revenue_net_cents,
        0::BIGINT AS call_cost_cents,
        CASE
            WHEN ja.attribution_source = 'google_lsa'
                THEN COALESCE(rbj.revenue_net_cents, 0)
            ELSE 0
        END::BIGINT AS google_lsa_windowed_revenue_cents,
        CASE
            WHEN ja.attribution_source = 'elocal'
                THEN COALESCE(rbj.revenue_net_cents, 0)
            ELSE 0
        END::BIGINT AS elocal_windowed_revenue_cents,
        COALESCE(tbj.technicians, '[]'::jsonb) AS technicians
    FROM job_acquisition ja
    LEFT JOIN revenue_by_job rbj
      ON rbj.job_id = ja.job_id
    LEFT JOIN technicians_by_job tbj
      ON tbj.job_id = ja.job_id
    ORDER BY id
`;

const LSA_LTV_SQL = `
    WITH company_context AS (
        SELECT
            id,
            COALESCE(NULLIF(timezone, ''), $4) AS timezone
        FROM companies
        WHERE id = $1
    ),
    lsa_cohort AS (
        SELECT
            lsa.id,
            lsa.matched_contact_id
        FROM google_lsa_leads lsa
        JOIN company_context cc
          ON cc.id = lsa.company_id
        WHERE lsa.company_id = $1
          AND lsa.lead_type = 'PHONE_CALL'
          AND lsa.match_status = 'matched'
          AND lsa.match_confidence >= 90
          AND lsa.matched_contact_id IS NOT NULL
          AND lsa.provider_created_at
                >= ($2::date AT TIME ZONE cc.timezone)
          AND lsa.provider_created_at
                < (($3::date + 1) AT TIME ZONE cc.timezone)
    ),
    acquired_contacts AS (
        SELECT cohort.matched_contact_id AS contact_id
        FROM lsa_cohort cohort
        UNION
        SELECT attribution.matched_contact_id AS contact_id
        FROM google_lsa_job_attributions attribution
        JOIN lsa_cohort cohort
          ON cohort.id = attribution.lsa_lead_id
        WHERE attribution.company_id = $1
          AND attribution.match_confidence >= 90
          AND attribution.matched_contact_id IS NOT NULL
    ),
    lifetime_jobs AS (
        SELECT j.id AS job_id
        FROM jobs j
        JOIN acquired_contacts acquired
          ON acquired.contact_id = j.contact_id
        WHERE j.company_id = $1
        UNION
        SELECT attribution.matched_job_id AS job_id
        FROM google_lsa_job_attributions attribution
        JOIN lsa_cohort cohort
          ON cohort.id = attribution.lsa_lead_id
        WHERE attribution.company_id = $1
          AND attribution.match_confidence >= 90
    )
    SELECT
        (
            SELECT ch.id
            FROM lead_source_channels ch
            WHERE ch.company_id = $1
              AND ch.channel_key = 'google_ads'
              AND ch.is_active = true
            LIMIT 1
        ) AS channel_id,
        COALESCE(
            ROUND(
                (
                    SUM(
                        CASE
                            WHEN pt.transaction_type = 'payment'
                             AND pt.status = 'completed'
                                THEN pt.amount
                            ELSE 0
                        END
                    )
                    -
                    SUM(
                        CASE
                            WHEN pt.transaction_type = 'refund'
                             AND pt.status = 'completed'
                                THEN ABS(pt.amount)
                            ELSE 0
                        END
                    )
                ) * 100
            ),
            0
        )::BIGINT AS revenue_net_cents
    FROM lifetime_jobs lifetime_job
    LEFT JOIN payment_transactions pt
      ON pt.company_id = $1
     AND pt.job_id = lifetime_job.job_id
     AND pt.voided_at IS NULL
`;

const ELOCAL_METRICS_SQL = `
    WITH company_context AS (
        SELECT
            id,
            COALESCE(NULLIF(timezone, ''), $4) AS timezone
        FROM companies
        WHERE id = $1
    ),
    provider_cohort AS (
        SELECT
            provider.id,
            provider.cost_cents,
            provider.billable,
            provider.match_status
        FROM elocal_leads provider
        JOIN company_context cc
          ON cc.id = provider.company_id
        WHERE provider.company_id = $1
          AND provider.call_at >= ($2::date AT TIME ZONE cc.timezone)
          AND provider.call_at < (($3::date + 1) AT TIME ZONE cc.timezone)
    ),
    eligible_attributions AS (
        SELECT DISTINCT
            attribution.elocal_lead_id,
            attribution.matched_job_id
        FROM elocal_job_attributions attribution
        JOIN provider_cohort cohort
          ON cohort.id = attribution.elocal_lead_id
        WHERE attribution.company_id = $1
          AND attribution.match_confidence >= 90
          AND NOT EXISTS (
              SELECT 1
              FROM google_lsa_job_attributions lsa_attribution
              WHERE lsa_attribution.company_id = $1
                AND lsa_attribution.matched_job_id = attribution.matched_job_id
                AND lsa_attribution.match_confidence >= 90
          )
    ),
    provider_summary AS (
        SELECT
            COUNT(*)::INTEGER AS call_count,
            COUNT(*) FILTER (WHERE cohort.billable)::INTEGER
                AS billable_call_count,
            COUNT(*) FILTER (WHERE NOT cohort.billable)::INTEGER
                AS unbillable_call_count,
            COUNT(*) FILTER (
                WHERE cohort.match_status = 'matched'
            )::INTEGER AS matched_call_count,
            COALESCE(
                SUM(cohort.cost_cents) FILTER (WHERE cohort.billable),
                0
            )::BIGINT AS billable_spend_cents
        FROM provider_cohort cohort
    ),
    conversion_summary AS (
        SELECT
            COUNT(DISTINCT eligible.elocal_lead_id)::INTEGER
                AS booked_conversion_count,
            COUNT(DISTINCT eligible.elocal_lead_id) FILTER (
                WHERE job.zb_status = 'complete'
                   OR LOWER(REPLACE(
                        BTRIM(COALESCE(job.blanc_status, '')),
                        '_',
                        ' '
                   )) = 'job is done'
            )::INTEGER AS completed_conversion_count
        FROM eligible_attributions eligible
        JOIN jobs job
          ON job.company_id = $1
         AND job.id = eligible.matched_job_id
    )
    SELECT
        (
            SELECT ch.id
            FROM lead_source_channels ch
            WHERE ch.company_id = $1
              AND ch.channel_key = 'elocal'
              AND ch.is_active = true
            LIMIT 1
        ) AS channel_id,
        provider.call_count,
        provider.billable_call_count,
        provider.unbillable_call_count,
        provider.matched_call_count,
        provider.billable_spend_cents,
        conversion.booked_conversion_count,
        conversion.completed_conversion_count
    FROM provider_summary provider
    CROSS JOIN conversion_summary conversion
`;

function asInteger(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? Math.round(number) : 0;
}

function normalizeTechnicians(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function normalizeFact(row) {
    return {
        id: row.id,
        leadCount: asInteger(row.lead_count),
        convertedCount: asInteger(row.converted_count),
        visitCompletedCount: asInteger(row.visit_completed_count),
        jobsDoneCount: asInteger(row.jobs_done_count),
        channelAttributed: row.channel_attributed === true,
        channel: {
            id: row.channel_id || null,
            key: row.channel_key,
            label: row.channel_label,
        },
        area: { key: row.area_key, label: row.area_label },
        technicians: normalizeTechnicians(row.technicians),
        revenueNetCents: asInteger(row.revenue_net_cents),
        callCostCents: asInteger(row.call_cost_cents),
        googleLsaWindowedRevenueCents: asInteger(
            row.google_lsa_windowed_revenue_cents
        ),
        elocalWindowedRevenueCents: asInteger(
            row.elocal_windowed_revenue_cents
        ),
    };
}

async function loadCohortFacts(companyId, period) {
    requireCompanyId(companyId);
    const { rows } = await db.query(
        COHORT_FACTS_SQL,
        [companyId, period.from, period.to, DEFAULT_TIMEZONE]
    );
    return rows.map(normalizeFact);
}

function emptyLsaLtvSnapshot() {
    return {
        channel_id: null,
        revenue_net_cents: 0,
    };
}

async function loadLsaLtvSnapshot(companyId, period) {
    requireCompanyId(companyId);
    const { rows } = await db.query(
        LSA_LTV_SQL,
        [companyId, period.from, period.to, DEFAULT_TIMEZONE]
    );
    return {
        channel_id: rows[0]?.channel_id || null,
        revenue_net_cents: asInteger(rows[0]?.revenue_net_cents),
    };
}

function emptyElocalSnapshot() {
    return {
        channel_id: null,
        call_count: 0,
        billable_call_count: 0,
        unbillable_call_count: 0,
        matched_call_count: 0,
        billable_spend_cents: 0,
        booked_conversion_count: 0,
        completed_conversion_count: 0,
    };
}

async function loadElocalSnapshot(companyId, period) {
    requireCompanyId(companyId);
    const { rows } = await db.query(
        ELOCAL_METRICS_SQL,
        [companyId, period.from, period.to, DEFAULT_TIMEZONE]
    );
    const row = rows[0];
    if (!row) return emptyElocalSnapshot();
    return {
        channel_id: row.channel_id || null,
        call_count: asInteger(row.call_count),
        billable_call_count: asInteger(row.billable_call_count),
        unbillable_call_count: asInteger(row.unbillable_call_count),
        matched_call_count: asInteger(row.matched_call_count),
        billable_spend_cents: asInteger(row.billable_spend_cents),
        booked_conversion_count: asInteger(row.booked_conversion_count),
        completed_conversion_count: asInteger(row.completed_conversion_count),
    };
}

function emptyCostSnapshot() {
    return {
        channels: [],
        total_cost_cents: 0,
        google_lsa_ad_spend_cents: 0,
        google_other_ad_spend_cents: 0,
        elocal_billable_ad_spend_cents: 0,
    };
}

async function loadCostSnapshot(companyId, period) {
    requireCompanyId(companyId);
    const result = await db.query(
        `WITH company_context AS (
             SELECT
                 id,
                 COALESCE(NULLIF(timezone, ''), $4) AS timezone
             FROM companies
             WHERE id = $1
         ),
         cost_rows AS (
             SELECT
                 perf.channel_id,
                 ch.channel_key,
                 ch.display_name AS channel_label,
                 COALESCE(ch.is_active, false) AS is_active,
                 ROUND(
                     SUM(perf.cost_micros)::numeric / 10000
                 )::bigint AS cost_cents,
                 ROUND(
                     SUM(
                         CASE
                             WHEN ch.channel_key = 'google_ads'
                              AND perf.external_campaign_name
                                    ILIKE '%localservices%'
                                 THEN perf.cost_micros
                             ELSE 0
                         END
                     )::numeric / 10000
                 )::bigint AS google_lsa_ad_spend_cents,
                 0::BIGINT AS elocal_billable_ad_spend_cents
             FROM lead_source_performance_daily perf
             LEFT JOIN lead_source_channels ch
               ON ch.company_id = $1
              AND ch.id = perf.channel_id
             WHERE perf.company_id = $1
               AND perf.performance_date >= $2::date
               AND perf.performance_date <= $3::date
               AND COALESCE(ch.channel_key, '') NOT IN (
                    'elocal',
                    'source_04a1ea464d394d519efd30a5988341f8',
                    'source_88cdf671ddacd95240fc98b1eef48ec2'
               )
             GROUP BY
                 perf.channel_id,
                 ch.channel_key,
                 ch.display_name,
                 ch.is_active
             UNION ALL
             SELECT
                 connection.channel_id,
                 ch.channel_key,
                 ch.display_name AS channel_label,
                 ch.is_active,
                 COALESCE(SUM(provider.cost_cents), 0)::BIGINT AS cost_cents,
                 0::BIGINT AS google_lsa_ad_spend_cents,
                 COALESCE(SUM(provider.cost_cents), 0)::BIGINT
                    AS elocal_billable_ad_spend_cents
             FROM elocal_leads provider
             JOIN elocal_connections connection
               ON connection.company_id = $1
              AND connection.id = provider.connection_id
             JOIN lead_source_channels ch
               ON ch.company_id = $1
              AND ch.id = connection.channel_id
             JOIN company_context cc
               ON cc.id = provider.company_id
             WHERE provider.company_id = $1
               AND provider.billable = true
               AND provider.call_at >= ($2::date AT TIME ZONE cc.timezone)
               AND provider.call_at < (($3::date + 1) AT TIME ZONE cc.timezone)
             GROUP BY
                 connection.channel_id,
                 ch.channel_key,
                 ch.display_name,
                 ch.is_active
         )
         SELECT
             channel_id,
             channel_key,
             channel_label,
             is_active,
             SUM(cost_cents)::BIGINT AS cost_cents,
             SUM(google_lsa_ad_spend_cents)::BIGINT
                AS google_lsa_ad_spend_cents,
             SUM(elocal_billable_ad_spend_cents)::BIGINT
                AS elocal_billable_ad_spend_cents
         FROM cost_rows
         GROUP BY channel_id, channel_key, channel_label, is_active
         ORDER BY channel_id`,
        [companyId, period.from, period.to, DEFAULT_TIMEZONE]
    );
    const rows = result?.rows || [];
    if (rows.length === 0) return emptyCostSnapshot();

    const channels = rows.map(row => ({
        channel_id: row.channel_id,
        channel_key: row.channel_key || null,
        channel_label: row.channel_label || null,
        is_active: row.is_active === true,
        cost_cents: asInteger(row.cost_cents),
        google_lsa_ad_spend_cents: asInteger(
            row.google_lsa_ad_spend_cents
        ),
        google_other_ad_spend_cents: row.channel_key === 'google_ads'
            ? asInteger(row.cost_cents) - asInteger(row.google_lsa_ad_spend_cents)
            : 0,
        elocal_billable_ad_spend_cents: asInteger(
            row.elocal_billable_ad_spend_cents
        ),
    }));
    return {
        channels,
        total_cost_cents: channels.reduce(
            (total, channel) => total + channel.cost_cents,
            0
        ),
        google_lsa_ad_spend_cents: channels.reduce(
            (total, channel) => total + channel.google_lsa_ad_spend_cents,
            0
        ),
        google_other_ad_spend_cents: channels.reduce(
            (total, channel) => total + channel.google_other_ad_spend_cents,
            0
        ),
        elocal_billable_ad_spend_cents: channels.reduce(
            (total, channel) => (
                total + channel.elocal_billable_ad_spend_cents
            ),
            0
        ),
    };
}

function normalizeDateOnly(value) {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
}

function normalizeTimestamp(value) {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : String(value);
}

async function loadConnectedSources(companyId) {
    requireCompanyId(companyId);
    const result = await db.query(
        `SELECT
             'google_ads'::TEXT AS key,
             'Google Ads'::TEXT AS label,
             status,
             last_synced_at,
             synced_from_date,
             synced_through_date
         FROM google_ads_connections
         WHERE company_id = $1
         UNION ALL
         SELECT
             'elocal'::TEXT AS key,
             'eLocal'::TEXT AS label,
             status,
             last_synced_at,
             synced_from_date,
             synced_through_date
         FROM elocal_connections
         WHERE company_id = $1
         ORDER BY key`,
        [companyId]
    );
    return (result?.rows || []).map(row => ({
        key: row.key,
        label: row.label,
        status: row.status,
        last_synced_at: normalizeTimestamp(row.last_synced_at),
        synced_from_date: normalizeDateOnly(row.synced_from_date),
        synced_through_date: normalizeDateOnly(row.synced_through_date),
    }));
}

function percent(numerator, denominator) {
    if (!denominator) return 0;
    return Math.round((numerator / denominator) * 10000) / 100;
}

function totalsForFacts(facts) {
    return facts.reduce((totals, fact) => {
        totals.leads += fact.leadCount;
        totals.converted += fact.convertedCount;
        totals.visitCompleted += fact.visitCompletedCount;
        totals.jobsDone += fact.jobsDoneCount;
        totals.revenueNetCents += fact.revenueNetCents;
        totals.callCostCents += fact.callCostCents;
        totals.googleLsaWindowedRevenueCents +=
            fact.googleLsaWindowedRevenueCents;
        totals.elocalWindowedRevenueCents +=
            fact.elocalWindowedRevenueCents;
        return totals;
    }, {
        leads: 0,
        converted: 0,
        visitCompleted: 0,
        jobsDone: 0,
        revenueNetCents: 0,
        callCostCents: 0,
        googleLsaWindowedRevenueCents: 0,
        elocalWindowedRevenueCents: 0,
    });
}

function roasFor(revenueNetCents, adSpendCents) {
    if (!adSpendCents) return null;
    return revenueNetCents / adSpendCents;
}

function cpaFor(adSpendCents, conversionCount) {
    if (!conversionCount) return null;
    return Math.round(adSpendCents / conversionCount);
}

function lsaKpis(
    windowedRevenueCents,
    ltvRevenueCents,
    costSnapshot = emptyCostSnapshot()
) {
    return {
        google_lsa_ad_spend_cents:
            costSnapshot.google_lsa_ad_spend_cents,
        google_other_ad_spend_cents:
            costSnapshot.google_other_ad_spend_cents,
        google_lsa_windowed_revenue_cents: windowedRevenueCents,
        google_lsa_ltv_cents: ltvRevenueCents,
        google_lsa_roas: roasFor(
            windowedRevenueCents,
            costSnapshot.google_lsa_ad_spend_cents
        ),
        google_lsa_ltv_roas: roasFor(
            ltvRevenueCents,
            costSnapshot.google_lsa_ad_spend_cents
        ),
    };
}

function elocalKpis(
    windowedRevenueCents,
    snapshot = emptyElocalSnapshot()
) {
    return {
        elocal_call_count: snapshot.call_count,
        elocal_billable_call_count: snapshot.billable_call_count,
        elocal_unbillable_call_count: snapshot.unbillable_call_count,
        elocal_matched_call_count: snapshot.matched_call_count,
        elocal_billable_ad_spend_cents: snapshot.billable_spend_cents,
        elocal_booked_conversions: snapshot.booked_conversion_count,
        elocal_completed_conversions: snapshot.completed_conversion_count,
        elocal_windowed_revenue_cents: windowedRevenueCents,
        elocal_cpa_booked_cents: cpaFor(
            snapshot.billable_spend_cents,
            snapshot.booked_conversion_count
        ),
        elocal_cpa_completed_cents: cpaFor(
            snapshot.billable_spend_cents,
            snapshot.completed_conversion_count
        ),
        elocal_roas: roasFor(
            windowedRevenueCents,
            snapshot.billable_spend_cents
        ),
    };
}

function summaryKpis(
    totals,
    costSnapshot = emptyCostSnapshot(),
    lsaLtvSnapshot = emptyLsaLtvSnapshot(),
    elocalSnapshot = emptyElocalSnapshot()
) {
    const adSpendCents = costSnapshot.total_cost_cents;
    return {
        leads: totals.leads,
        converted: totals.converted,
        visit_completed: totals.visitCompleted,
        jobs_done: totals.jobsDone,
        revenue_net_cents: totals.revenueNetCents,
        call_cost_cents: totals.callCostCents,
        ad_spend_cents: adSpendCents,
        roas: roasFor(totals.revenueNetCents, adSpendCents),
        marketing_contribution_cents:
            totals.revenueNetCents - totals.callCostCents - adSpendCents,
        ...lsaKpis(
            totals.googleLsaWindowedRevenueCents,
            lsaLtvSnapshot.revenue_net_cents,
            costSnapshot
        ),
        ...elocalKpis(
            totals.elocalWindowedRevenueCents,
            elocalSnapshot
        ),
    };
}

function funnelForTotals(totals) {
    return [
        {
            stage: 'leads',
            count: totals.leads,
            conv_pct: totals.leads ? 100 : 0,
        },
        {
            stage: 'converted',
            count: totals.converted,
            conv_pct: percent(totals.converted, totals.leads),
        },
        {
            stage: 'visit_completed',
            count: totals.visitCompleted,
            conv_pct: percent(totals.visitCompleted, totals.leads),
        },
        {
            stage: 'job_is_done',
            count: totals.jobsDone,
            conv_pct: percent(totals.jobsDone, totals.leads),
        },
    ];
}

async function getSummary(companyId, query = {}) {
    const period = parsePeriod(query.from, query.to);
    requireCompanyId(companyId);
    const [
        timezone,
        facts,
        costSnapshot,
        lsaLtvSnapshot,
        elocalSnapshot,
    ] = await Promise.all([
        getCompanyTimezone(companyId),
        loadCohortFacts(companyId, period),
        loadCostSnapshot(companyId, period),
        loadLsaLtvSnapshot(companyId, period),
        loadElocalSnapshot(companyId, period),
    ]);
    const totals = totalsForFacts(facts);
    return {
        kpis: summaryKpis(
            totals,
            costSnapshot,
            lsaLtvSnapshot,
            elocalSnapshot
        ),
        funnel: funnelForTotals(totals),
        period: { ...period, timezone },
    };
}

function targetsForFact(fact, dimension) {
    if (dimension === 'channel') return [fact.channel];
    if (dimension === 'area') return [fact.area];
    if (fact.technicians.length === 0) {
        return [{ key: 'unassigned', label: 'Unassigned' }];
    }
    return fact.technicians.map(technician => ({
        key: String(technician.key),
        label: String(technician.label || technician.key),
    }));
}

function emptyBreakdownAccumulator(target) {
    return {
        channelId: target.id || null,
        key: target.key,
        label: target.label,
        raw: {
            leads: 0,
            converted: 0,
            visitCompleted: 0,
            jobsDone: 0,
            revenueNetCents: 0,
            callCostCents: 0,
            adSpendCents: 0,
            googleLsaAdSpendCents: 0,
            googleOtherAdSpendCents: 0,
            googleLsaWindowedRevenueCents: 0,
            googleLsaLtvCents: 0,
            elocalCallCount: 0,
            elocalBillableCallCount: 0,
            elocalUnbillableCallCount: 0,
            elocalMatchedCallCount: 0,
            elocalBillableAdSpendCents: 0,
            elocalBookedConversions: 0,
            elocalCompletedConversions: 0,
            elocalWindowedRevenueCents: 0,
        },
        allocated: {},
    };
}

function allocateInteger(rows, rawKey, outputKey, targetTotal, scale = 1) {
    const provisional = rows.map(row => {
        const scaled = row.raw[rawKey] * scale;
        const base = Math.trunc(scaled);
        return {
            row,
            base,
            fraction: scaled - base,
        };
    });
    let residual = Math.round(targetTotal * scale)
        - provisional.reduce((sum, item) => sum + item.base, 0);

    provisional.sort((left, right) => {
        if (residual >= 0 && right.fraction !== left.fraction) {
            return right.fraction - left.fraction;
        }
        if (residual < 0 && right.fraction !== left.fraction) {
            return left.fraction - right.fraction;
        }
        return left.row.key.localeCompare(right.row.key);
    });

    let cursor = 0;
    while (residual !== 0 && provisional.length > 0) {
        provisional[cursor % provisional.length].base += residual > 0 ? 1 : -1;
        residual += residual > 0 ? -1 : 1;
        cursor++;
    }

    for (const item of provisional) {
        item.row.allocated[outputKey] = item.base / scale;
    }
}

function allocateAdSpendToFacts(facts, costSnapshot = emptyCostSnapshot()) {
    const allocatedFacts = facts.map(fact => ({
        ...fact,
        allocatedAdCostCents: 0,
    }));
    let allocatedCostCents = 0;
    let unallocatedCostCents = 0;

    for (const channelCost of costSnapshot.channels) {
        const eligibleFacts = allocatedFacts.filter(fact => (
            channelCost.is_active
            && fact.leadCount > 0
            && fact.channelAttributed
            && fact.channel.id === channelCost.channel_id
        ));
        if (eligibleFacts.length === 0) {
            unallocatedCostCents += channelCost.cost_cents;
            continue;
        }

        // Modeled/estimated: observed channel spend is divided equally among
        // that channel's acquisition-cohort leads, with integer reconciliation.
        const allocationRows = eligibleFacts.map(fact => ({
            key: String(fact.id),
            raw: {
                adSpendCents: channelCost.cost_cents / eligibleFacts.length,
            },
            allocated: {},
            fact,
        }));
        allocateInteger(
            allocationRows,
            'adSpendCents',
            'adSpendCents',
            channelCost.cost_cents
        );
        for (const row of allocationRows) {
            row.fact.allocatedAdCostCents += row.allocated.adSpendCents;
        }
        allocatedCostCents += channelCost.cost_cents;
    }

    return {
        facts: allocatedFacts,
        allocated_cost_cents: allocatedCostCents,
        unallocated_cost_cents: unallocatedCostCents,
    };
}

function costTarget(channelCost) {
    const fallbackKey = `channel_${channelCost.channel_id}`;
    return {
        id: channelCost.channel_id,
        key: channelCost.channel_key || fallbackKey,
        label: channelCost.channel_label || channelCost.channel_key || fallbackKey,
    };
}

function buildBreakdownRows(
    facts,
    dimension,
    totals,
    costSnapshot = emptyCostSnapshot(),
    spendAllocation = allocateAdSpendToFacts(facts, costSnapshot),
    lsaLtvSnapshot = emptyLsaLtvSnapshot(),
    elocalSnapshot = emptyElocalSnapshot()
) {
    const accumulators = new Map();
    for (const fact of spendAllocation.facts) {
        const distinctTargets = Array.from(
            new Map(
                targetsForFact(fact, dimension)
                    .map(target => [target.key, target])
            ).values()
        );
        const weight = 1 / distinctTargets.length;
        for (const target of distinctTargets) {
            if (!accumulators.has(target.key)) {
                accumulators.set(target.key, emptyBreakdownAccumulator(target));
            }
            const row = accumulators.get(target.key);
            row.raw.leads += fact.leadCount * weight;
            row.raw.converted += fact.convertedCount * weight;
            row.raw.visitCompleted += fact.visitCompletedCount * weight;
            row.raw.jobsDone += fact.jobsDoneCount * weight;
            row.raw.revenueNetCents += fact.revenueNetCents * weight;
            row.raw.callCostCents += fact.callCostCents * weight;
            row.raw.googleLsaWindowedRevenueCents +=
                fact.googleLsaWindowedRevenueCents * weight;
            row.raw.elocalWindowedRevenueCents +=
                fact.elocalWindowedRevenueCents * weight;
            if (dimension !== 'channel') {
                row.raw.adSpendCents += fact.allocatedAdCostCents * weight;
            }
        }
    }

    if (dimension === 'channel') {
        for (const channelCost of costSnapshot.channels) {
            let row = Array.from(accumulators.values()).find(
                candidate => (
                    candidate.channelId === channelCost.channel_id
                    || candidate.key === channelCost.channel_key
                )
            );
            if (!row && channelCost.cost_cents !== 0) {
                const target = costTarget(channelCost);
                row = emptyBreakdownAccumulator(target);
                accumulators.set(target.key, row);
            }
            if (row) {
                row.raw.adSpendCents = channelCost.cost_cents;
                row.raw.googleLsaAdSpendCents =
                    channelCost.google_lsa_ad_spend_cents;
                row.raw.googleOtherAdSpendCents =
                    channelCost.google_other_ad_spend_cents;
                row.raw.elocalBillableAdSpendCents =
                    channelCost.elocal_billable_ad_spend_cents;
            }
        }

        let googleRow = accumulators.get('google_ads');
        if (!googleRow && lsaLtvSnapshot.revenue_net_cents !== 0) {
            googleRow = emptyBreakdownAccumulator({
                id: lsaLtvSnapshot.channel_id,
                key: 'google_ads',
                label: 'Google Ads',
            });
            accumulators.set('google_ads', googleRow);
        }
        if (googleRow) {
            googleRow.raw.googleLsaLtvCents =
                lsaLtvSnapshot.revenue_net_cents;
        }

        let elocalRow = Array.from(accumulators.values()).find(
            candidate => (
                candidate.channelId === elocalSnapshot.channel_id
                || candidate.key === 'elocal'
            )
        );
        const hasElocalMetrics = Object.entries(elocalSnapshot).some(
            ([key, value]) => key !== 'channel_id' && value !== 0
        );
        if (!elocalRow && hasElocalMetrics) {
            elocalRow = emptyBreakdownAccumulator({
                id: elocalSnapshot.channel_id,
                key: 'elocal',
                label: 'eLocal',
            });
            accumulators.set('elocal', elocalRow);
        }
        if (elocalRow) {
            elocalRow.raw.elocalCallCount = elocalSnapshot.call_count;
            elocalRow.raw.elocalBillableCallCount =
                elocalSnapshot.billable_call_count;
            elocalRow.raw.elocalUnbillableCallCount =
                elocalSnapshot.unbillable_call_count;
            elocalRow.raw.elocalMatchedCallCount =
                elocalSnapshot.matched_call_count;
            elocalRow.raw.elocalBillableAdSpendCents =
                elocalSnapshot.billable_spend_cents;
            elocalRow.raw.elocalBookedConversions =
                elocalSnapshot.booked_conversion_count;
            elocalRow.raw.elocalCompletedConversions =
                elocalSnapshot.completed_conversion_count;
        }
    }

    const rows = Array.from(accumulators.values());
    allocateInteger(rows, 'leads', 'leads', totals.leads, COUNT_PRECISION);
    allocateInteger(rows, 'converted', 'converted', totals.converted, COUNT_PRECISION);
    allocateInteger(
        rows,
        'visitCompleted',
        'visitCompleted',
        totals.visitCompleted,
        COUNT_PRECISION
    );
    allocateInteger(rows, 'jobsDone', 'jobsDone', totals.jobsDone, COUNT_PRECISION);
    allocateInteger(
        rows,
        'revenueNetCents',
        'revenueNetCents',
        totals.revenueNetCents
    );
    allocateInteger(
        rows,
        'callCostCents',
        'callCostCents',
        totals.callCostCents
    );
    allocateInteger(
        rows,
        'googleLsaWindowedRevenueCents',
        'googleLsaWindowedRevenueCents',
        totals.googleLsaWindowedRevenueCents
    );
    allocateInteger(
        rows,
        'elocalWindowedRevenueCents',
        'elocalWindowedRevenueCents',
        totals.elocalWindowedRevenueCents
    );
    const allocatedDimensionSpend = dimension === 'channel'
        ? costSnapshot.total_cost_cents
        : spendAllocation.allocated_cost_cents;
    allocateInteger(
        rows,
        'adSpendCents',
        'adSpendCents',
        allocatedDimensionSpend
    );
    const hasObservedSpend = costSnapshot.total_cost_cents !== 0;

    return rows.map(row => ({
        key: row.key,
        label: row.label,
        leads: row.allocated.leads,
        converted: row.allocated.converted,
        visit_completed: row.allocated.visitCompleted,
        jobs_done: row.allocated.jobsDone,
        revenue_net_cents: row.allocated.revenueNetCents,
        ad_spend_cents: hasObservedSpend ? row.allocated.adSpendCents : null,
        // A zero-lead synthetic row is unattributed spend (also surfaced as
        // unallocated_spend_cents); a 0× ROAS would falsely imply a measured
        // return, so ROAS is null there. Real rows (leads > 0, revenue 0) keep 0×.
        roas: row.allocated.leads === 0 && row.allocated.revenueNetCents === 0
            ? null
            : roasFor(
                row.allocated.revenueNetCents,
                row.allocated.adSpendCents
            ),
        marketing_contribution_cents:
            row.allocated.revenueNetCents
            - row.allocated.callCostCents
            - row.allocated.adSpendCents,
        google_lsa_ad_spend_cents: row.raw.googleLsaAdSpendCents,
        google_other_ad_spend_cents: row.raw.googleOtherAdSpendCents,
        google_lsa_windowed_revenue_cents:
            row.allocated.googleLsaWindowedRevenueCents,
        google_lsa_ltv_cents: row.raw.googleLsaLtvCents,
        google_lsa_roas: roasFor(
            row.allocated.googleLsaWindowedRevenueCents,
            row.raw.googleLsaAdSpendCents
        ),
        google_lsa_ltv_roas: roasFor(
            row.raw.googleLsaLtvCents,
            row.raw.googleLsaAdSpendCents
        ),
        elocal_call_count: row.raw.elocalCallCount,
        elocal_billable_call_count: row.raw.elocalBillableCallCount,
        elocal_unbillable_call_count: row.raw.elocalUnbillableCallCount,
        elocal_matched_call_count: row.raw.elocalMatchedCallCount,
        elocal_billable_ad_spend_cents:
            row.raw.elocalBillableAdSpendCents,
        elocal_booked_conversions: row.raw.elocalBookedConversions,
        elocal_completed_conversions: row.raw.elocalCompletedConversions,
        elocal_windowed_revenue_cents:
            row.allocated.elocalWindowedRevenueCents,
        elocal_cpa_booked_cents: cpaFor(
            row.raw.elocalBillableAdSpendCents,
            row.raw.elocalBookedConversions
        ),
        elocal_cpa_completed_cents: cpaFor(
            row.raw.elocalBillableAdSpendCents,
            row.raw.elocalCompletedConversions
        ),
        elocal_roas: roasFor(
            row.allocated.elocalWindowedRevenueCents,
            row.raw.elocalBillableAdSpendCents
        ),
        funnel_counts: {
            leads: row.allocated.leads,
            converted: row.allocated.converted,
            visit_completed: row.allocated.visitCompleted,
            jobs_done: row.allocated.jobsDone,
        },
    })).sort((left, right) => (
        right.revenue_net_cents - left.revenue_net_cents
        || right.leads - left.leads
        || left.label.localeCompare(right.label)
        || left.key.localeCompare(right.key)
    ));
}

async function getBreakdown(companyId, query = {}) {
    const period = parsePeriod(query.from, query.to);
    requireCompanyId(companyId);
    if (!VALID_DIMENSIONS.has(query.dimension)) {
        throw new LeadChannelAnalyticsError(
            'INVALID_DIMENSION',
            'dimension must be channel, area, or technician'
        );
    }

    const [
        facts,
        costSnapshot,
        lsaLtvSnapshot,
        elocalSnapshot,
    ] = await Promise.all([
        loadCohortFacts(companyId, period),
        loadCostSnapshot(companyId, period),
        loadLsaLtvSnapshot(companyId, period),
        loadElocalSnapshot(companyId, period),
    ]);
    const totals = totalsForFacts(facts);
    const spendAllocation = allocateAdSpendToFacts(facts, costSnapshot);
    const dimensionAdSpendCents = query.dimension === 'channel'
        ? costSnapshot.total_cost_cents
        : spendAllocation.allocated_cost_cents;
    return {
        dimension: query.dimension,
        rows: buildBreakdownRows(
            facts,
            query.dimension,
            totals,
            costSnapshot,
            spendAllocation,
            lsaLtvSnapshot,
            elocalSnapshot
        ),
        totals: {
            leads: totals.leads,
            jobs_done: totals.jobsDone,
            revenue_net_cents: totals.revenueNetCents,
            ad_spend_cents: dimensionAdSpendCents,
            roas: roasFor(totals.revenueNetCents, dimensionAdSpendCents),
            marketing_contribution_cents:
                totals.revenueNetCents
                - totals.callCostCents
                - dimensionAdSpendCents,
            ...lsaKpis(
                totals.googleLsaWindowedRevenueCents,
                lsaLtvSnapshot.revenue_net_cents,
                costSnapshot
            ),
            ...elocalKpis(
                totals.elocalWindowedRevenueCents,
                elocalSnapshot
            ),
            funnel_counts: {
                leads: totals.leads,
                converted: totals.converted,
                visit_completed: totals.visitCompleted,
                jobs_done: totals.jobsDone,
            },
        },
    };
}

async function getStandaloneNetCents(companyId, period) {
    const { rows } = await db.query(
        `WITH company_context AS (
             SELECT
                 id,
                 COALESCE(NULLIF(timezone, ''), $4) AS timezone
             FROM companies
             WHERE id = $1
         )
         SELECT COALESCE(
             ROUND(
                 (
                     SUM(
                         CASE
                             WHEN pt.transaction_type = 'payment'
                                  AND pt.status = 'completed'
                                 THEN pt.amount
                             ELSE 0
                         END
                     )
                     -
                     SUM(
                         CASE
                             WHEN pt.transaction_type = 'refund'
                                  AND pt.status = 'completed'
                                 THEN ABS(pt.amount)
                             ELSE 0
                         END
                     )
                 ) * 100
             ),
             0
         )::bigint AS tax_basis_unknown_cents
         FROM payment_transactions pt
         JOIN company_context cc
           ON cc.id = pt.company_id
         WHERE pt.company_id = $1
           AND pt.job_id IS NULL
           AND pt.voided_at IS NULL
           AND COALESCE(pt.processed_at, pt.created_at)
                 >= ($2::date AT TIME ZONE cc.timezone)
           AND COALESCE(pt.processed_at, pt.created_at)
                 < (($3::date + 1) AT TIME ZONE cc.timezone)`,
        [companyId, period.from, period.to, DEFAULT_TIMEZONE]
    );
    return asInteger(rows[0]?.tax_basis_unknown_cents);
}

async function getDataQuality(companyId, query = {}) {
    const period = parsePeriod(query.from, query.to);
    requireCompanyId(companyId);
    const [
        facts,
        taxBasisUnknownCents,
        costSnapshot,
        connectedSources,
    ] = await Promise.all([
        loadCohortFacts(companyId, period),
        getStandaloneNetCents(companyId, period),
        loadCostSnapshot(companyId, period),
        loadConnectedSources(companyId),
    ]);
    const leadFacts = facts.filter(fact => fact.leadCount > 0);
    const attributed = leadFacts.reduce(
        (count, fact) => count + (fact.channelAttributed ? fact.leadCount : 0),
        0
    );
    const leadCount = leadFacts.reduce(
        (count, fact) => count + fact.leadCount,
        0
    );
    const spendAllocation = allocateAdSpendToFacts(facts, costSnapshot);
    return {
        attribution_coverage_pct: percent(attributed, leadCount),
        unallocated_spend_cents: spendAllocation.unallocated_cost_cents,
        tax_basis_unknown_cents: taxBasisUnknownCents,
        connected_sources: connectedSources,
    };
}

module.exports = {
    LeadChannelAnalyticsError,
    getSummary,
    getBreakdown,
    getDataQuality,
    _parsePeriod: parsePeriod,
    _buildBreakdownRows: buildBreakdownRows,
};
