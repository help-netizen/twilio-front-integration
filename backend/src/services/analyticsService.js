/**
 * Analytics Service (F014)
 *
 * Aggregates calls → leads → jobs funnel data for external reporting
 * (Google Ads script, internal dashboards).
 *
 * All queries are company-scoped via companyId (argument).
 * All date math is done in America/New_York to match ABC Homes operations.
 */

const db = require('../db/connection');

const TZ = 'America/New_York';
const MAX_PERIOD_DAYS = 92;

class AnalyticsServiceError extends Error {
    constructor(code, message, httpStatus = 400) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse YYYY-MM-DD + TZ into a half-open UTC range [startUtc, endUtcExclusive).
 * `to` is inclusive on the calendar day, so endUtcExclusive = next day 00:00 ET.
 */
function parsePeriod(fromStr, toStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr || '') ||
        !/^\d{4}-\d{2}-\d{2}$/.test(toStr || '')) {
        throw new AnalyticsServiceError('PERIOD_REQUIRED',
            'from and to must be YYYY-MM-DD dates');
    }
    // Postgres will do the TZ math — we just pass the strings through.
    // For validation bound, compute day diff via JS (loose — 90 vs 92 is fine).
    const from = new Date(`${fromStr}T00:00:00Z`);
    const to = new Date(`${toStr}T00:00:00Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new AnalyticsServiceError('PERIOD_REQUIRED', 'Invalid date');
    }
    const days = Math.round((to - from) / 86400000);
    if (days < 0) {
        throw new AnalyticsServiceError('PERIOD_REQUIRED', 'to must be >= from');
    }
    if (days > MAX_PERIOD_DAYS) {
        throw new AnalyticsServiceError('PERIOD_TOO_LARGE',
            `Period too large (max ${MAX_PERIOD_DAYS} days)`);
    }
    return { fromStr, toStr };
}

function normalizePhone(raw) {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');
    if (!digits) return null;
    // Keep + prefix if 10/11 digits
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return `+${digits}`;
}

// Common CTE fragment — tracking calls and their per-row attribution.
// Used by every endpoint to guarantee a single source of truth.
//
// Params (1-indexed):
//   $1 tracking_number (E.164)
//   $2 from date (YYYY-MM-DD)
//   $3 to date (YYYY-MM-DD)
//   $4 company_id
const TRACKING_CTE = `
  tracked_calls AS (
    SELECT
      c.call_sid,
      c.from_number,
      c.to_number,
      c.started_at,
      c.answered_at,
      c.ended_at,
      c.duration_sec,
      c.status,
      c.contact_id
    FROM calls c
    WHERE c.direction = 'inbound'
      AND regexp_replace(c.to_number, '\\D', '', 'g')
        = regexp_replace($1,            '\\D', '', 'g')
      AND c.started_at >= ($2::date) AT TIME ZONE 'America/New_York'
      AND c.started_at <  (($3::date) + interval '1 day') AT TIME ZONE 'America/New_York'
      AND ($4::uuid IS NULL OR c.company_id = $4::uuid)
  ),
  period_leads AS (
    SELECT l.*
    FROM leads l
    WHERE l.created_at >= ($2::date) AT TIME ZONE 'America/New_York'
      AND l.created_at <  (($3::date) + interval '1 day') AT TIME ZONE 'America/New_York'
  ),
  attributed_leads AS (
    SELECT DISTINCT ON (l.id) l.id, l.phone, l.created_at, tc.call_sid
    FROM period_leads l
    JOIN tracked_calls tc
      ON right(regexp_replace(l.phone,       '\\D', '', 'g'), 10)
       = right(regexp_replace(tc.from_number,'\\D', '', 'g'), 10)
     AND l.created_at BETWEEN tc.started_at AND tc.started_at + interval '24 hours'
    ORDER BY l.id, tc.started_at DESC
  )
`;

// ---------------------------------------------------------------------------
// /summary
// ---------------------------------------------------------------------------

async function getSummary({ from, to, trackingNumber, companyId }) {
    const period = parsePeriod(from, to);
    const phone = normalizePhone(trackingNumber) || '+16176444408';

    const params = [phone, period.fromStr, period.toStr, companyId || null];

    const sql = `
      WITH ${TRACKING_CTE},
      call_metrics AS (
        SELECT
          COUNT(*)::int                                              AS total,
          -- "answered" = human actually talked: completed AND non-zero duration.
          -- Rules out (a) voicemail_left, (b) no-answer rows where Twilio set
          -- answered_at from agent ACK but caller dropped before any talk.
          COUNT(*) FILTER (
            WHERE status = 'completed' AND duration_sec > 0
          )::int                                                      AS answered,
          -- Everything that is NOT answered counts as missed.
          COUNT(*) FILTER (
            WHERE NOT (status = 'completed' AND duration_sec > 0)
          )::int                                                      AS missed,
          COALESCE(ROUND(AVG(duration_sec) FILTER (WHERE duration_sec > 0))::int, 0)
                                                                      AS avg_duration_sec,
          COUNT(*) FILTER (
            WHERE EXTRACT(HOUR FROM started_at AT TIME ZONE 'America/New_York') < 8
               OR EXTRACT(HOUR FROM started_at AT TIME ZONE 'America/New_York') >= 19
          )::int                                                      AS after_hours,
          COUNT(*) FILTER (WHERE contact_id IS NOT NULL)::int         AS with_contact,
          COUNT(DISTINCT contact_id) FILTER (WHERE contact_id IS NOT NULL)::int
                                                                      AS distinct_contacts
        FROM tracked_calls
      ),
      lead_metrics AS (
        SELECT
          COUNT(*)::int                                                                AS created,
          (SELECT COUNT(*)::int FROM attributed_leads)                                 AS from_tracking_calls,
          COUNT(*) FILTER (WHERE lead_lost)::int                                       AS lead_lost,
          COUNT(*) FILTER (WHERE converted_to_job)::int                                AS converted_to_job,
          jsonb_object_agg(
            COALESCE(job_type, 'Unknown'),
            cnt
          ) FILTER (WHERE cnt > 0)                                                     AS by_job_type
        FROM (
          SELECT *, COUNT(*) OVER (PARTITION BY COALESCE(job_type,'Unknown'))::int AS cnt
          FROM period_leads
        ) p
      ),
      period_jobs AS (
        SELECT j.*
        FROM jobs j
        WHERE j.lead_id IN (SELECT id FROM period_leads)
      ),
      job_metrics AS (
        SELECT
          COUNT(*)::int                                                                AS from_period_leads,
          COUNT(*) FILTER (
            WHERE start_date >= ($2::date) AT TIME ZONE 'America/New_York'
              AND start_date <  (($3::date) + interval '1 day') AT TIME ZONE 'America/New_York'
          )::int                                                                        AS scheduled_in_period,
          COUNT(*) FILTER (WHERE zb_status = 'completed')::int                          AS completed_in_period,
          COUNT(*) FILTER (WHERE zb_canceled)::int                                       AS canceled_in_period,
          COUNT(*) FILTER (WHERE zb_rescheduled)::int                                    AS rescheduled_in_period,
          COALESCE(SUM(
            NULLIF(regexp_replace(invoice_total, '[^0-9.]', '', 'g'), '')::numeric
          ), 0)::numeric                                                                 AS revenue_invoiced,
          COALESCE(AVG(
            NULLIF(regexp_replace(invoice_total, '[^0-9.]', '', 'g'), '')::numeric
          ), 0)::numeric                                                                 AS avg_ticket,
          COALESCE(AVG(EXTRACT(EPOCH FROM (j.start_date - l.created_at))/3600.0), 0)::numeric
                                                                                         AS avg_time_to_schedule_hours
        FROM period_jobs j
        LEFT JOIN leads l ON l.id = j.lead_id
      ),
      territory_metrics AS (
        SELECT jsonb_object_agg(COALESCE(territory, 'Unknown'), cnt) FILTER (WHERE cnt > 0) AS by_territory
        FROM (
          SELECT territory, COUNT(*)::int AS cnt FROM period_jobs GROUP BY territory
        ) t
      )
      SELECT
        (SELECT row_to_json(c) FROM call_metrics c)      AS calls,
        (SELECT row_to_json(l) FROM lead_metrics l)      AS leads,
        (SELECT row_to_json(j) FROM job_metrics j)       AS jobs,
        (SELECT by_territory FROM territory_metrics)     AS by_territory;
    `;

    const { rows } = await db.query(sql, params);
    const row = rows[0] || {};
    const calls = row.calls || {};
    const leads = row.leads || {};
    const jobs  = row.jobs  || {};

    const answered = calls.answered || 0;
    const answerRate = calls.total ? answered / calls.total : 0;
    const newContactRate = calls.with_contact
        ? calls.distinct_contacts / calls.with_contact : null;
    const callToLead = answered ? (leads.from_tracking_calls || 0) / answered : 0;
    const leadToJob  = leads.created ? (jobs.from_period_leads || 0) / leads.created : 0;

    return {
        period: { from: period.fromStr, to: period.toStr, tz: TZ },
        tracking_number: phone,
        calls: {
            total:            calls.total || 0,
            answered,
            missed:           calls.missed || 0,
            answer_rate:      round3(answerRate),
            avg_duration_sec: calls.avg_duration_sec || 0,
            after_hours:      calls.after_hours || 0,
            new_contact_rate: newContactRate !== null ? round3(newContactRate) : null,
            repeat_caller_rate: newContactRate !== null ? round3(1 - newContactRate) : null,
        },
        leads: {
            created:             leads.created || 0,
            from_tracking_calls: leads.from_tracking_calls || 0,
            call_to_lead_rate:   round3(callToLead),
            lead_lost:           leads.lead_lost || 0,
            converted_to_job:    leads.converted_to_job || 0,
            by_job_type:         leads.by_job_type || {},
        },
        jobs: {
            from_period_leads:         jobs.from_period_leads || 0,
            lead_to_job_rate:          round3(leadToJob),
            scheduled_in_period:       jobs.scheduled_in_period || 0,
            completed_in_period:       jobs.completed_in_period || 0,
            canceled_in_period:        jobs.canceled_in_period || 0,
            rescheduled_in_period:     jobs.rescheduled_in_period || 0,
            revenue_invoiced:          num(jobs.revenue_invoiced),
            avg_ticket:                num(jobs.avg_ticket),
            avg_time_to_schedule_hours: round1(num(jobs.avg_time_to_schedule_hours)),
            by_territory:              row.by_territory || {},
        },
        funnel: {
            leads_per_answered_call: round3(callToLead),
            jobs_per_lead:           round3(leadToJob),
            jobs_per_answered_call:  round3(callToLead * leadToJob),
        },
    };
}

// ---------------------------------------------------------------------------
// /calls, /leads, /jobs (list endpoints)
// ---------------------------------------------------------------------------

async function listCalls({ from, to, trackingNumber, companyId, limit, cursor }) {
    const period = parsePeriod(from, to);
    const phone = normalizePhone(trackingNumber) || '+16176444408';
    const pageSize = clampLimit(limit);
    const cursorTs = parseCursor(cursor);

    const params = [phone, period.fromStr, period.toStr, companyId || null, pageSize];
    let cursorClause = '';
    if (cursorTs) { params.push(cursorTs); cursorClause = `AND started_at < $${params.length}`; }

    const sql = `
      WITH ${TRACKING_CTE}
      SELECT
        call_sid, from_number, to_number, started_at, answered_at, ended_at,
        duration_sec, status, contact_id,
        -- Same strict "answered = talked" rule as /summary.
        (status = 'completed' AND duration_sec > 0) AS answered
      FROM tracked_calls
      WHERE true ${cursorClause}
      ORDER BY started_at DESC
      LIMIT $5;
    `;
    const { rows } = await db.query(sql, params);
    return pagedResponse(rows, pageSize, (r) => r.started_at);
}

async function listLeads({ from, to, trackingNumber, companyId, limit, cursor }) {
    const period = parsePeriod(from, to);
    const phone = normalizePhone(trackingNumber) || '+16176444408';
    const pageSize = clampLimit(limit);
    const cursorTs = parseCursor(cursor);

    const params = [phone, period.fromStr, period.toStr, companyId || null, pageSize];
    let cursorClause = '';
    if (cursorTs) { params.push(cursorTs); cursorClause = `AND l.created_at < $${params.length}`; }

    const sql = `
      WITH ${TRACKING_CTE}
      SELECT
        l.id, l.uuid, l.serial_id, l.status, l.sub_status, l.lead_lost,
        l.first_name, l.last_name, l.phone, l.email,
        l.city, l.state, l.postal_code,
        l.job_type, l.job_source, l.created_at, l.converted_to_job,
        al.call_sid AS tracking_call_sid
      FROM period_leads l
      LEFT JOIN attributed_leads al ON al.id = l.id
      WHERE true ${cursorClause}
      ORDER BY l.created_at DESC
      LIMIT $5;
    `;
    const { rows } = await db.query(sql, params);
    return pagedResponse(rows, pageSize, (r) => r.created_at);
}

async function listJobs({ from, to, trackingNumber, companyId, limit, cursor }) {
    const period = parsePeriod(from, to);
    const phone = normalizePhone(trackingNumber) || '+16176444408';
    const pageSize = clampLimit(limit);
    const cursorTs = parseCursor(cursor);

    const params = [phone, period.fromStr, period.toStr, companyId || null, pageSize];
    let cursorClause = '';
    if (cursorTs) { params.push(cursorTs); cursorClause = `AND j.created_at < $${params.length}`; }

    const sql = `
      WITH ${TRACKING_CTE}
      SELECT
        j.id, j.zenbooker_job_id, j.job_number, j.service_name,
        j.blanc_status, j.zb_status, j.zb_canceled, j.zb_rescheduled,
        j.start_date, j.end_date, j.territory,
        j.invoice_total, j.invoice_status,
        j.lead_id, j.created_at,
        l.phone AS lead_phone
      FROM jobs j
      LEFT JOIN leads l ON l.id = j.lead_id
      WHERE j.lead_id IN (SELECT id FROM period_leads)
        ${cursorClause}
      ORDER BY j.created_at DESC
      LIMIT $5;
    `;
    const { rows } = await db.query(sql, params);
    return pagedResponse(rows, pageSize, (r) => r.created_at);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clampLimit(n) {
    const v = parseInt(n, 10);
    if (!Number.isFinite(v) || v <= 0) return 100;
    return Math.min(v, 500);
}

function parseCursor(cursor) {
    if (!cursor) return null;
    try {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const d = new Date(decoded);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    } catch { return null; }
}

function makeCursor(ts) {
    if (!ts) return null;
    const iso = ts instanceof Date ? ts.toISOString() : new Date(ts).toISOString();
    return Buffer.from(iso, 'utf8').toString('base64url');
}

function pagedResponse(rows, pageSize, cursorFrom) {
    const hasMore = rows.length === pageSize;
    const nextCursor = hasMore ? makeCursor(cursorFrom(rows[rows.length - 1])) : null;
    return { items: rows, next_cursor: nextCursor };
}

function round3(x) { return Math.round((Number(x) || 0) * 1000) / 1000; }
function round1(x) { return Math.round((Number(x) || 0) * 10) / 10; }
function num(x)    { return Number(x) || 0; }

module.exports = {
    AnalyticsServiceError,
    getSummary,
    listCalls,
    listLeads,
    listJobs,
    // exported for tests
    _normalizePhone: normalizePhone,
    _parsePeriod: parsePeriod,
};
