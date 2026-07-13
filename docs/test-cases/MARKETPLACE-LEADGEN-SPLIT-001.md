# Test Cases: MARKETPLACE-LEADGEN-SPLIT-001 — split «Lead Generator» into five per-source lead apps (migration 169 + boot line + shared-credential disconnect guard)

**Spec (AUTHORITATIVE):** `Docs/specs/MARKETPLACE-LEADGEN-SPLIT-001.md` (scenarios M1–M8, G1–G9, C1–C6; §2 exact contracts; §7 invariants 1–14). **Architecture:** `Docs/architecture.md` «MARKETPLACE-LEADGEN-SPLIT-001 — architecture» (D1–D3). **Requirements:** `Docs/requirements.md` «MARKETPLACE-LEADGEN-SPLIT-001» (US-1..6, FR-1..7, NFR-1..6).
**Change under test (complete):** NEW `backend/db/migrations/169_split_lead_generator_marketplace_apps.sql` + `rollback_169_*.sql`; ONE boot-list line in `backend/src/db/marketplaceQueries.js` `ensureMarketplaceSchema` (after the 161 entry, i.e. after 083) + NEW exported helper `countOtherActiveInstallationsOnCredential`; guarded region :516-544 of `disconnectInstallation` in `backend/src/services/marketplaceService.js`. Nothing else.

## Locked design facts these cases assert against (from spec §2 — do not re-litigate)

1. Migration 169 = strictly three statements: (1) `IS DISTINCT FROM`-guarded rename UPDATE (name + both descriptions + `updated_at` ONLY); (2) four-row `INSERT … ON CONFLICT (app_key) DO UPDATE` with the §2.1(2) exact values; (3) default-co INSERT-SELECT with `CROSS JOIN LATERAL` credential resolve (never hardcoded) + **status-blind** `NOT EXISTS`. No events seeded, no `RAISE NOTICE`, no `CONCURRENTLY`, no own BEGIN/COMMIT (runs inside the ensure-list transaction).
2. `ensureMarketplaceSchema(client)` (client-arg path, marketplaceQueries.js:15-48) skips the memo and replays the WHOLE list on the given client; only the pooled no-client path sets `schemaReady=true`. 083's `ON CONFLICT DO UPDATE` re-asserts «Lead Generator» every replay ⇒ 169 must run after it (FR-3).
3. Partial-unique index `idx_marketplace_installations_one_active (company_id, app_id) WHERE status IN ('connected','provisioning_failed')` (083:63-65) ignores disconnected/revoked rows — this is why the seed's NOT EXISTS must be status-blind (M5) and why an ON CONFLICT-style seed would resurrect.
4. Guard helper: `countOtherActiveInstallationsOnCredential(companyId, apiIntegrationId, excludeInstallationId, client)` → 0 immediately on falsy credential (BEFORE any query); else company-scoped COUNT over status IN `('connected','provisioning_failed')`, `id <> excludeInstallationId`.
5. Disconnect truth table (§2.4): rows 1–3 = today's behavior byte-compatible; row 4 (shared, `otherActive>0`) = revoke SKIPPED, status `'disconnected'`, event payload `{ credential_revoked:false, credential_shared:true }`. 404/409 preconditions run BEFORE the helper; helper runs INSIDE the txn on the same client. HTTP response shape `{ id, status, disconnected_at }` unchanged.
6. `revokeCredentialById` call sites = exactly 4 (marketplaceService.js:426/:516/:580/:667); ONLY :516 gains the guard.
7. 083 baseline strings the rollback must restore verbatim: name «Lead Generator», short «Creates inbound leads from external campaigns.», long «Posts validated campaign leads into Blanc with source attribution.»; `provider_name='Blanc Labs'`, `support_email='support@blanc.local'`, `privacy_url='https://blanc.local/privacy'`, `docs_url='/settings/api-docs'`, `metadata={"access_summary":["Create leads"]}` — the rename touches NONE of these.

## Harness & conventions (verified in-repo 2026-07-13)

- **Run form (worktree gotcha — root `package.json` jest config ignores `/\.claude/worktrees/`, and the worktree has NO own node_modules; the explicit flag overrides the skip):**
  `node /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js tests/marketplaceLeadgenSplit.test.js --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit`
  (same form for `tests/marketplaceLeadgenSplit.db.test.js`).
- **Unit suite** (`tests/marketplaceLeadgenSplit.test.js`) — exact precedent `tests/marketplaceTelephonyOverlay.test.js:34-56`: `jest.mock` `../backend/src/db/connection` (`{ query: jest.fn(), pool: { connect: jest.fn() } }` → `mockClient = { query: jest.fn(), release: jest.fn() }`), `../backend/src/db/marketplaceQueries` (factory = the telephonyOverlay list **plus the NEW `countOtherActiveInstallationsOnCredential: jest.fn()`**), `emailQueries`, `emailMailboxService`, `integrationsService`, `marketplaceProvisioningService`. Run the REAL `marketplaceService`. `beforeEach`: `jest.resetAllMocks()`, `db.pool.connect.mockResolvedValue(mockClient)`, `queries.ensureMarketplaceSchema.mockResolvedValue(undefined)`.
- **DB suite** (`tests/marketplaceLeadgenSplit.db.test.js`) — real PostgreSQL, `dbReady` beforeAll probe + per-test `SKIPPED-NEEDS-DB` self-skip (yelpSendsBackfill.db.test.js:48,237-250 pattern; probe = `SELECT 1 FROM companies LIMIT 1` + `SELECT 1 FROM api_integrations LIMIT 1`). **Every case runs on a dedicated pool client wrapped in `BEGIN … ROLLBACK`** (`withTxn(fn)` helper; ROLLBACK in `finally`) — 169 is txn-safe, zero residue on the shared dev DB even for DELETE-heavy fixtures. `afterAll`: `db.pool.end()`.
  - **Memo caveat:** the suite must NEVER call a marketplaceQueries function without the txn client — only the pooled path flips the module-level `schemaReady` memo, and TC-M3-01 needs `ensureMarketplaceSchema(client)` to actually replay the list.
  - **`resetToPre169(client)` fixture (deterministic mig-168 + prod-like state, all inside the txn):** (1) `CREATE OR REPLACE FUNCTION update_updated_at_column() …` (same DDL as marketplaceQueries.js:18-26 — pristine-DB safety); (2) apply raw `083_create_marketplace_apps.sql` via `readMigration` (creates tables, re-asserts the «Lead Generator» baseline); (3) DELETE `marketplace_installations` whose app_id resolves to the four new keys (ALL companies), then DELETE the four `marketplace_apps` rows (undoes any boot-applied 169 on the dev DB); (4) DELETE default-co `lead-generator` installations; (5) INSERT fixture credential `api_integrations` **id 424242** (`client_name='MLS-fixture'`, `key_id='ak_mls_<TAG>'` — TAG = `MLS-${Date.now()}-${process.pid}`, `secret_hash='x'`, `scopes='["leads:create"]'`, `company_id=DEFAULT_COMPANY_ID`) and decoy credential **id 424243**; (6) INSERT default-co `lead-generator` installations: the SOURCE row (`status='connected'`, `api_integration_id=424242`, `created_at=NOW()`) → `sourceInstallationId`, plus an OLDER DECOY row (`status='disconnected'`, `api_integration_id=424243`, `created_at=NOW()-interval '1 day'`) — proves the LATERAL filters on status AND resolves by subquery, and arms SAB-CREDENTIAL-HARDCODE (424242 ≠ 1).
  - `apply169(client)` / `applyRollback169(client)` = `client.query(readMigration('169_…sql'))` / `('rollback_169_…sql')` (multi-statement simple-query, same as the ensure list does).
- **Agent-04 checklist deviation (by design):** no new HTTP endpoint ⇒ no new 401/403 cases; the router gate (`authenticate + requirePermission('tenant.integrations.manage') + requireCompanyAccess`, src/server.js:267) is untouched and stays pinned by `tests/routes/marketplace.test.js`. Tenant isolation IS covered: TC-M1-01/TC-C4-01 (seed default-co only), TC-G5-01 (cross-company rows never counted), TC-G9-01a (foreign/unknown installation id → 404 via company-scoped `getInstallationById`), TC-M7-01 (rollback blast radius).

## Coverage

- **Total test cases: 27**
- **P0: 10 · P1: 11 · P2: 5 · P3: 1**
- **db real-PG self-skip: 14** (`tests/marketplaceLeadgenSplit.db.test.js`) · **unit-mocked: 10** + **structural: 3** (`tests/marketplaceLeadgenSplit.test.js`)
- Every spec scenario M1–M8, G1–G9, C1–C6 has ≥1 case (matrix at the end).

## Named sabotage controls (first-class; procedure: apply the sabotage manually, confirm RED, revert)

| # | Property | Control case(s) | Sabotage | Exact red-condition |
|---|---|---|---|---|
| 1 | Rename + catalog survive every boot (FR-3 ordering) | TC-M3-01 | **SAB-BOOT-DROP-169** — delete the `await query(readMigration('169_split_lead_generator_marketplace_apps.sql'))` line from `ensureMarketplaceSchema` (equivalently: move it BEFORE the 083 line) | TC-M3-01 RED: after the REAL `ensureMarketplaceSchema(client)` replay, `SELECT name FROM marketplace_apps WHERE app_key='lead-generator'` = `'Lead Generator'` (expected `'Website Leads'`) and the four-new-key COUNT = 0 (expected 4; on the mis-order variant the name assert alone goes red) |
| 2 | One shared-source Disconnect never kills the live token (FR-5/US-5) | TC-G1-01 (+TC-G8-01) | **SAB-GUARD-DROP** — remove the `otherActive` computation/condition in `disconnectInstallation` (revert :516 to the unconditional pre-feature revoke) | TC-G1-01 RED: `queries.revokeCredentialById` **was called** with `(1, COMPANY, mockClient)` where the case expects `.not.toHaveBeenCalled()`; a `writeEvent` call with `eventType:'credential_revoked'` appears (expected zero); the `'disconnected'` event payload lacks `credential_shared:true`. TC-G8-01 RED the same way on the first disconnect |
| 3 | Boot replay never resurrects an owner-disconnected source (FR-4/M5) | TC-M5-01 | **SAB-SEED-ONCONFLICT** — replace statement (3)'s status-blind `NOT EXISTS` with an `ON CONFLICT`-style insert keyed on the partial-unique index | TC-M5-01 RED: after flipping the seeded (default-co, `nsa-leads`) row to `'disconnected'` and re-applying 169, the (default-co, `nsa-leads`) row count = 2 with a fresh `'connected'` row (the partial index ignores inactive rows), or the single row reads `'connected'` again — expected exactly 1 row, still `'disconnected'` (same red for the `'revoked'` variant) |
| 4 | Credential resolved from the newest CONNECTED source installation, never hardcoded (FR-4) | TC-M1-01 (+TC-M4-01) | **SAB-CREDENTIAL-HARDCODE** — replace the `CROSS JOIN LATERAL` subquery with a literal `api_integration_id` (e.g. `1`) | TC-M1-01 RED: the four seeded rows carry `api_integration_id = 1 ≠ 424242` (the txn fixture id; the decoy 424243 assert also proves status-filtering), or the INSERT throws FK `23503` on a DB with no committed id=1 — red either way. TC-M4-01 RED: the no-source variants seed 4 rows anyway (expected 0) |

---

## §M — migration & boot (db real-PG self-skip, `tests/marketplaceLeadgenSplit.db.test.js`)

### TC-M1-01 · fresh apply: exact catalog + default-co seed on the resolved shared credential — P0 · db · covers M1, FR-1/2/4, NFR-1 — **SAB-CREDENTIAL-HARDCODE control**
- **Target seam:** raw `169_split_lead_generator_marketplace_apps.sql` over a mig-168-equivalent state.
- **Setup:** `withTxn` → `resetToPre169(client)` (source row on 424242 + older disconnected decoy on 424243). Snapshot: full `lead-generator` row; `SELECT COUNT(*) FROM marketplace_installation_events`; full `api_integrations` (`SELECT * ORDER BY id`).
- **Steps:** `apply169(client)`; re-select.
- **Expected:**
  - `marketplace_apps WHERE category='lead_generation'` = exactly 5 rows: app_keys `lead-generator`, `pro-referral-leads`, `rely-leads`, `nsa-leads`, `lhg-leads`.
  - `lead-generator`: `name='Website Leads'`, `short_description='Creates inbound leads from your company website.'`, `long_description='Posts orders and form submissions from your company website into Albusto as leads with source attribution.'`; EVERY other column deep-equal to the pre-apply snapshot (incl. `app_key`, `provider_name='Blanc Labs'`, `requested_scopes`, `support_email='support@blanc.local'`, `privacy_url`, `docs_url`, `metadata`, `created_at`) — only `updated_at` may differ.
  - Four new installations exist ONLY for `00000000-0000-0000-0000-000000000001` (a `WHERE company_id <> default AND app_key IN (four keys)` join returns 0): each `status='connected'`, **`api_integration_id=424242`** (resolved from the newest CONNECTED source row — NOT 424243, NOT 1), `installed_at` NOT NULL, `installed_by` NULL, `metadata` `toEqual({ seeded_by: 'MARKETPLACE-LEADGEN-SPLIT-001', shared_credential: true })`.
  - `marketplace_installation_events` count unchanged (zero seeded); `api_integrations` snapshot deep-equal (NFR-1, incl. every `updated_at` — the UPDATE trigger would betray any write).
  - The original source installation row (id `sourceInstallationId`) byte-identical.

### TC-M2-01 · idempotent re-apply: ids/rows stable, credential untouched — P0 · db · covers M2, NFR-2
- **Target seam:** double/triple application of the raw file (models psql-at-deploy + boot replays).
- **Setup:** `withTxn` → `resetToPre169` → `apply169`. Snapshot A: `SELECT id, app_key, name, … (all non-updated_at columns) FROM marketplace_apps WHERE category='lead_generation' ORDER BY app_key`; snapshot B: `SELECT * FROM marketplace_installations WHERE company_id=default ORDER BY id` (ids, statuses, metadata, `updated_at` too — NOT EXISTS must suppress even an UPDATE); `api_integrations` snapshot.
- **Steps:** `apply169(client)` twice more; re-select.
- **Expected:** apps: same 5 ids, all non-`updated_at` columns deep-equal to snapshot A (`updated_at` MAY refresh — DO UPDATE); installations: deep-equal to snapshot B **including `updated_at` and row count** (no new row, no touched row — a second active row would anyway violate `idx_marketplace_installations_one_active`); `api_integrations` deep-equal; events count unchanged.

### TC-M2-02 · migration-file hygiene: txn-safe, silent, documented rollback header — P2 · structural (lives in the unit file) · covers M2/§2.1/§2.3 file contracts
- **Target seam:** the two NEW SQL files as text (`fs.readFileSync`).
- **Steps/Expected:** forward file: NO `/RAISE\s+NOTICE/i`, NO `/CONCURRENTLY/i`, NO own txn control (`/^\s*(BEGIN|COMMIT)\s*;/im` zero matches — the ensure list wraps it), NO `'Blanc'` outside `--` comment lines, contains the literal `'LHG Leads'` and `seeded_by":"MARKETPLACE-LEADGEN-SPLIT-001`, contains `NOT EXISTS` and `CROSS JOIN LATERAL` (shape pins backing the behavioral cases), does NOT contain `/enforc/i`. Rollback file: header `--` comments mention `ensureMarketplaceSchema` (line-removal instruction), `ON DELETE SET NULL` (orphaned self-service credentials note) and that the original `lead-generator` installation / live `api_integrations` row are untouched; statements NO `RAISE NOTICE`/`CONCURRENTLY`.

### TC-M3-01 · boot replay: 083 re-asserts, 169 re-heals — rename + rows survive, behaviorally — P0 · db · covers M3, FR-3 — **SAB-BOOT-DROP-169 control**
- **Target seam:** the REAL `marketplaceQueries.ensureMarketplaceSchema(client)` (client-arg path replays the FULL registered list — the memo is skipped; see memo caveat).
- **Setup:** `withTxn` → `resetToPre169(client)` (state where 083 has JUST re-asserted «Lead Generator» and the four apps are absent — exactly what every boot starts from).
- **Steps:** `await marketplaceQueries.ensureMarketplaceSchema(client)`; select.
- **Expected:** `lead-generator`.name = `'Website Leads'` (the ONLY way this holds is a 169 entry ordered after 083 — behavioral proof, no source grep); four new app rows exist with `status='published'`; four default-co installation rows exist on 424242 (the seed also replays). Repeat `ensureMarketplaceSchema(client)` a second time → still `'Website Leads'`, row counts unchanged (boot-idempotency through the real path). **Red under SAB-BOOT-DROP-169** (both the missing-line and ordered-before-083 variants).

### TC-M4-01 · no eligible source installation ⇒ seeds nothing, never a NULL-credential 'connected' row — P1 · db · covers M4, US-4 semantics — **SAB-CREDENTIAL-HARDCODE secondary control**
- **Target seam:** statement (3)'s LATERAL emptiness.
- **Setup (three variants, each its own `withTxn` + `resetToPre169` mutation):** (a) DELETE all default-co `lead-generator` installations; (b) keep only the row with `status='disconnected'`; (c) keep one `'connected'` row but `api_integration_id=NULL`.
- **Steps:** `apply169(client)`.
- **Expected (each variant):** statements 1–2 still applied (rename done, 4 app rows exist); `marketplace_installations` for (default-co × four new keys) count = **0**; specifically NO row with `status='connected' AND api_integration_id IS NULL` exists anywhere for the four keys. Follow-up in variant (a): INSERT a fresh connected source row on 424242, `apply169` again → NOW four rows seed (self-heal leg of M4).

### TC-M5-01 · disconnected-row non-resurrection across replays — P0 · db · covers M5, FR-4 hazard (c) — **SAB-SEED-ONCONFLICT control**
- **Target seam:** the status-blind NOT EXISTS vs the partial-unique index.
- **Setup:** `withTxn` → `resetToPre169` → `apply169` (M1 state). `UPDATE marketplace_installations SET status='disconnected' WHERE company_id=default AND app_id=(SELECT id FROM marketplace_apps WHERE app_key='nsa-leads')`.
- **Steps:** `apply169(client)` (boot replay); repeat once more. Then flip the same row to `'revoked'` and `apply169` again.
- **Expected:** after every replay the (default-co, `nsa-leads`) row count is exactly **1** and its status is exactly what the owner left (`'disconnected'`, then `'revoked'`); its `id`/`updated_at` unchanged by the replays; the other three seeded rows + the original `lead-generator` row untouched. **Red under SAB-SEED-ONCONFLICT.**

### TC-M6-01 · rollback: catalog restored, live installation + credential byte-identical, re-run no-op — P0 · db · covers M6, FR-7, US-6
- **Target seam:** raw `rollback_169_*.sql`.
- **Setup:** `withTxn` → `resetToPre169` → `apply169`. Snapshots: full source installation row; `api_integrations`; full `call-qa-agent` row; events count.
- **Steps:** `applyRollback169(client)`; snapshot state R1; `applyRollback169(client)` again; snapshot R2.
- **Expected (R1):** zero `marketplace_apps` rows for the four keys; zero installations referencing them (deleted FIRST — the whole file succeeds despite `app_id` ON DELETE RESTRICT); `lead-generator` reads the exact 083 strings (locked fact 7) — name `'Lead Generator'`, short `'Creates inbound leads from external campaigns.'`, long `'Posts validated campaign leads into Blanc with source attribution.'`; source installation row deep-equal to its snapshot (id, `status='connected'`, `api_integration_id=424242`, timestamps); `api_integrations` deep-equal (424242 `revoked_at` still NULL); `call-qa-agent` row deep-equal; events count unchanged by the rollback itself. **(R2):** deep-equal to R1 in all four tables — every rollback statement no-ops when already rolled back (incl. the guarded restore-UPDATE: `lead-generator.updated_at` identical between R1 and R2).

### TC-M7-01 · rollback with another company's self-service install: row deleted, minted credential orphaned-but-alive — P1 · db · covers M7, FR-7 blast radius
- **Setup:** `withTxn` → `resetToPre169` → `apply169`. Create company B (`INSERT INTO companies (id, name, slug) VALUES (randomUUID(), 'MLS Co B', 'mls-b-<tag>')`); INSERT B's minted credential into `api_integrations` (id 424244, `company_id=B`, `marketplace_app_id=<rely-leads app id>`, `revoked_at` NULL) — `marketplace_installation_id` set after: INSERT B's installation (`app_id=rely-leads`, `status='connected'`, `api_integration_id=424244`), then UPDATE the credential's `marketplace_installation_id` to it; INSERT one `marketplace_installation_events` row for B's install (fixture `event_type='connect_requested'`).
- **Steps:** `applyRollback169(client)`.
- **Expected:** B's installation row DELETED; B's `api_integrations` row 424244 SURVIVES with `revoked_at` NULL (valid-but-orphaned) and `marketplace_app_id` NULL + `marketplace_installation_id` NULL (ON DELETE SET NULL fired); the fixture event row SURVIVES with `installation_id` NULL and `app_id` NULL; default-co source installation + credential 424242 untouched.

### TC-M8-01 · NFR-1 acceptance gate: `api_integrations` byte-identical across the whole lifecycle — P0 · db · covers M8, NFR-1 (subsumes the per-case spot checks)
- **Target seam:** everything this feature executes, in sequence, against the ONE table that must never move.
- **Setup:** `withTxn` → `resetToPre169`. `snap = () => SELECT * FROM api_integrations ORDER BY id` (every column, every row — the BEFORE-UPDATE trigger makes any write visible via `updated_at`).
- **Steps + Expected:** S0 = snap → `apply169` → S1 → `apply169` → S2 → REAL `ensureMarketplaceSchema(client)` → S3 → `applyRollback169` → S4; assert S0 ≅ S1 ≅ S2 ≅ S3 ≅ S4 (deep-equal), and explicitly `revoked_at IS NULL` on 424242 at every step — `integrationsAuth.js:141` keeps accepting the live token; zero failed external posts attributable to the feature.

---

## §G — disconnect guard (unit-mocked in `tests/marketplaceLeadgenSplit.test.js` unless marked db)

Shared unit fixture: `COMPANY='00000000-0000-0000-0000-000000000001'`, NSA installation `INST = { id: 555, company_id: COMPANY, app_id: 'app-nsa', app_key: 'nsa-leads', status: 'connected', api_integration_id: 1, provisioning_mode: 'manual' }`; `queries.getInstallationById.mockResolvedValue(INST)`; `queries.markDisconnected.mockImplementation(async ({ status }) => ({ id: 555, status, disconnected_at: '2026-07-13T00:00:00.000Z' }))`; `queries.writeEvent.mockResolvedValue({})`. Helper mock = `queries.countOtherActiveInstallationsOnCredential`.

### TC-G1-01 · shared credential: disconnect ONE of five skips the revoke — P0 · unit-mocked · covers G1, US-5, truth-table row 4 — **SAB-GUARD-DROP control**
- **Target seam:** REAL `marketplaceService.disconnectInstallation` over mocked queries.
- **Setup:** helper mock → `4`.
- **Steps:** `await marketplaceService.disconnectInstallation(COMPANY, 'user-1', 555, { requestId: 'req-1' })`.
- **Expected:** helper called EXACTLY once with `(COMPANY, 1, 555, mockClient)`; **`queries.revokeCredentialById.not.toHaveBeenCalled()`**; `queries.writeEvent` called EXACTLY once — `eventType:'disconnected'`, `payload` `toEqual({ credential_revoked: false, credential_shared: true })`, `apiIntegrationId:1`, `installationId:555`, `appId:'app-nsa'`, second arg `mockClient`; zero calls with `eventType:'credential_revoked'`; `markDisconnected` called once with `({ companyId: COMPANY, installationId: 555, actorId: 'user-1', status: 'disconnected' }, mockClient)`; call order (`mock.invocationCallOrder`): `getInstallationById` < helper < `markDisconnected`; `mockClient.query` saw `'BEGIN'` and `'COMMIT'`, never `'ROLLBACK'`; `release()` called; return `toEqual({ id: 555, status: 'disconnected', disconnected_at: '2026-07-13T00:00:00.000Z' })`. **Red under SAB-GUARD-DROP.**

### TC-G2-01 · LAST active installation on the credential revokes — exactly today's behavior (also the sole-installation/non-lead-app leg) — P0 · unit-mocked · covers G2, truth-table row 2, FR-5 boundary
- **Setup:** helper mock → `0`; `queries.revokeCredentialById.mockResolvedValue({ id: 1, key_id: 'ak_live', revoked_at: '2026-07-13T00:00:00.000Z' })`.
- **Steps:** disconnect 555.
- **Expected:** revoke called EXACTLY once with `(1, COMPANY, mockClient)`; `writeEvent` called TWICE and in order — first `eventType:'credential_revoked'` with `payload toEqual({ reason: 'disconnect' })` (+ `apiIntegrationId:1`), then `eventType:'disconnected'` with `payload toEqual({ credential_revoked: true, credential_shared: false })`; `markDisconnected` status `'disconnected'`; COMMIT; return status `'disconnected'`. (Byte-compatible with pre-feature: this is what every non-lead app's disconnect does — spec G2 last sentence.)

### TC-G3-01 · guard-skipped disconnect does NOT cascade via `reconcileRevokedInstallations` — P1 · **db** · covers G3 (real SQL predicate; the reconciler is intentionally unedited)
- **Target seam:** REAL `marketplaceQueries.reconcileRevokedInstallations(companyId, client)` over the M1 seed.
- **Setup:** `withTxn` → `resetToPre169` → `apply169`; simulate the guard-skipped G1 outcome: `UPDATE … SET status='disconnected'` on the `nsa-leads` seeded row (credential 424242 `revoked_at` stays NULL — exactly what the guard guarantees).
- **Steps:** `await marketplaceQueries.reconcileRevokedInstallations(DEFAULT_COMPANY_ID, client)`; select the five rows. Then the NEGATIVE CONTROL proving the case isn't vacuous: `UPDATE api_integrations SET revoked_at=NOW() WHERE id=424242` (txn-local, rolled back), reconcile again, re-select.
- **Expected:** first reconcile: the four remaining rows still `'connected'`, none flipped (`ai.revoked_at IS NOT NULL` matches nothing); control: after the in-txn revoke ALL still-active rows on 424242 flip to `'revoked'` — the cascade the guard exists to prevent is real.

### TC-G4-01 · `retryProvisioning` unreachable for lead apps: 409 before any revoke — P2 · unit-mocked · covers G4 (retry leg)
- **Setup:** `queries.getInstallationById.mockResolvedValue({ id: 601, status: 'provisioning_failed', provisioning_mode: 'manual', app_key: 'rely-leads', api_integration_id: 1 })`.
- **Steps:** `await expect(marketplaceService.retryProvisioning(COMPANY, 'user-1', 601, {}))`.
- **Expected:** rejects `MarketplaceServiceError` `{ code: 'INSTALLATION_NOT_RETRYABLE', httpStatus: 409 }`; `revokeCredentialById` and the guard helper both `.not.toHaveBeenCalled()`.

### TC-G4-02 · revoke call-site audit stays 4-sites/1-guard — P2 · structural · covers G4 (sites audit)
- **Steps/Expected:** read `backend/src/services/marketplaceService.js`; `/revokeCredentialById\(/g` matches EXACTLY 4; slice the source between `async function disconnectInstallation` and `async function retryProvisioning`: it contains `countOtherActiveInstallationsOnCredential` and `/otherActive\s*===\s*0/`; the OTHER three sites' enclosing slices (installApp fail-leg, retryProvisioning both legs) contain NO `otherActive` — install/retry failure paths still revoke their own freshly-minted credential unconditionally.

### TC-G5-01 · helper SQL semantics: company-scoped, active-set, self-excluding, falsy-short-circuit — P1 · **db** · covers G5 + G6 (helper half); proves the real export exists
- **Target seam:** REAL `marketplaceQueries.countOtherActiveInstallationsOnCredential` (real SQL, txn client).
- **Setup:** `withTxn` → `resetToPre169` → `apply169` (five default-co rows on 424242; `nsaId`, `relyId`, `websiteId` = row ids). Company B + one B-owned installation row referencing the SAME `api_integration_id=424242` (hypothetical cross-tenant sharer, insertable in the txn). Flip `rely` to `'provisioning_failed'` (active set member), flip `lhg` to `'disconnected'`.
- **Steps + Expected:**
  1. `(DEFAULT, 424242, nsaId, client)` → **3** (website + pro-referral + rely; excludes self, excludes disconnected lhg, EXCLUDES company B's row — G5);
  2. `(DEFAULT, 424242, websiteId, client)` → 3 (symmetry);
  3. flip all but `website` to `'disconnected'`/`'revoked'` → `(DEFAULT, 424242, websiteId, client)` → **0** (the G2 boundary condition as the SQL sees it);
  4. `(DEFAULT, null, nsaId, spyClient)` and `(DEFAULT, undefined/0, nsaId, spyClient)` → `0` with `spyClient.query` NEVER called (`spyClient = { query: jest.fn((...a) => client.query(...a)) }` — the falsy guard returns BEFORE `ensureMarketplaceSchema`, mirroring `revokeCredentialById` :260);
  5. return type: strictly a Number (`::int` cast), not a string.

### TC-G6-01 · NULL-credential disconnect: 'disconnected', both payload flags false — P1 · unit-mocked · covers G6, truth-table row 1
- **Setup:** `getInstallationById` → `{ …INST, api_integration_id: null }`; helper mock → `0`; `revokeCredentialById.mockResolvedValue(null)`.
- **Steps:** disconnect 555.
- **Expected:** zero `'credential_revoked'` events; `markDisconnected` status `'disconnected'`; `'disconnected'` event payload `toEqual({ credential_revoked: false, credential_shared: false })`; COMMIT; return status `'disconnected'`. (Do NOT pin whether `revokeCredentialById(null, …)` is invoked — its own null-guard makes both implementations observably identical; the contract is the event/status surface.)

### TC-G7-01 · regression pin: not-shared + revoke-returns-null still yields 'revoked' — P0 · unit-mocked · covers G7, truth-table row 3
- **Setup:** `getInstallationById` → `{ …INST, api_integration_id: 7 }`; helper → `0`; `revokeCredentialById.mockResolvedValue(null)` (company-mismatch leg of the company-scoped UPDATE).
- **Steps:** disconnect 555.
- **Expected:** revoke called with `(7, COMPANY, mockClient)`; NO `'credential_revoked'` event; `markDisconnected` called with **`status: 'revoked'`** (the extended expression `!api_integration_id || revoked || otherActive > 0` must fall through exactly like today's :532); `'disconnected'` event payload `toEqual({ credential_revoked: false, credential_shared: false })`; return status `'revoked'`.

### TC-G8-01 · concurrent-disconnect race pinned in the SAFE direction — P3 · unit-mocked · covers G8 (accepted failure mode)
- **Setup:** two installations on credential 1: 555 (`nsa-leads`) and 556 (`rely-leads`, `app_id:'app-rely'`); `getInstallationById` resolves per-id; helper mock → `1` for BOTH calls (each READ-COMMITTED txn still sees the other row active — the modeled interleave).
- **Steps:** disconnect 555, then 556 (sequentially — the mock encodes the race's visibility).
- **Expected:** `revokeCredentialById` called ZERO times across both; both `markDisconnected` calls status `'disconnected'`; both event payloads `{ credential_revoked: false, credential_shared: true }` — the credential may survive with zero active rows and a wrong revoke is impossible. (No `FOR UPDATE` exists to test; cleanup path = later G2-style disconnect or manual revoke, per spec.)

### TC-G9-01 · error semantics unchanged: 404 / 409 / helper-throw ⇒ ROLLBACK — P1 · unit-mocked · covers G9
- **Variants:**
  - **(a) unknown/foreign id** — `getInstallationById.mockResolvedValue(null)` (company-scoped SQL returns nothing for another tenant's id — the cross-tenant-404 checklist case): rejects `{ code: 'INSTALLATION_NOT_FOUND', httpStatus: 404 }`; helper, revoke, `markDisconnected`, `writeEvent` ALL `.not.toHaveBeenCalled()`; `mockClient.query` saw `'ROLLBACK'`; `release()` called.
  - **(b) inactive row** — `getInstallationById` → `{ …INST, status: 'disconnected' }`: rejects `{ code: 'INSTALLATION_NOT_ACTIVE', httpStatus: 409 }`; helper NOT called (preconditions run first — spec §2.4/G9).
  - **(c) helper throws** — helper mock `mockRejectedValue(new Error('count failed'))`: `disconnectInstallation` rejects with that same error; `'ROLLBACK'` + `release()`; revoke/`markDisconnected`/`writeEvent` never called (error propagates to the route's existing mapping).

---

## §C — catalog surface

### TC-C1-01 · five published lead apps listed for ANY company (real SQL) — P1 · db · covers C1, US-1
- **Target seam:** REAL `marketplaceQueries.listPublishedAppsWithInstallation(companyId, client)` post-169.
- **Setup:** `withTxn` → `resetToPre169` → `apply169`; company B created in-txn.
- **Steps:** call for company B.
- **Expected:** result contains exactly five rows with `category='lead_generation'`, `status='published'`, names «Website Leads», «Pro Referral Leads», «Rely Leads», «NSA Leads», «LHG Leads» keyed by the five app_keys.

### TC-C1-02 · listApps maps the five generically — no overlay touches them — P1 · unit-mocked · covers C1 (service half), NFR-5 backend leg
- **Setup:** `queries.listPublishedAppsWithInstallation` → five rows shaped like the SELECT output (C2-exact fields; each with `installation_id`/`installation_status:'connected'` per the M1 seed); NO google-email/telephony rows in the fixture.
- **Steps:** `await marketplaceService.listApps(COMPANY)`.
- **Expected:** five apps returned via the generic `mapAppRow` path: `app_key`/`name` exact; `requested_scopes toEqual(['leads:create'])`; `access_summary toEqual(['Create leads'])` (metadata-driven); each `.installation` `{ id, status: 'connected', installed_at, … }` from its row; `emailMailboxService.getMailboxStatus` NOT called and `telephonyTenantService.getTelephonyState` NOT called (overlays fire only for their own keys — marketplaceService.js:252-264 untouched).

### TC-C2-01 · four new rows: every column exact; lead-generator non-renamed fields intact; string policy — P0 · db · covers C2, FR-1, NFR-4, FR-6 copy rule
- **Setup:** `withTxn` → `resetToPre169` → `apply169`.
- **Steps:** `SELECT * FROM marketplace_apps WHERE app_key IN (four keys) ORDER BY app_key`.
- **Expected (each of the four):** `provider_name='Albusto'` · `category='lead_generation'` · `app_type='internal'` · `requested_scopes toEqual(['leads:create'])` · `provisioning_mode='manual'` · `status='published'` · `support_email='support@albusto.com'` · `docs_url='/settings/api-docs'` · `metadata toEqual({ access_summary: ['Create leads'] })` · `privacy_url` **NULL** · `logo_url` **NULL**. Names/descriptions verbatim per spec §2.1(2): `pro-referral-leads`→«Pro Referral Leads»/`Creates inbound leads from Pro Referral.`/`Posts Pro Referral leads into Albusto with source attribution.`; `rely-leads`→«Rely Leads»/`…from Rely.`/`Posts Rely leads…`; `nsa-leads`→«NSA Leads»/`…from NSA.`/`Posts NSA leads…`; `lhg-leads`→**«LHG Leads»** (acronym NOT expanded)/`…from LHG.`/`Posts LHG leads…`. Policy asserts over the 12 new user-visible strings (4×name+short+long): none matches `/Blanc/`, none matches `/enforc|блок/i` (no per-source-enforcement promise). And `lead-generator` still has `provider_name='Blanc Labs'`, `support_email='support@blanc.local'`, `privacy_url='https://blanc.local/privacy'` (rebrand = explicit non-goal).

### TC-C3-01 · default company: five Connected tiles, one shared credential, five distinct rows — P1 · db · covers C3, US-2
- **Setup:** `withTxn` → `resetToPre169` → `apply169`.
- **Steps:** `listPublishedAppsWithInstallation(DEFAULT_COMPANY_ID, client)`; plus direct `SELECT id, app_id, api_integration_id FROM marketplace_installations WHERE company_id=default AND status='connected'` joined to the five keys.
- **Expected:** each of the five list rows has `installation_status='connected'` with a NON-NULL `installation_id`; the five installation ids are DISTINCT (lead-generator's = `sourceInstallationId`, four = seeded); all five rows' `api_integration_id = 424242` (the shared credential); the embedded `reconcileRevokedInstallations` ran and flipped nothing (`revoked_at` NULL). Frontend genericity is pinned structurally in TC-C6-01 (zero `frontend/src` hits — NFR-5).

### TC-C4-01 · non-default company: five Available (no seeded state) — P1 · db · covers C4 (read half), NFR-3
- **Setup:** `withTxn` → `resetToPre169` → `apply169`; company B in-txn.
- **Steps:** `listPublishedAppsWithInstallation(companyB, client)`.
- **Expected:** all five lead apps present with `installation_id` NULL / `installation_status` NULL (available-but-disconnected); `SELECT COUNT(*) FROM marketplace_installations WHERE company_id=companyB` = 0.

### TC-C4-02 · self-service Enable mints B's OWN `leads:create` credential via the generic manual path — P1 · unit-mocked · covers C4 (install half), US-4
- **Setup:** `queries.getPublishedAppByKey('rely-leads')` → C2-exact row `{ id: 'app-rely', app_key: 'rely-leads', name: 'Rely Leads', requested_scopes: ['leads:create'], provisioning_mode: 'manual', status: 'published', metadata: { access_summary: ['Create leads'] } }`; `findActiveInstallation` → null; `createInstallation` → `{ id: 501, status: 'provisioning_failed' }`; `integrationsService.createIntegration` → `{ id: 9001, key_id: 'ak_rely_new' }`; `updateInstallationCredential` → `{ id: 501, api_integration_id: 9001 }`; `markInstallationConnected` → `{ id: 501, status: 'connected', installed_at: '2026-07-13T00:00:00Z' }`.
- **Steps:** `await marketplaceService.installApp('company-b', 'user-b', 'rely-leads', { requestId: 'req-b' })`.
- **Expected:** NO `DERIVED_CONNECTION_APP` and NO `GMAIL_REQUIRED` rejection (`emailQueries.getMailboxByCompany` NOT called — `requires_connected_gmail` absent); `createIntegration` called EXACTLY once with `('Marketplace: Rely Leads', ['leads:create'], null, 'company-b', { client: mockClient, marketplaceAppId: 'app-rely', marketplaceInstallationId: 501 })`; `updateInstallationCredential` called with `('company-b', 501, 9001, mockClient)`; `connect_requested` event payload `toEqual({ app_key: 'rely-leads', scopes: ['leads:create'], provisioning_mode: 'manual' })`; result `status='connected'`, `app_key='rely-leads'`, `key_id='ak_rely_new'` — exactly today's Lead Generator behavior, zero new code exercised.

### TC-C5-01 · re-Enable after disconnect mints a NEW credential; never re-attaches nor touches credential 1 — P2 · unit-mocked · covers C5
- **Setup:** as TC-C4-02 but for the DEFAULT company after a G1-style disconnect: `findActiveInstallation` → **null** (the old `'disconnected'` row is invisible to the active-set query — history row remains per the partial index); `createIntegration` → `{ id: 9002, key_id: 'ak_rely_v2' }`.
- **Steps:** `installApp(COMPANY, 'user-1', 'rely-leads', …)`.
- **Expected:** a NEW installation row is created (`createInstallation` called — not a resurrection of the old row); `updateInstallationCredential` called with the NEW id **9002** (≠ 1 — no re-attach of the shared credential); `revokeCredentialById` `.not.toHaveBeenCalled()` anywhere in the flow (`api_integrations` row 1 untouched); result `status='connected'`. (The old shared token keeps posting for the remaining sharers — guarded through THEIR rows; the new credential staying unused externally is accepted FR-6 semantics, no code to test.)

### TC-C6-01 · connect state is informational: ingestion seams contain zero marketplace coupling; no frontend edits — P2 · structural · covers C6, FR-6, NFR-5, NFR-6, invariant 2
- **Steps/Expected (fs + glob scans in the unit file):**
  1. `backend/src/routes/integrations-leads.js`, `backend/src/middleware/integrationsAuth.js`, `backend/src/middleware/integrationScopes.js`: NONE contains `/marketplace_(apps|installations)|marketplace[A-Z]|lead-generator|pro-referral-leads|rely-leads|nsa-leads|lhg-leads/` — `POST /leads` stays token+scope only (verified zero hits pre-feature; this pins it post-feature), so a disconnected «Rely Leads» tile cannot gate a Rely post.
  2. Recursive scan of `frontend/src/**`: zero hits for `pro-referral-leads|rely-leads|nsa-leads|lhg-leads` (NFR-5 — the generic tile branch renders them; a hit = the escalate-don't-hardcode violation).
  3. (Runtime complement, already covered elsewhere: TC-M8-01 keeps `revoked_at` NULL through every feature action and TC-G1-01 skips the revoke — together ⇒ `authenticateIntegration` keeps returning 2xx for all five `job_source` streams without touching those files.)

---

## Coverage matrix (every spec scenario ≥1 case)

| Spec scenario | Case(s) | Suite |
|---|---|---|
| M1 fresh apply | TC-M1-01 | db |
| M2 idempotent re-apply | TC-M2-01 (+TC-M2-02 file hygiene) | db + structural |
| M3 boot replay / rename self-heal | TC-M3-01 | db |
| M4 no-source company | TC-M4-01 (3 variants + self-heal leg) | db |
| M5 non-resurrection | TC-M5-01 | db |
| M6 rollback, live install untouched | TC-M6-01 | db |
| M7 rollback vs other-company installs | TC-M7-01 | db |
| M8 api_integrations byte-identity | TC-M8-01 | db |
| G1 shared disconnect ≠ kill-switch | TC-G1-01 | unit |
| G2 last-active revokes (today's behavior) | TC-G2-01 (+TC-G5-01 step 3 SQL boundary) | unit + db |
| G3 reconciler does not cascade | TC-G3-01 (with non-vacuity control) | db |
| G4 other revoke sites unguarded | TC-G4-01, TC-G4-02 | unit + structural |
| G5 company-scoped count | TC-G5-01 | db |
| G6 NULL-credential short-circuit | TC-G6-01 (service) + TC-G5-01 step 4 (helper) | unit + db |
| G7 revoke-null ⇒ 'revoked' regression | TC-G7-01 | unit |
| G8 race accepted (safe direction) | TC-G8-01 | unit |
| G9 error semantics unchanged | TC-G9-01 (a/b/c) | unit |
| C1 five apps listed | TC-C1-01, TC-C1-02 | db + unit |
| C2 row values exact | TC-C2-01 | db |
| C3 default co five Connected | TC-C3-01 (+TC-C6-01.2 for NFR-5) | db + structural |
| C4 other co Available + self-service Enable | TC-C4-01, TC-C4-02 | db + unit |
| C5 re-Enable mints new credential | TC-C5-01 | unit |
| C6 ingestion informational | TC-C6-01 (+TC-M8-01/TC-G1-01 runtime complement) | structural |

## Proposed file layout (matches architecture «Tests» section)

- **NEW `tests/marketplaceLeadgenSplit.db.test.js`** — real-PG self-skip (`dbReady` probe, `SKIPPED-NEEDS-DB` per test), every case on a dedicated client in `BEGIN … ROLLBACK`, `resetToPre169`/`apply169`/`applyRollback169` helpers, fixture ids 424242/424243/424244, `db.pool.end()` in afterAll. Cases: TC-M1-01, TC-M2-01, TC-M3-01, TC-M4-01, TC-M5-01, TC-M6-01, TC-M7-01, TC-M8-01, TC-G3-01, TC-G5-01, TC-C1-01, TC-C2-01, TC-C3-01, TC-C4-01 (14).
- **NEW `tests/marketplaceLeadgenSplit.test.js`** — mocked `marketplaceQueries` (telephonyOverlay factory + the new helper fn), REAL `marketplaceService`; plus the fs/glob structural cases (no DB, no network). Cases: TC-G1-01, TC-G2-01, TC-G4-01, TC-G6-01, TC-G7-01, TC-G8-01, TC-G9-01, TC-C1-02, TC-C4-02, TC-C5-01 + structural TC-G4-02, TC-C6-01, TC-M2-02 (13).
- No changes to any existing test file (invariant 13).

## Stay-green list (must pass UNCHANGED — zero mock additions; run them with the same worktree run-form)

- **Marketplace suites:** `tests/marketplaceTelephonyOverlay.test.js`, `tests/googleEmailMarketplace.test.js`, `tests/services/marketplaceService.test.js` (its 'lead-generator'/'Lead Generator' strings are MOCK fixtures fed to the service, not DB reads — the rename cannot touch them; none of the three ever calls `disconnectInstallation`, so the mocked-queries factories may lack the new helper), `tests/routes/marketplace.test.js` (mocks marketplaceService wholesale; disconnect HTTP response shape unchanged), `tests/middleware/integrationScopes.test.js` (NFR-6 seam untouched).
- **Yelp set (explicit non-goal — task-based, not marketplace-token based):** `tests/yelpAgentSendLink.test.js`, `yelpCallTask.test.js`, `yelpConversationId.test.js`, `yelpConvoAgentLoop.test.js`, `yelpConvoGreeterDedup.test.js`, `yelpConvoHandler.test.js`, `yelpConvoHandler.db.test.js`, `yelpConvoHistory.test.js`, `yelpConvoIntercept.test.js`, `yelpLeadClaim.db.test.js`, `yelpLeadEnqueue.test.js`, `yelpLeadHandler.test.js`, `yelpLeadHook.test.js`, `yelpLeadSafeFail.test.js`, `yelpLeadService.claim.test.js`, `yelpLeadService.detect.test.js`, `yelpLeadService.parse.test.js`, `yelpReplyFormat.test.js`, `yelpSendsBackfill.db.test.js`, `yelpSendsBackfill.dry.test.js`, `yelpTimelineCleanup.db.test.js`, `yelpTimelineDedup.test.js`, `yelpTimelinePulse.db.test.js`, `yelpTimelineResolve.db.test.js`.
- Rationale: the feature's entire code surface = `marketplaceQueries.js` (one appended boot line + one additive exported helper), `marketplaceService.js` (`disconnectInstallation` :516-544 region only) and two NEW SQL files — none of the above suites exercises that region, and existing entries/ordering of `ensureMarketplaceSchema` are byte-unchanged (invariant 6).
