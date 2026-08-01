# APP-MOD-001 — App Studio moderation and version transitions

Status: **IMPLEMENTED — verification recorded 2026-08-01.**

Parent contracts: `APP-STUDIO-001.md` §4, `APP-STUDIO-GAP-AUDIT.md`
P1-05, `APP-GW-001.md`, `LAYOUT-CANON.md`, and `FORM-CANON.md`.

## 1. Proposal

One `appVersionTransitionService` owns every version-status mutation. Each
mutation starts a PostgreSQL transaction, locks the exact version with
`SELECT ... FOR UPDATE`, validates the current state against the fixed
transition matrix, writes the new state, and inserts an awaited
`app_version.transition` row in `audit_log` before commit.

The author may create and edit drafts freely. The tenant-scoped App Studio API
adds submit, publish-after-approval, and rejected-version fork actions. The
platform API reuses the existing `/api/platform/app-reviews` mount and adds the
global application-version queue, detail, start-review, approve, reject, and
revoke actions. The existing numeric `/:id/moderate` product-rating endpoint is
kept for backward compatibility.

The Super admin **Apps** tab uses a two-column queue/detail workspace. Opening
a submitted request claims it with `submitted→in_review`; the visible decision
actions are Approve, Reject, and Revoke. Detail returns the app/company profile,
a bounded line diff against the prior approved version, requested tools,
scanner report, latest stored sandbox validation, and every retained builder
message. Full source is fetched only after **Show code** is pressed.

## 2. Decisions taken

1. The exact allowed mutations are `draft→submitted`,
   `submitted→in_review`, `in_review→approved`, `in_review→rejected`,
   `approved→published`, and `published→revoked`. Every other pair returns
   `409 VERSION_TRANSITION_CONFLICT` without changing the row.
2. Super-admin approval ends at `approved`. The author can then publish without
   another approval. This preserves the explicit `approved→published` state and
   makes approval, rather than draft iteration, the sole production gate.
3. The platform detail selection calls
   `POST /api/platform/app-reviews/:versionId/start-review`; GET remains
   side-effect free. Concurrent claims are serialized and an already
   `in_review` request is returned idempotently to allow UI retries.
4. Rejection requires a trimmed reason of 1–2,000 characters. The rejected
   artifact remains immutable and a separate assistant message containing the
   reason is appended to the builder chat associated with the version.
5. `rejected→draft` is never a status update. Fork copies source, hash, scanner
   report, and tool rows into a new `draft` version under the same tenant-owned
   app.
6. Publishing sets the Marketplace app profile to `published` and advances
   only connected installations in the owning live company that already have
   a valid `metadata.app_runtime` consent snapshot. Existing consented tool
   names are preserved, so a new version cannot widen consent. Until publish,
   installation metadata remains pinned to the previous version.
7. Revocation changes only `published→revoked`. Installations retain their
   pinned version id; the gateway's live version-status check therefore rejects
   the next mint, resolve, or tool call with 403.
8. The migration is `223_app_version_moderation.sql`, checked against both the
   worktree and `origin/master` maximum of 222, with
   `rollback_223_app_version_moderation.sql`.
9. The database adds `rejected`, submission/rejection metadata, an exact
   transition trigger, and stronger artifact/tool triggers. A source, hash,
   scanner report, identity, or allowlist mutation in the same statement that
   leaves draft is rejected. Tool mutations lock the parent version row.
10. Platform list/detail queries are deliberately global and are reachable
    only behind `requirePlatformRole('super_admin')`. Author operations always
    join `app_studio_apps` on the `company_id` sourced from
    `req.companyFilter.company_id`; foreign rows are 404.
11. Phase 5 returned but deliberately discarded the bounded synthetic dry-run
    result. This phase stores that already bounded, synthetic-only value under
    `scanner_report.dry_run.result` so the owner-required moderation card can
    show the latest sandbox outcome. No production CRM row is included.

## 3. HTTP contract

Tenant-scoped App Studio actions:

- `POST /api/app-studio/apps/:appId/versions/:versionId/submit`
- `POST /api/app-studio/apps/:appId/versions/:versionId/publish`
- `POST /api/app-studio/apps/:appId/versions/:versionId/fork`

Platform super-admin actions:

- `GET /api/platform/app-reviews?status=pending|published|rejected|revoked`
- `GET /api/platform/app-reviews/:versionId[?include_code=true]`
- `POST /api/platform/app-reviews/:versionId/start-review`
- `POST /api/platform/app-reviews/:versionId/approve`
- `POST /api/platform/app-reviews/:versionId/reject` with `{ "reason": "..." }`
- `POST /api/platform/app-reviews/:versionId/revoke`

All successful mutation responses return the resulting version. Conflict
responses are 409; tenant ownership misses are 404; malformed UUIDs are 404;
invalid rejection bodies are 422.

## 4. Security and audit

- Transition selection is locked and app ownership is resolved in the same
  query. Tenant actions include exact `company_id + app_id + version_id`.
- `created_by`/review actor values use `req.user.crmUser.id` only.
- Audit details contain only `from_status`, `to_status`, reason (when present),
  app/version ids, and outcome metadata; source and chat text are never copied
  into audit.
- Platform detail access is audited with `code_revealed` so access to retained
  builder conversation and source is attributable.
- SQL is parameterized. The UI never sends or derives a company selector.

## 5. Verification contract

1. Real PostgreSQL matrix proves every allowed edge, every denied pair, fork,
   audit, source/hash/allowlist immutability, same-update immutability, and
   T-own/T-foreign/T-blast behavior.
2. Two real PostgreSQL clients approve the same `in_review` version in
   parallel. Exactly one succeeds. The named sabotage removes `FOR UPDATE`,
   makes the race test red, then restores the exact edit.
3. Route tests prove every platform R-matrix deny cell, actor propagation,
   rejection validation/message behavior, and tenant foreign 404.
4. Gateway integration proves service-driven revoke makes the next live call
   fail with 403.
5. Frontend Vitest covers queue/detail rendering, source reveal, rejection
   reason UI, action availability, and canonical token/layout source guards.

## 6. Risks

1. The prior-version diff is line-oriented and bounded; it is a review aid,
   not a semantic JavaScript diff.
2. Publication advances only the owning company's already-consented connected
   installations. Public Marketplace rollout and cross-company upgrade policy
   remain Phase 8 work.
3. Retention cleanup may already have removed old builder messages. “Full
   conversation” means every retained message; moderation does not bypass the
   approved retention window.

## 7. Out of scope / next

Egress, public Marketplace catalog/commerce, verified publisher/KYC, new
runtime tools, write permissions, and cross-company public rollout are not
added. A later phase may add explicit reviewer assignment/SLA without changing
the transition boundary.

## 8. Verification recorded

- Affected CRM Jest: 5 suites, 57 tests passed with real PostgreSQL,
  `--runInBand --forceExit`.
- Frontend production build: passed.
- APP-MOD frontend Vitest: 1 file, 4 tests passed.
- Full frontend Vitest: 61 files / 356 tests passed; three unrelated baseline
  assertions remain red (`IntegrationsPage.test.ts`, `settingsNav.test.ts`, and
  `settingsRouteCompleteness.test.ts`). They expect the pre-existing
  `MarketplaceBrowser`/pre-Analytics navigation rather than current master.
- Sabotage red name:
  `SAB APP-MOD-P1-05 concurrent approve requires FOR UPDATE: exactly one succeeds`.
  Removing the service lock produced two fulfilled approvals and exit 1;
  restoring the exact line returned the test to green.
