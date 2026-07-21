# SCHEDULE-CONTACT-NAME-001 — live contact names on Schedule jobs

**Status:** implemented, pending team-lead acceptance · **Date:** 2026-07-21 · **Owner frame:** `OB-20`

## Goal

Schedule job tiles must reflect a linked contact rename immediately. Jobs without
a linked contact must continue to show their denormalized `jobs.customer_name`.

## Decisions and scope

- The jobs branch of the unified Schedule read model `LEFT JOIN`s `contacts` and
  exposes `COALESCE(c.full_name, j.customer_name)` as both `subtitle` and
  `customer_name`.
- The join is scoped by both identity and tenant:
  `c.id = j.contact_id AND c.company_id = j.company_id`.
- Schedule search uses the same live-name expression as the tile.
- Leads and tasks are unchanged. Every Schedule tile/list/map consumer continues
  to use the existing unified item response; no frontend fork is added.
- The denormalized job write path, contact rename paths, Schedule detail lookup,
  and historical data are unchanged. There is no migration or backfill.
- `createFromSlot` still writes `slotData.customer_name`; this is the deliberate
  denormalized write path and is outside this read-only fix.

## Tenancy and verification contract

- `T-own`: a job linked to a same-company contact shows the contact's live name.
- `T-foreign`: a foreign-company contact cannot supply a name, even if a malformed
  cross-tenant `contact_id` exists; the job falls back to its own denormalized name.
- `T-blast`: reading company A neither returns nor mutates company B jobs.
- A contact-less job shows `jobs.customer_name`.
- Existing `GET /api/schedule` authentication, company derivation, provider scope,
  permission matrix, and 404 behavior are unchanged.

The behavioral PostgreSQL gate is `tests/scheduleContactName.db.test.js`; its
structural half always runs, while its transaction-backed tenant fixture runs when
`SCHEDULE_CONTACT_NAME_TEST_DB_URL` is provided.
