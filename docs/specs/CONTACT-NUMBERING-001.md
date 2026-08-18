# CONTACT-NUMBERING-001 — durable code + code URL for contacts

Smallest of the numbering conversions. Owner: **durable code + URL only** (no per-company
"Client #" — contacts have no number concept). Mirrors only the `public_code` half of
JOB/LEAD numbering.

## Problem
Contacts (клиенты) are opened by their GLOBAL `contacts.id` (BIGSERIAL PK) in the in-app
URL `/contacts/:id` (and `/pulse/contact/:id`). It is enumerable / reveals PK magnitude.
Resolution is already company-scoped fail-closed (`getContactById` → `WHERE company_id=$1
AND id=$2`), so there is NO cross-tenant access leak and NO customer-facing number — this
is internal-URL hardening (unguessable code instead of the sequential global id), not a
customer leak fix.

## Model
- **`contacts.id`** (BIGSERIAL PK) — internal key, UNCHANGED. `contact_id` FK is load-bearing
  across jobs/leads/estimates/invoices/payments/calls/emails/tasks — all keep using `id`.
- **`contacts.public_code`** (TEXT, 5×base62, UNIQUE, global) — NEW. `contact_public_code(id)`
  keyed Feistel, reusing GUC `app.job_code_feistel_key` (no new env). Canonical in-app URL.
- NO per-company `contact_seq`, NO displayed number (owner).

## URL routing (code-based; mirror the jobs by-code half)
- Canonical: `/contacts/:code` → `getContactByCode(code)` (global lookup; route enforces
  session-company match → 404 cross-tenant) → open the contact. Same for `/pulse/contact/:code`.
- `/contacts/by-id/:id` + `/pulse/contact/by-id/:id` shims → resolve id→public_code→redirect
  to `/contacts/:code`. For FK-only builders (tasks parentPath, LeadInfoSections, JobInfoSections,
  PulseContactItem, ContactsPage click, notificationPayloadBuilder). Old `/contacts/:id` links
  keep working via the by-id shim path only where builders route through it; a bare numeric
  `/contacts/:id` is superseded — builders switch to `/contacts/by-id/:id`.
- `/api/contacts/:id/*` data endpoints unchanged (company-scoped).

## Backend (Codex)
- Migration: `contacts.public_code` + `uq_contacts_public_code` + `contact_public_code(id)`
  (copy `lead_public_code`) + BEFORE INSERT trigger + idempotent backfill. Reuse jobs GUC key.
- `getContactByCode(publicCode)` (global) + route `GET /api/contacts/by-code/:code`
  (requirePermission contacts.view; cross-tenant 404). DTO carries `public_code`. Envelope
  `{ ok, data }` (codebase standard).
- MCP additive: contact projections expose `public_code` (keep id).
- Tests: unique code per contact; getContactByCode tenant isolation + route 404; DTO field.

## Frontend (Claude)
- `contactsApi`: `getContactByCode(code)`; Contact type +public_code.
- `ContactRedirect` (mirror DocRedirect): ContactByIdRedirect (id→code→`/contacts/:code`).
- App.tsx: `/contacts/:code` + `/contacts/by-id/:id` (+ pulse variants).
- ContactsPage/PulsePage: resolve `:code` → open contact; keep numeric back-compat minimal.
- Link builders (tasksApi, LeadInfoSections, JobInfoSections, PulseContactItem, notification)
  → `/contacts/by-id/:id` / `/pulse/contact/by-id/:id`.

## Constraints
- `contacts.id` + every `contact_id` FK UNCHANGED. No number display. Accumulate LOCALLY —
  do NOT push to master (owner). Reuse the jobs Feistel GUC key.
