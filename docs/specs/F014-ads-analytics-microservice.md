# F014 — Ads Analytics Microservice

**Goal:** external, token-authenticated HTTP surface that returns Blanc funnel data (inbound tracking calls → leads → jobs → revenue) for a requested period. First consumer is the ABC Homes Google Ads weekly report script.

**Status:** spec ready for copy-paste implementation. All artefacts below are final — no design questions open.

**Constraints observed:**
- Reuse `integrationsAuth` middleware (`X-BLANC-API-KEY` + `X-BLANC-API-SECRET`), no new auth mechanism.
- New scope `analytics:read` — keeps Google Ads key from touching `leads:create`.
- Per-company isolation via `req.integrationCompanyId`.
- Timezone fixed to `America/New_York` (ABC Homes is ET) — dates in query params are interpreted in that TZ.
- No mutations. Read-only endpoints.

---

## 1. Endpoints

Base: `/api/v1/integrations/analytics`

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/summary` | `analytics:read` | One object: calls + leads + jobs + funnel rates for the period |
| GET | `/calls` | `analytics:read` | Paged list of inbound calls to tracking number in period |
| GET | `/leads` | `analytics:read` | Paged list of leads created in period, attributed to tracking call where possible |
| GET | `/jobs` | `analytics:read` | Paged list of jobs linked to period's leads |

### Common query params

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `from` | `YYYY-MM-DD` | yes | — | Inclusive, interpreted in `America/New_York` |
| `to` | `YYYY-MM-DD` | yes | — | Inclusive, interpreted in `America/New_York` (entire day) |
| `tracking_number` | E.164 | no | `+16176444408` | Which DID to attribute to. Normalized server-side. |
| `limit` | int | no | 100 | `/calls|/leads|/jobs` only, max 500 |
| `cursor` | opaque string | no | — | `/calls|/leads|/jobs` pagination |

### `GET /summary` response shape

```jsonc
{
  "success": true,
  "request_id": "req_…",
  "period": { "from": "2026-04-16", "to": "2026-04-22", "tz": "America/New_York" },
  "tracking_number": "+16176444408",
  "calls": {
    "total": 42,
    "answered": 31,
    "missed": 11,
    "answer_rate": 0.738,
    "avg_duration_sec": 184,
    "after_hours": 4,
    "new_contact_rate": 0.81,
    "repeat_caller_rate": 0.19
  },
  "leads": {
    "created": 7,
    "from_tracking_calls": 6,
    "call_to_lead_rate": 0.194,
    "lead_lost": 1,
    "converted_to_job": 4,
    "by_job_type": { "Refrigerator": 3, "Dryer": 2, "General": 2 }
  },
  "jobs": {
    "from_period_leads": 4,
    "lead_to_job_rate": 0.571,
    "scheduled_in_period": 5,
    "completed_in_period": 3,
    "canceled_in_period": 1,
    "rescheduled_in_period": 0,
    "revenue_invoiced": 1840.00,
    "avg_ticket": 460.00,
    "avg_time_to_schedule_hours": 26.4,
    "by_territory": { "Boston Metro": 3, "North Shore": 1 }
  },
  "funnel": {
    "leads_per_answered_call": 0.194,
    "jobs_per_lead": 0.571,
    "jobs_per_answered_call": 0.129
  }
}
```

### Error codes (same envelope as `integrations-leads`)

| HTTP | `code` | When |
|---|---|---|
| 400 | `PERIOD_REQUIRED` | `from` or `to` missing/invalid |
| 400 | `PERIOD_TOO_LARGE` | `to - from > 92 days` |
| 401 | `AUTH_*` | from `integrationsAuth` (unchanged) |
| 403 | `SCOPE_INSUFFICIENT` | scopes do not include `analytics:read` |
| 429 | `RATE_LIMITED` | from `rateLimiter` |
| 500 | `INTERNAL_ERROR` | any DB/runtime failure |

---

## 2. Deliverables (copy-paste sources)

### 2.1 Migration — `backend/db/migrations/080_seed_analytics_scope.sql`

Trivial, no-op migration: scopes live in `api_integrations.scopes` (JSONB array), so no schema change is required. Migration file exists purely to document the new scope and to let onboarding tooling pick it up.

```sql
-- =============================================================================
-- Migration 080: Document analytics:read scope
--
-- No DDL change — api_integrations.scopes is already JSONB and accepts any
-- string. This file is a marker so onboarding scripts and audits can find the
-- canonical scope list.
--
-- Canonical scopes (2026-04-22):
--   leads:create       — POST /api/v1/integrations/leads
--   analytics:read     — GET  /api/v1/integrations/analytics/*   (F014)
-- =============================================================================

COMMENT ON COLUMN api_integrations.scopes IS
    'JSON array of permissions. Known values: leads:create, analytics:read';
```

### 2.2 Service — `backend/src/services/analyticsService.js`

```js
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
          COUNT(*) FILTER (WHERE answered_at IS NOT NULL)::int       AS answered,
          COUNT(*) FILTER (
            WHERE answered_at IS NULL
              AND status IN ('no-answer','busy','failed','canceled','missed')
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
        (answered_at IS NOT NULL) AS answered
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
```

### 2.3 Router — `backend/src/routes/integrations-analytics.js`

```js
/**
 * Integrations Analytics Router (F014)
 *
 * External read-only endpoints for Ads performance reporting.
 *
 *   GET /api/v1/integrations/analytics/summary
 *   GET /api/v1/integrations/analytics/calls
 *   GET /api/v1/integrations/analytics/leads
 *   GET /api/v1/integrations/analytics/jobs
 *
 * Auth: X-BLANC-API-KEY + X-BLANC-API-SECRET headers, scope `analytics:read`.
 */

const express = require('express');
const router = express.Router();
const analyticsService = require('../services/analyticsService');
const {
    rejectLegacyAuth,
    validateHeaders,
    authenticateIntegration,
} = require('../middleware/integrationsAuth');
const rateLimiter = require('../middleware/rateLimiter');

// Middleware chain (mirrors integrations-leads)
router.use(rejectLegacyAuth);
router.use(validateHeaders);
router.use(authenticateIntegration);
router.use(rateLimiter);

function requireScope(req, res, next) {
    const scopes = req.integrationScopes || [];
    if (!scopes.includes('analytics:read')) {
        return res.status(403).json({
            success: false,
            code: 'SCOPE_INSUFFICIENT',
            message: 'This integration does not have analytics:read scope.',
            request_id: req.requestId,
        });
    }
    next();
}

function handleError(err, req, res) {
    if (err instanceof analyticsService.AnalyticsServiceError) {
        return res.status(err.httpStatus || 400).json({
            success: false,
            code: err.code,
            message: err.message,
            request_id: req.requestId,
        });
    }
    console.error('[IntegrationsAnalytics] Error:', err.message);
    return res.status(500).json({
        success: false,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        request_id: req.requestId,
    });
}

router.get('/analytics/summary', requireScope, async (req, res) => {
    try {
        const data = await analyticsService.getSummary({
            from: req.query.from,
            to: req.query.to,
            trackingNumber: req.query.tracking_number,
            companyId: req.integrationCompanyId,
        });
        res.json({ success: true, request_id: req.requestId, ...data });
    } catch (err) { handleError(err, req, res); }
});

router.get('/analytics/calls', requireScope, async (req, res) => {
    try {
        const data = await analyticsService.listCalls({
            from: req.query.from,
            to: req.query.to,
            trackingNumber: req.query.tracking_number,
            companyId: req.integrationCompanyId,
            limit: req.query.limit,
            cursor: req.query.cursor,
        });
        res.json({ success: true, request_id: req.requestId, ...data });
    } catch (err) { handleError(err, req, res); }
});

router.get('/analytics/leads', requireScope, async (req, res) => {
    try {
        const data = await analyticsService.listLeads({
            from: req.query.from,
            to: req.query.to,
            trackingNumber: req.query.tracking_number,
            companyId: req.integrationCompanyId,
            limit: req.query.limit,
            cursor: req.query.cursor,
        });
        res.json({ success: true, request_id: req.requestId, ...data });
    } catch (err) { handleError(err, req, res); }
});

router.get('/analytics/jobs', requireScope, async (req, res) => {
    try {
        const data = await analyticsService.listJobs({
            from: req.query.from,
            to: req.query.to,
            trackingNumber: req.query.tracking_number,
            companyId: req.integrationCompanyId,
            limit: req.query.limit,
            cursor: req.query.cursor,
        });
        res.json({ success: true, request_id: req.requestId, ...data });
    } catch (err) { handleError(err, req, res); }
});

module.exports = router;
```

### 2.4 Server registration — patch for `src/server.js`

Currently line 16:

```js
const integrationsLeadsRouter = require('../backend/src/routes/integrations-leads');
```

Add immediately below:

```js
const integrationsAnalyticsRouter = require('../backend/src/routes/integrations-analytics');
```

Currently line 169:

```js
app.use('/api/v1/integrations', integrationsLeadsRouter);
```

Add immediately below:

```js
app.use('/api/v1/integrations', integrationsAnalyticsRouter);
```

Currently line 212:

```js
console.log('🔐 BLANC Integrations API enabled at /api/v1/integrations/leads');
```

Replace with:

```js
console.log('🔐 BLANC Integrations API enabled at /api/v1/integrations/{leads, analytics/*}');
```

Both routers are mounted at the same base and use the same middleware chain, so route ordering does not matter.

### 2.5 Key issuance — `backend/scripts/issue-analytics-key.js`

Usage:
```
BLANC_SERVER_PEPPER=… node backend/scripts/issue-analytics-key.js \
    --client "ABC Homes Google Ads" \
    --company-id 00000000-0000-0000-0000-000000000000
```
Prints `X-BLANC-API-KEY` and `X-BLANC-API-SECRET` ONCE — save them immediately, the secret is not recoverable.

```js
#!/usr/bin/env node
/**
 * Issue an analytics:read API key for an external reporting consumer.
 * Writes one row into api_integrations with scopes=["analytics:read"].
 *
 * Secret is randomly generated, printed once, and stored as hash(secret+pepper).
 */

const crypto = require('crypto');
const db = require('../src/db/connection');

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const key = argv[i];
        const value = argv[i + 1];
        if (key === '--client')      { args.clientName = value; i++; }
        else if (key === '--company-id') { args.companyId = value; i++; }
        else if (key === '--expires-days') { args.expiresDays = parseInt(value, 10); i++; }
    }
    return args;
}

(async () => {
    const args = parseArgs(process.argv);
    if (!args.clientName) {
        console.error('Usage: --client "<name>" [--company-id <uuid>] [--expires-days <n>]');
        process.exit(1);
    }
    if (!process.env.BLANC_SERVER_PEPPER) {
        console.error('BLANC_SERVER_PEPPER env var is required.');
        process.exit(1);
    }

    const keyId  = 'blanc_ana_' + crypto.randomBytes(12).toString('hex');
    const secret =               crypto.randomBytes(32).toString('base64url');
    const secretHash = crypto
        .createHash('sha256')
        .update(secret + process.env.BLANC_SERVER_PEPPER)
        .digest('hex');

    const expiresAt = args.expiresDays
        ? new Date(Date.now() + args.expiresDays * 86400000).toISOString()
        : null;

    await db.query(
        `INSERT INTO api_integrations (client_name, key_id, secret_hash, scopes, company_id, expires_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [args.clientName, keyId, secretHash, JSON.stringify(['analytics:read']),
         args.companyId || null, expiresAt]
    );

    console.log('─'.repeat(72));
    console.log(' API KEY ISSUED — copy these now, secret will not be shown again:');
    console.log('─'.repeat(72));
    console.log('  X-BLANC-API-KEY    :', keyId);
    console.log('  X-BLANC-API-SECRET :', secret);
    console.log('  Scopes             : analytics:read');
    console.log('  Client             :', args.clientName);
    console.log('  Company id         :', args.companyId || '(none — tenant-wide)');
    console.log('  Expires at         :', expiresAt || '(never)');
    console.log('─'.repeat(72));

    await db.end?.();
    process.exit(0);
})().catch((err) => {
    console.error('Failed to issue key:', err);
    process.exit(1);
});
```

### 2.6 Tests — `tests/routes/integrations-analytics.test.js`

```js
/**
 * F014 — Integrations Analytics Router tests.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../backend/src/services/analyticsService', () => {
    class AnalyticsServiceError extends Error {
        constructor(code, message, http = 400) { super(message); this.code = code; this.httpStatus = http; }
    }
    return {
        AnalyticsServiceError,
        getSummary: jest.fn(),
        listCalls: jest.fn(),
        listLeads: jest.fn(),
        listJobs: jest.fn(),
    };
});

jest.mock('../../backend/src/middleware/integrationsAuth', () => ({
    rejectLegacyAuth:       (req, res, next) => next(),
    validateHeaders:        (req, res, next) => next(),
    authenticateIntegration: (req, res, next) => {
        req.integrationScopes = req.headers['x-test-scopes']
            ? req.headers['x-test-scopes'].split(',') : ['analytics:read'];
        req.integrationCompanyId = '00000000-0000-0000-0000-000000000000';
        req.integrationKeyId = 'blanc_ana_test';
        next();
    },
}));
jest.mock('../../backend/src/middleware/rateLimiter',
    () => (req, res, next) => next());

const analytics = require('../../backend/src/services/analyticsService');
const router    = require('../../backend/src/routes/integrations-analytics');

function makeApp() {
    const app = express();
    app.use((req, res, next) => { req.requestId = 'req_test'; next(); });
    app.use('/api/v1/integrations', router);
    return app;
}

describe('GET /api/v1/integrations/analytics/summary', () => {
    let app;
    beforeEach(() => { jest.clearAllMocks(); app = makeApp(); });

    test('returns 200 with summary payload', async () => {
        analytics.getSummary.mockResolvedValue({
            period: { from: '2026-04-16', to: '2026-04-22', tz: 'America/New_York' },
            tracking_number: '+16176444408',
            calls: { total: 42, answered: 31, missed: 11 },
            leads: { created: 7 },
            jobs:  { from_period_leads: 4 },
            funnel: {},
        });
        const res = await request(app)
            .get('/api/v1/integrations/analytics/summary?from=2026-04-16&to=2026-04-22');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.calls.total).toBe(42);
        expect(analytics.getSummary).toHaveBeenCalledWith(expect.objectContaining({
            from: '2026-04-16', to: '2026-04-22',
            companyId: '00000000-0000-0000-0000-000000000000',
        }));
    });

    test('403 when scope missing', async () => {
        const res = await request(app)
            .get('/api/v1/integrations/analytics/summary?from=2026-04-16&to=2026-04-22')
            .set('x-test-scopes', 'leads:create');
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('SCOPE_INSUFFICIENT');
    });

    test('400 passes through service validation error', async () => {
        analytics.getSummary.mockRejectedValue(
            new analytics.AnalyticsServiceError('PERIOD_REQUIRED', 'bad', 400));
        const res = await request(app)
            .get('/api/v1/integrations/analytics/summary?from=&to=');
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PERIOD_REQUIRED');
    });

    test('500 on unexpected error', async () => {
        analytics.getSummary.mockRejectedValue(new Error('boom'));
        const res = await request(app)
            .get('/api/v1/integrations/analytics/summary?from=2026-04-16&to=2026-04-22');
        expect(res.status).toBe(500);
        expect(res.body.code).toBe('INTERNAL_ERROR');
    });
});

describe('list endpoints', () => {
    let app;
    beforeEach(() => { jest.clearAllMocks(); app = makeApp(); });

    test.each([
        ['calls', 'listCalls'],
        ['leads', 'listLeads'],
        ['jobs',  'listJobs'],
    ])('%s returns items + cursor', async (path, method) => {
        analytics[method].mockResolvedValue({ items: [{ id: 1 }], next_cursor: 'c_next' });
        const res = await request(app)
            .get(`/api/v1/integrations/analytics/${path}?from=2026-04-16&to=2026-04-22&limit=10`);
        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.next_cursor).toBe('c_next');
    });
});
```

### 2.7 Service unit tests — `tests/services/analyticsService.test.js`

```js
/**
 * F014 — analyticsService unit tests.
 * Only the pure helpers are covered here — SQL aggregation is left to
 * an integration/e2e layer that hits a real Postgres (out of scope here).
 */

jest.mock('../../backend/src/db/connection', () => ({ query: jest.fn() }));

const analytics = require('../../backend/src/services/analyticsService');

describe('parsePeriod', () => {
    test('rejects missing', () => {
        expect(() => analytics._parsePeriod(null, '2026-01-01')).toThrow(/YYYY-MM-DD/);
        expect(() => analytics._parsePeriod('2026-01-01', null)).toThrow(/YYYY-MM-DD/);
    });
    test('rejects reversed range', () => {
        expect(() => analytics._parsePeriod('2026-05-01', '2026-04-01')).toThrow(/to must be >= from/);
    });
    test('rejects too-large range', () => {
        expect(() => analytics._parsePeriod('2026-01-01', '2026-12-31')).toThrow(/PERIOD_TOO_LARGE|Period too large/);
    });
    test('accepts 7-day range', () => {
        expect(analytics._parsePeriod('2026-04-16', '2026-04-22')).toEqual({
            fromStr: '2026-04-16', toStr: '2026-04-22',
        });
    });
});

describe('normalizePhone', () => {
    test('null passthrough', () => { expect(analytics._normalizePhone(null)).toBeNull(); });
    test('10-digit gets +1', () => { expect(analytics._normalizePhone('6176444408')).toBe('+16176444408'); });
    test('11-digit with 1 gets +', () => { expect(analytics._normalizePhone('16176444408')).toBe('+16176444408'); });
    test('formatted input stripped', () => { expect(analytics._normalizePhone('(617) 644-4408')).toBe('+16176444408'); });
});
```

---

## 3. curl smoke-test after deploy

```bash
export KEY='blanc_ana_…'
export SECRET='…'
export HOST='https://<host>'

# Summary for last week
curl -sS "$HOST/api/v1/integrations/analytics/summary?from=2026-04-16&to=2026-04-22" \
  -H "X-BLANC-API-KEY: $KEY" \
  -H "X-BLANC-API-SECRET: $SECRET" | jq .

# Paged calls list
curl -sS "$HOST/api/v1/integrations/analytics/calls?from=2026-04-16&to=2026-04-22&limit=50" \
  -H "X-BLANC-API-KEY: $KEY" \
  -H "X-BLANC-API-SECRET: $SECRET" | jq .

# Different tracking number (multi-DID scenario)
curl -sS "$HOST/api/v1/integrations/analytics/summary?from=2026-04-16&to=2026-04-22&tracking_number=%2B16175551234" \
  -H "X-BLANC-API-KEY: $KEY" \
  -H "X-BLANC-API-SECRET: $SECRET" | jq .

# Expected 403 — wrong scope
curl -sS -o /dev/null -w "%{http_code}\n" \
  "$HOST/api/v1/integrations/analytics/summary?from=2026-04-16&to=2026-04-22" \
  -H "X-BLANC-API-KEY: $KEY_LEADS_ONLY" \
  -H "X-BLANC-API-SECRET: $SECRET_LEADS_ONLY"
# → 403
```

---

## 4. Rollout checklist

1. Apply migration `080_seed_analytics_scope.sql` (no-op DDL, just updates column comment).
2. Deploy the three source files (`analyticsService.js`, `integrations-analytics.js`, `issue-analytics-key.js`) + server.js patch.
3. Run `npx jest tests/routes/integrations-analytics.test.js tests/services/analyticsService.test.js` — both suites green.
4. On the production app container, run:
   ```
   node backend/scripts/issue-analytics-key.js --client "ABC Homes Google Ads" --expires-days 365
   ```
   Save `KEY` + `SECRET` into the Google Ads Script secrets (or wherever the report script lives).
5. Run the three `curl` smoke tests above from a trusted IP. Expect 200 with non-zero `calls.total` for a recent period.
6. Share the endpoint + auth format with whoever owns the weekly Google Ads report script. Their script already knows the shape — `period`, `calls`, `leads`, `jobs`, `funnel`.

---

## 5. What to watch after go-live

- **Attribution gap** — leads where `tracking_call_sid IS NULL`: either the caller used a different DID, or the 24 h matching window is too tight. If > 20 %, revisit the join rule (add email match, widen window, or record `calls.lead_id` directly at creation time).
- **Revenue precision** — `invoice_total` is stored as TEXT ("$1,234.00"). The `regexp_replace(... '[^0-9.]' ...)` strip is tolerant but will drop decimals if a locale uses `,` as the separator. If that becomes an issue, add `.` normalization step.
- **TZ drift** — everything is pinned to ET. If a second tenant joins with a different TZ, move `TZ` into `companies` config and pass it into the CTE.
- **Rate limit** — default 60 req/min per key is fine for a weekly cron but will squeeze if someone wires a dashboard. Raise `RATE_LIMIT_MAX_PER_KEY` env or add a per-scope override when that actually happens.
