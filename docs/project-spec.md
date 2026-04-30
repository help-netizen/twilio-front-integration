# Blanc Contact Center — Project Spec

> Обзор проекта, стек технологий, деплой, интеграции.

---

## Estimates

Estimates are client-facing repair documents created from Lead or Job financial contexts. The canonical display number is `ESTIMATE L-{leadNumber}-{sequence}`; for Job-created estimates, the sequence is scoped to the Job. The estimate UUID/database id is stable; the display number may change when the estimate is linked to a different Lead/Job context.

Core storage is relational PostgreSQL, not XML. Estimate rows hold document-level fields such as Summary, tax rate, discount type/value, archive metadata, signature requirement, and approved snapshot. Estimate items are generic custom rows with future-compatible Price Book references; item type/category may exist internally but is not shown in the estimate composer.

Lifecycle:
- Active statuses: `draft`, `sent`, `viewed`, `approved`, `declined`
- P0 send is a workflow stub that asks for `Email` or `Text` and does not mutate status.
- Approve requires at least one item and stores an approved snapshot.
- Editing any non-draft estimate resets it to `draft`; editing an approved estimate preserves the approved version in history.
- Archive sets `archived_at`/`archived_by` without changing status. Archived estimates are read-only, hidden from public portal access, and visible internally only when `All` is selected.

Client-facing Preview/PDF content includes optional Summary, items, totals, tax as an aggregate line only, and Blanc default Terms & Warranty. Per-item taxable markers are internal UI only.

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
