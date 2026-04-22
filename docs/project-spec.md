# Blanc Contact Center — Project Spec

> Обзор проекта, стек технологий, деплой, интеграции.

---

## External Integrations API

Token-authenticated HTTP surface mounted at `/api/v1/integrations`. All endpoints share the same auth chain (`rejectLegacyAuth → validateHeaders → authenticateIntegration → rateLimiter`) and the same error envelope `{ success, code, message, request_id }`.

| Method | Path | Scope | Purpose |
|--------|------|-------|---------|
| POST | `/leads` | `leads:create` | External lead ingestion (Workiz-compatible) |
| GET  | `/analytics/summary` | `analytics:read` | Ads funnel metrics for a period |
| GET  | `/analytics/calls` | `analytics:read` | Paged inbound calls to tracking DID |
| GET  | `/analytics/leads` | `analytics:read` | Paged leads in period + tracking-call attribution |
| GET  | `/analytics/jobs` | `analytics:read` | Paged jobs linked to period's leads |

Keys are generated via:
- `backend/scripts/issue-analytics-key.js` for `analytics:read`
- the admin UI (`/api/admin/integrations`) for `leads:create`

Secrets are stored as `SHA-256(secret + BLANC_SERVER_PEPPER)` and never logged. Per-company isolation is enforced via `api_integrations.company_id` → `req.integrationCompanyId`.
