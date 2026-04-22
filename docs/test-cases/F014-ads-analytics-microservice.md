# F014 — Ads Analytics Microservice — Test Cases

Spec: `docs/specs/F014-ads-analytics-microservice.md`

## Priority legend
- **P0** — must pass before merge
- **P1** — must pass before enabling the key for external consumer
- **P2** — should pass; regressions ok to fix in follow-up
- **P3** — nice to have

---

## 1. Service layer — pure helpers (unit)

Covered by `tests/services/analyticsService.test.js`.

| ID | Priority | Type | Description |
|----|----------|------|-------------|
| SVC-01 | P0 | unit | `parsePeriod('2026-04-16','2026-04-22')` returns `{ fromStr, toStr }`. |
| SVC-02 | P0 | unit | `parsePeriod(null,'2026-04-22')` throws `AnalyticsServiceError` with code `PERIOD_REQUIRED`. |
| SVC-03 | P0 | unit | `parsePeriod('2026-04-22','2026-04-16')` throws `AnalyticsServiceError` (reversed range). |
| SVC-04 | P0 | unit | `parsePeriod('2026-01-01','2026-12-31')` throws `AnalyticsServiceError` with code `PERIOD_TOO_LARGE`. |
| SVC-05 | P0 | unit | `normalizePhone('6176444408')` → `+16176444408` (10-digit → US-prefix). |
| SVC-06 | P0 | unit | `normalizePhone('16176444408')` → `+16176444408` (11-digit with leading 1). |
| SVC-07 | P0 | unit | `normalizePhone('(617) 644-4408')` → `+16176444408` (formatted stripping). |
| SVC-08 | P0 | unit | `normalizePhone(null)` → `null` (passthrough). |

## 2. Router — HTTP surface (integration with mocked service)

Covered by `tests/routes/integrations-analytics.test.js`.

| ID | Priority | Type | Description |
|----|----------|------|-------------|
| RTR-01 | P0 | integration | `GET /summary?from=...&to=...` with `analytics:read` scope returns 200 and pass-through of service payload plus `success:true` and `request_id`. |
| RTR-02 | P0 | integration | Same endpoint without `analytics:read` scope returns 403 `SCOPE_INSUFFICIENT`. |
| RTR-03 | P0 | integration | Empty/missing `from`/`to` → service throws `PERIOD_REQUIRED`, router returns 400 with code pass-through. |
| RTR-04 | P0 | integration | Unexpected `Error` from service → router returns 500 `INTERNAL_ERROR`. |
| RTR-05 | P0 | integration | `GET /calls` with valid params + scope returns 200 with `items` + `next_cursor`. |
| RTR-06 | P0 | integration | `GET /leads` same. |
| RTR-07 | P0 | integration | `GET /jobs` same. |
| RTR-08 | P1 | integration | Router forwards `req.integrationCompanyId` and `tracking_number` query param to the service in each endpoint. |

## 3. Auth middleware chain (existing integrationsAuth, covered by regression)

| ID | Priority | Type | Description |
|----|----------|------|-------------|
| AUTH-01 | P1 | existing | Missing `X-BLANC-API-KEY` or `X-BLANC-API-SECRET` returns 401 `AUTH_HEADERS_REQUIRED` (not changed — covered by integrations-leads suite). |
| AUTH-02 | P1 | existing | Legacy `?api_key=...` returns 401 `AUTH_LEGACY_REJECTED`. |
| AUTH-03 | P1 | existing | Revoked or expired integration returns 401 `AUTH_KEY_REVOKED` / `AUTH_KEY_EXPIRED`. |
| AUTH-04 | P1 | existing | Rate limiter bucket trips 429 `RATE_LIMITED` once `RATE_LIMIT_MAX_PER_KEY` exceeded. |

## 4. End-to-end SQL aggregation (manual / out-of-scope here)

Not covered by Jest — SQL correctness is validated against a real Postgres snapshot after deploy. Items listed for rollout hand-off:

| ID | Priority | Type | Description |
|----|----------|------|-------------|
| E2E-01 | P1 | manual | curl `/summary` for a known week → `calls.total` matches `SELECT COUNT(*) FROM calls WHERE direction='inbound' AND to_number matches` for that week. |
| E2E-02 | P1 | manual | `leads.from_tracking_calls` ≤ `leads.created`. |
| E2E-03 | P1 | manual | `jobs.revenue_invoiced` equals hand-summed `invoice_total` of the returned `listJobs` rows. |
| E2E-04 | P1 | manual | `funnel.jobs_per_answered_call` ≈ `funnel.leads_per_answered_call × funnel.jobs_per_lead` (within rounding). |
| E2E-05 | P2 | manual | `tracking_number=+16175551234` filters to a different DID's call set. |
| E2E-06 | P2 | manual | Request with `to - from > 92 days` → 400 `PERIOD_TOO_LARGE` from production deploy. |

## 5. Key issuance script

| ID | Priority | Type | Description |
|----|----------|------|-------------|
| KEY-01 | P1 | manual | `node backend/scripts/issue-analytics-key.js --client "ABC Homes Google Ads"` prints key_id + secret once, inserts row with `scopes=['analytics:read']`. |
| KEY-02 | P1 | manual | Running the script without `BLANC_SERVER_PEPPER` exits non-zero with clear error. |
| KEY-03 | P2 | manual | `--expires-days 30` populates `expires_at`; after that date `AUTH_KEY_EXPIRED` is returned. |

## 6. Documentation

| ID | Priority | Type | Description |
|----|----------|------|-------------|
| DOC-01 | P2 | review | Response shape in spec (`period`, `calls`, `leads`, `jobs`, `funnel`) matches code output. |
| DOC-02 | P2 | review | Changelog entry lists added files and the new `analytics:read` scope. |
