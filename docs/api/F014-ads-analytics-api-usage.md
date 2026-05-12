# Blanc Ads Analytics API — Usage Guide

Base URL: `https://<host>/api/v1/integrations/analytics`

---

## 1. Authentication

Every request requires two headers:

```
X-BLANC-API-KEY:    blanc_ana_xxxxxxxxxxxxxxxxxxxxxxxx
X-BLANC-API-SECRET: <32-byte base64url secret>
```

Keys are issued by the Blanc ops team via `backend/scripts/issue-analytics-key.js` and bound to scope `analytics:read`. The secret is shown once at issuance — store it in your secret manager immediately.

**Never** put the key/secret in query strings or request bodies — legacy auth forms are rejected with `401 AUTH_LEGACY_REJECTED`.

---

## 2. Endpoints

All four endpoints share the same query params. Base path: `/api/v1/integrations/analytics`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/summary` | One aggregated object: calls + leads + jobs + funnel rates |
| GET | `/calls`   | Paged inbound calls to the tracking DID in the period |
| GET | `/leads`   | Paged leads created in the period, with tracking-call attribution |
| GET | `/jobs`    | Paged jobs linked to period's leads |

### Query params

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `from` | `YYYY-MM-DD` | yes | — | Inclusive, interpreted in `America/New_York` |
| `to` | `YYYY-MM-DD` | yes | — | Inclusive, interpreted in `America/New_York` (entire day) |
| `tracking_number` | E.164 | no | `+16176444408` | ABC Homes main ad DID. Normalized server-side |
| `limit` | int | no | 100 | `/calls`, `/leads`, `/jobs` only. Max 500 |
| `cursor` | string | no | — | Opaque pagination token from previous response |
| `has_gclid` | `true`/`false` | no | — | `/leads` only. Filter to leads with (or without) a stored Google Click ID |

**Period rules:**
- `to - from` ≤ 92 days, else `400 PERIOD_TOO_LARGE`
- `to ≥ from`, else `400 PERIOD_REQUIRED`

---

## 3. `/summary` — response shape

```jsonc
{
  "success": true,
  "request_id": "req_abcdef...",
  "period": { "from": "2026-04-16", "to": "2026-04-22", "tz": "America/New_York" },
  "tracking_number": "+16176444408",

  "calls": {
    "total": 42,                // all inbound calls to tracking DID in period
    "answered": 31,             // status='completed' AND duration_sec > 0 (actually talked)
    "missed": 11,               // everything else: no-answer, voicemail, failed, busy, etc.
    "answer_rate": 0.738,       // answered / total
    "avg_duration_sec": 184,    // average talk time (duration_sec > 0)
    "after_hours": 4,           // calls before 8am or after 7pm ET
    "new_contact_rate": 0.81,   // distinct_contacts / calls_with_contact
    "repeat_caller_rate": 0.19  // 1 - new_contact_rate
  },

  "leads": {
    "created": 7,                     // leads with created_at in period
    "from_tracking_calls": 6,         // leads attributed to a tracking call (24h window)
    "from_website_new_contact": 1,    // leads with job_source in BLANC_WEBSITE_SOURCES and contact has no earlier leads
    "ads_attributable": 7,            // from_tracking_calls + from_website_new_contact — the Ads funnel total
    "call_to_lead_rate": 0.194,       // from_tracking_calls / calls.answered
    "lead_lost": 1,
    "converted_to_job": 4,
    "by_job_type": { "Refrigerator": 3, "Dryer": 2, "General": 2 }
  },

  "jobs": {
    "from_period_leads": 4,        // jobs whose lead was created in period
    "lead_to_job_rate": 0.571,     // from_period_leads / leads.created
    "scheduled_in_period": 5,      // jobs with start_date in period
    "completed_in_period": 3,
    "canceled_in_period": 1,
    "rescheduled_in_period": 0,
    "revenue_invoiced": 1840.00,   // sum of invoice_total (parsed from "$1,234.00")
    "avg_ticket": 460.00,
    "avg_time_to_schedule_hours": 26.4,  // lead.created_at → job.start_date
    "by_territory": { "Boston Metro": 3, "North Shore": 1 }
  },

  "funnel": {
    "leads_per_answered_call": 0.194,
    "jobs_per_lead":           0.571,
    "jobs_per_answered_call":  0.129
  }
}
```

### Attribution logic

**`from_tracking_calls`** — a lead is counted when:
1. It has a phone number whose **last 10 digits** match the `from_number` of an inbound tracking call, AND
2. The lead's `created_at` falls within **24 hours after** the call's `started_at`.

If multiple tracking calls match, the most recent one wins.

**`from_website_new_contact`** — a lead is counted when:
1. `lead.job_source` is in the configured website-sources list (env `BLANC_WEBSITE_SOURCES`, default: `"Web site order"`, comma-separated), AND
2. The lead is the **first-ever lead** for its `contact_id` — i.e. `NOT EXISTS (another lead with the same contact_id created earlier)`. Leads without `contact_id` are conservatively treated as new contacts.

**`ads_attributable`** = `from_tracking_calls + from_website_new_contact`. This is the "funnel-worthy" lead count — everything we can point to an ads spend (call-tracking DID or site submission by a first-time visitor).

---

## 4. `/calls`, `/leads`, `/jobs` — list endpoints

Paged raw rows. Response shape:

```jsonc
{
  "success": true,
  "request_id": "req_...",
  "items": [ /* array of row objects */ ],
  "next_cursor": "MjAyNi0wNC0yMlQxNDozMDowMC4wMDBa"  // null if no more rows
}
```

### Pagination

To fetch the next page, pass the previous response's `next_cursor` back as `cursor`:

```
GET /analytics/calls?from=2026-04-16&to=2026-04-22&limit=100&cursor=MjAyNi0...
```

When `next_cursor` is `null`, you've reached the end.

### Row shapes

**`/calls` item:**
```jsonc
{
  "call_sid": "CAxxxx", "from_number": "+16171234567", "to_number": "+16176444408",
  "started_at": "2026-04-22T14:30:00Z", "answered_at": "2026-04-22T14:30:09Z",
  "ended_at": "2026-04-22T14:34:12Z", "duration_sec": 243,
  "status": "completed", "contact_id": 1234, "answered": true
}
```

**`/leads` item:**
```jsonc
{
  "id": 98765, "uuid": "Lxxxxxxxxx", "serial_id": 42,
  "status": "Submitted", "sub_status": null, "lead_lost": false,
  "first_name": "Jane", "last_name": "Doe", "phone": "+16171234567", "email": "...",
  "city": "Boston", "state": "MA", "postal_code": "02115",
  "job_type": "Refrigerator", "job_source": "Google Ads",
  "created_at": "2026-04-22T14:45:00Z", "converted_to_job": true,
  "gclid": "CjwKCAjw7p6aBhAlEiwAXbR8...",  // Google Click ID, null when not present
  "tracking_call_sid": "CAxxxx",       // null if lead was not attributed to a tracking call
  "is_website_new_contact": false       // true if the lead is a first-time website submission
}
```

**`/jobs` item:**
```jsonc
{
  "id": 555, "zenbooker_job_id": "ZB-xxxx", "job_number": "JN-1234",
  "service_name": "Refrigerator Repair",
  "blanc_status": "Visit completed", "zb_status": "completed",
  "zb_canceled": false, "zb_rescheduled": false,
  "start_date": "2026-04-25T13:00:00Z", "end_date": "2026-04-25T15:00:00Z",
  "territory": "Boston Metro",
  "invoice_total": "$460.00", "invoice_status": "paid",
  "paid": "460.00",          // ledger-computed received amount (existing field)
  "amount_paid": "460.00",   // F014 offline-conversion field; see logic below
  "lead_id": 98765, "created_at": "2026-04-23T09:00:00Z",
  "lead_phone": "+16171234567"
}
```

**`amount_paid` logic** (numeric, `12,2`):

| `invoice_status` | `amount_paid` |
|---|---|
| `paid` | parsed `invoice_total` |
| `partially_paid` | sum of completed `payment_transactions` (or legacy `zb_payments`) |
| `draft` | `null` |
| anything else | ledger-computed best-effort |

This field exists for the offline-conversion pipeline that uploads paid jobs back to Google Ads. For everyday revenue reporting prefer the existing `paid` column or `/summary.jobs.revenue_invoiced`.

---

## 5. Errors

Every error returns the same envelope:

```jsonc
{ "success": false, "code": "<ERROR_CODE>", "message": "...", "request_id": "req_..." }
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `PERIOD_REQUIRED` | `from` / `to` missing, malformed, or reversed |
| 400 | `PERIOD_TOO_LARGE` | `to - from > 92 days` |
| 401 | `AUTH_HEADERS_REQUIRED` | `X-BLANC-API-KEY` or `X-BLANC-API-SECRET` missing |
| 401 | `AUTH_LEGACY_REJECTED` | Old-style `api_key` / `auth_secret` in URL or body |
| 401 | `AUTH_KEY_NOT_FOUND` | Unknown API key |
| 401 | `AUTH_SECRET_INVALID` | Wrong secret |
| 401 | `AUTH_KEY_EXPIRED` | Key past `expires_at` |
| 401 | `AUTH_KEY_REVOKED` | Key was manually revoked |
| 403 | `SCOPE_INSUFFICIENT` | Key lacks `analytics:read` scope |
| 429 | `RATE_LIMITED` | Exceeded 60 req/min per key (default) or 120 req/min per IP. See `Retry-After` header |
| 500 | `INTERNAL_ERROR` | Server-side failure — include `request_id` when reporting |

### Rate-limit headers

Successful requests return:
```
X-RateLimit-Limit:     60
X-RateLimit-Remaining: 42
X-RateLimit-Reset:     1745331600   (unix ts when bucket resets)
```

---

## 6. curl quick-start

```bash
export KEY='blanc_ana_xxxxxxxxxxxx'
export SECRET='xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
export HOST='https://your-host'

# Weekly summary
curl -sS "$HOST/api/v1/integrations/analytics/summary?from=2026-04-16&to=2026-04-22" \
  -H "X-BLANC-API-KEY: $KEY" \
  -H "X-BLANC-API-SECRET: $SECRET" | jq .

# First page of calls
curl -sS "$HOST/api/v1/integrations/analytics/calls?from=2026-04-16&to=2026-04-22&limit=100" \
  -H "X-BLANC-API-KEY: $KEY" \
  -H "X-BLANC-API-SECRET: $SECRET" | jq .

# Next page — pass the cursor from previous response
curl -sS "$HOST/api/v1/integrations/analytics/calls?from=2026-04-16&to=2026-04-22&limit=100&cursor=MjAyNi0..." \
  -H "X-BLANC-API-KEY: $KEY" \
  -H "X-BLANC-API-SECRET: $SECRET" | jq .

# Multi-DID (non-default tracking number — URL-encode the +)
curl -sS "$HOST/api/v1/integrations/analytics/summary?from=2026-04-16&to=2026-04-22&tracking_number=%2B16175551234" \
  -H "X-BLANC-API-KEY: $KEY" \
  -H "X-BLANC-API-SECRET: $SECRET" | jq .

# Leads with a stored Google Click ID (offline-conversion pipeline source data)
curl -sS "$HOST/api/v1/integrations/analytics/leads?from=2026-04-16&to=2026-04-22&has_gclid=true&limit=100" \
  -H "X-BLANC-API-KEY: $KEY" \
  -H "X-BLANC-API-SECRET: $SECRET" | jq .

# Jobs with amount_paid for ROAS reporting
curl -sS "$HOST/api/v1/integrations/analytics/jobs?from=2026-04-16&to=2026-04-22&limit=100" \
  -H "X-BLANC-API-KEY: $KEY" \
  -H "X-BLANC-API-SECRET: $SECRET" | jq '.items[] | {id, job_number, invoice_status, invoice_total, amount_paid}'
```

---

## 7. Google Apps Script example (weekly ad report)

```javascript
function fetchWeeklyFunnel(fromDate, toDate) {
  const props = PropertiesService.getScriptProperties();
  const key    = props.getProperty('BLANC_API_KEY');
  const secret = props.getProperty('BLANC_API_SECRET');
  const host   = 'https://your-host';

  const url = `${host}/api/v1/integrations/analytics/summary`
            + `?from=${fromDate}&to=${toDate}`;

  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'X-BLANC-API-KEY':    key,
      'X-BLANC-API-SECRET': secret,
    },
    muteHttpExceptions: true,
  });

  const body = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200 || !body.success) {
    throw new Error(`Blanc API ${res.getResponseCode()}: ${body.code} — ${body.message}`);
  }

  // body.calls.total, body.leads.created, body.jobs.revenue_invoiced, etc.
  return body;
}
```

---

## 8. Field reference — source of truth

| Field | Source | Notes |
|---|---|---|
| `calls.*` | `calls` table, `direction='inbound'`, `to_number = tracking_number` | TZ-adjusted to ET |
| `calls.answered` | `status='completed' AND duration_sec > 0` | Human actually talked. Excludes voicemail, agent-ACK-but-dropped no-answers, and other non-talk outcomes |
| `calls.missed` | `total - answered` | Voicemail, no-answer, busy, failed, canceled — anything that didn't result in a conversation |
| `leads.created` | `leads.created_at` in period | All leads, regardless of source |
| `leads.from_tracking_calls` | `leads` joined to tracked calls by last-10-digit phone match within 24h | Attribution window is hard-coded |
| `leads.from_website_new_contact` | `leads` with `job_source IN (BLANC_WEBSITE_SOURCES)` AND no earlier lead for the same `contact_id` | Env default: `"Web site order"` |
| `leads.ads_attributable` | `from_tracking_calls + from_website_new_contact` | Funnel total for Ads reporting |
| `jobs.from_period_leads` | `jobs` whose `lead_id` is in period's leads | Not jobs started in the period — jobs *from period leads* |
| `jobs.revenue_invoiced` | `SUM(invoice_total)` with regex `[^0-9.]` stripped | Decimals assume `.` as separator |
| `jobs.by_territory` | `jobs.territory` grouped count | `NULL` → `"Unknown"` |
| `/leads.gclid` | `leads.gclid` (set on `POST /integrations/leads`) | Optional Google Click ID. Filter via `?has_gclid=true` |
| `/jobs.amount_paid` | See logic table in §4 | Net paid per job — used by the offline-conversion pipeline |

---

## 9. Operational notes

- **Caching** — no server-side cache. If you poll, use `limit`/`cursor` to avoid re-fetching. Rate-limit is the safety net.
- **Consistency** — `/summary` numbers are guaranteed to match the rows returned by `/calls`, `/leads`, `/jobs` for the same period (same SQL CTE).
- **Timezone** — `America/New_York` only. If you need another TZ, request a support ticket; don't try to rebase on the client.
- **Attribution gap** — leads where `tracking_call_sid` is `null` either came from a different channel or the caller used a different phone than the one on the lead. Expect 5-20 % unattributed.

For key issuance, rotations, or revocations, contact the Blanc ops team.
