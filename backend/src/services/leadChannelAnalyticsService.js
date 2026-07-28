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
    cohort AS (
        SELECT
            l.id,
            l.contact_id,
            l.created_at,
            (
                l.converted_at IS NOT NULL
                OR l.converted_to_job = true
                OR LOWER(BTRIM(COALESCE(l.status, ''))) = 'converted'
            ) AS converted,
            CASE
                WHEN l.gclid IS NOT NULL AND ch2.id IS NOT NULL THEN ch2.id
                ELSE ch.id
            END AS channel_id,
            COALESCE(
                CASE
                    WHEN l.gclid IS NOT NULL AND ch2.id IS NOT NULL
                        THEN ch2.channel_key
                END,
                ch.channel_key,
                'unattributed'
            ) AS channel_key,
            COALESCE(
                CASE
                    WHEN l.gclid IS NOT NULL AND ch2.id IS NOT NULL
                        THEN ch2.display_name
                END,
                ch.display_name,
                'Unattributed'
            ) AS channel_label,
            (
                CASE
                    WHEN l.gclid IS NOT NULL AND ch2.id IS NOT NULL
                        THEN ch2.id
                    ELSE ch.id
                END IS NOT NULL
                AND COALESCE(
                    CASE
                        WHEN l.gclid IS NOT NULL AND ch2.id IS NOT NULL
                            THEN ch2.channel_key
                    END,
                    ch.channel_key,
                    'unattributed'
                ) <> 'unattributed'
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
        LEFT JOIN lead_source_channels ch2
          ON ch2.company_id = $1
         AND ch2.channel_key = 'google_ads'
         AND ch2.is_active = true
        LEFT JOIN service_territories st
          ON st.company_id = $1
         AND st.zip = SPLIT_PART(BTRIM(COALESCE(l.postal_code, '')), '-', 1)
        WHERE l.company_id = $1
          AND l.created_at >= ($2::date AT TIME ZONE cc.timezone)
          AND l.created_at < (($3::date + 1) AT TIME ZONE cc.timezone)
    ),
    job_stats AS (
        SELECT
            j.lead_id,
            BOOL_OR(
                j.visit_completed_at IS NOT NULL
                OR LOWER(REPLACE(BTRIM(COALESCE(j.blanc_status, '')), '_', ' '))
                    IN ('visit completed', 'job is done')
            ) AS visit_completed,
            BOOL_OR(
                j.repair_done_at IS NOT NULL
                OR LOWER(REPLACE(BTRIM(COALESCE(j.blanc_status, '')), '_', ' '))
                    = 'job is done'
            ) AS job_done
        FROM jobs j
        JOIN cohort c
          ON c.id = j.lead_id
        WHERE j.company_id = $1
        GROUP BY j.lead_id
    ),
    invoice_attribution AS (
        SELECT
            i.id AS invoice_id,
            COALESCE(i.lead_id, ij.lead_id) AS lead_id
        FROM invoices i
        LEFT JOIN jobs ij
          ON ij.company_id = $1
         AND ij.id = i.job_id
        JOIN cohort c
          ON c.id = COALESCE(i.lead_id, ij.lead_id)
        WHERE i.company_id = $1
    ),
    revenue_by_lead AS (
        SELECT
            ia.lead_id,
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
        FROM invoice_attribution ia
        JOIN payment_transactions pt
          ON pt.company_id = $1
         AND pt.invoice_id = ia.invoice_id
         AND pt.voided_at IS NULL
        GROUP BY ia.lead_id
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
        JOIN cohort c
          ON c.id = chosen.lead_id
    ),
    call_cost_by_lead AS (
        SELECT
            ca.lead_id,
            ROUND(SUM(ABS(ca.price)) * 100)::bigint AS call_cost_cents
        FROM call_attribution ca
        GROUP BY ca.lead_id
    ),
    job_technicians AS (
        SELECT DISTINCT
            j.lead_id,
            tech.tech_id
        FROM jobs j
        JOIN cohort c
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
        FROM job_technicians jt
        LEFT JOIN crm_users cu
          ON cu.company_id = $1
         AND cu.id::text = jt.tech_id
        GROUP BY jt.lead_id
    )
    SELECT
        c.id,
        (c.converted OR js.lead_id IS NOT NULL) AS converted,
        c.channel_id,
        c.channel_key,
        c.channel_label,
        c.channel_attributed,
        c.area_key,
        c.area_label,
        COALESCE(js.visit_completed, false) AS visit_completed,
        COALESCE(js.job_done, false) AS job_done,
        COALESCE(rbl.revenue_net_cents, 0)::bigint AS revenue_net_cents,
        COALESCE(ccbl.call_cost_cents, 0)::bigint AS call_cost_cents,
        COALESCE(tbl.technicians, '[]'::jsonb) AS technicians
    FROM cohort c
    LEFT JOIN job_stats js
      ON js.lead_id = c.id
    LEFT JOIN revenue_by_lead rbl
      ON rbl.lead_id = c.id
    LEFT JOIN call_cost_by_lead ccbl
      ON ccbl.lead_id = c.id
    LEFT JOIN technicians_by_lead tbl
      ON tbl.lead_id = c.id
    ORDER BY c.id
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
        converted: row.converted === true,
        visitCompleted: row.visit_completed === true,
        jobDone: row.job_done === true,
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

function emptyCostSnapshot() {
    return {
        channels: [],
        total_cost_cents: 0,
    };
}

async function loadCostSnapshot(companyId, period) {
    requireCompanyId(companyId);
    const result = await db.query(
        `SELECT
             perf.channel_id,
             ch.channel_key,
             ch.display_name AS channel_label,
             COALESCE(ch.is_active, false) AS is_active,
             ROUND(
                 SUM(perf.cost_micros)::numeric / 10000
             )::bigint AS cost_cents
         FROM lead_source_performance_daily perf
         LEFT JOIN lead_source_channels ch
           ON ch.company_id = $1
          AND ch.id = perf.channel_id
         WHERE perf.company_id = $1
           AND perf.performance_date >= $2::date
           AND perf.performance_date <= $3::date
         GROUP BY
             perf.channel_id,
             ch.channel_key,
             ch.display_name,
             ch.is_active
         ORDER BY perf.channel_id`,
        [companyId, period.from, period.to]
    );
    const rows = result?.rows || [];
    if (rows.length === 0) return emptyCostSnapshot();

    const channels = rows.map(row => ({
        channel_id: row.channel_id,
        channel_key: row.channel_key || null,
        channel_label: row.channel_label || null,
        is_active: row.is_active === true,
        cost_cents: asInteger(row.cost_cents),
    }));
    return {
        channels,
        total_cost_cents: channels.reduce(
            (total, channel) => total + channel.cost_cents,
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
             status,
             last_synced_at,
             synced_from_date,
             synced_through_date
         FROM google_ads_connections
         WHERE company_id = $1`,
        [companyId]
    );
    return (result?.rows || []).map(row => ({
        key: 'google_ads',
        label: 'Google Ads',
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
        totals.leads += 1;
        totals.converted += fact.converted ? 1 : 0;
        totals.visitCompleted += fact.visitCompleted ? 1 : 0;
        totals.jobsDone += fact.jobDone ? 1 : 0;
        totals.revenueNetCents += fact.revenueNetCents;
        totals.callCostCents += fact.callCostCents;
        return totals;
    }, {
        leads: 0,
        converted: 0,
        visitCompleted: 0,
        jobsDone: 0,
        revenueNetCents: 0,
        callCostCents: 0,
    });
}

function roasFor(revenueNetCents, adSpendCents) {
    if (!adSpendCents) return null;
    return revenueNetCents / adSpendCents;
}

function summaryKpis(totals, costSnapshot = emptyCostSnapshot()) {
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
    const [timezone, facts, costSnapshot] = await Promise.all([
        getCompanyTimezone(companyId),
        loadCohortFacts(companyId, period),
        loadCostSnapshot(companyId, period),
    ]);
    const totals = totalsForFacts(facts);
    return {
        kpis: summaryKpis(totals, costSnapshot),
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
    spendAllocation = allocateAdSpendToFacts(facts, costSnapshot)
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
            row.raw.leads += weight;
            row.raw.converted += fact.converted ? weight : 0;
            row.raw.visitCompleted += fact.visitCompleted ? weight : 0;
            row.raw.jobsDone += fact.jobDone ? weight : 0;
            row.raw.revenueNetCents += fact.revenueNetCents * weight;
            row.raw.callCostCents += fact.callCostCents * weight;
            if (dimension !== 'channel') {
                row.raw.adSpendCents += fact.allocatedAdCostCents * weight;
            }
        }
    }

    if (dimension === 'channel') {
        for (const channelCost of costSnapshot.channels) {
            let row = Array.from(accumulators.values()).find(
                candidate => candidate.channelId === channelCost.channel_id
            );
            if (!row && channelCost.cost_cents !== 0) {
                const target = costTarget(channelCost);
                row = emptyBreakdownAccumulator(target);
                accumulators.set(target.key, row);
            }
            if (row) row.raw.adSpendCents = channelCost.cost_cents;
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
        jobs_done: row.allocated.jobsDone,
        revenue_net_cents: row.allocated.revenueNetCents,
        ad_spend_cents: hasObservedSpend ? row.allocated.adSpendCents : null,
        // A zero-lead synthetic row is unattributed spend (also surfaced as
        // unallocated_spend_cents); a 0× ROAS would falsely imply a measured
        // return, so ROAS is null there. Real rows (leads > 0, revenue 0) keep 0×.
        roas: row.allocated.leads === 0
            ? null
            : roasFor(
                row.allocated.revenueNetCents,
                row.allocated.adSpendCents
            ),
        marketing_contribution_cents:
            row.allocated.revenueNetCents
            - row.allocated.callCostCents
            - row.allocated.adSpendCents,
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

    const [facts, costSnapshot] = await Promise.all([
        loadCohortFacts(companyId, period),
        loadCostSnapshot(companyId, period),
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
            spendAllocation
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
           AND pt.invoice_id IS NULL
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
    const attributed = facts.filter(fact => fact.channelAttributed).length;
    const spendAllocation = allocateAdSpendToFacts(facts, costSnapshot);
    return {
        attribution_coverage_pct: percent(attributed, facts.length),
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
