# ZB-DECOUPLE-001 — Detach Albusto from Zenbooker

Status: PLAN APPROVED (2026-08-06). Phase A next. Owner: help@bostonmasters.com (ABC Homes).
Mode: tandem (Claude lead/design, Codex engineering). This file is the re-entry point.

> ⚠️ **MIGRATION RENUMBER (2026-08-06, at master integration):** master occupied `240` (FSM-JOB-ACTIONS-001),
> so this feature's migrations shifted +1 at merge time — prose below that says "240 / 241 / 242" now maps to
> **241** native technician directory, **242** contact identity foundation, **243** contact merge redirects
> (files renamed accordingly; rollbacks match).

## Goal (owner's words)
Zenbooker is no longer needed. Map every coupling and split away safely. Technicians who
are NOT in Albusto must still render as the provider on the job cards of jobs they did;
technicians and their schedules must not break; finally remove the ZB-caused duplicate
contacts. The owner will own the job-sync migration; payments may need migrating.

## Owner decisions (frozen 2026-08-06 — verbatim intent)
1. **Booking master = Albusto native.** Build a native service catalog + territories +
   local job creation (Phase C). ZB is not replaced by another provider.
2. **Contact dedup = safe / manual-on-conflict.** Auto-merge ONLY when a normalized phone
   OR email is owned by exactly one contact, or on exact ZB id. Phone↔email conflict and
   shared household numbers go to a manual review queue. Never auto-merge on name alone.
3. **Payments = freeze as imported history.** One final reconciled import (fix the Full-sync
   gaps + a source-vs-ledger count/amount reconciliation), then `zb_payments` freezes as
   immutable history and new payments are Albusto-native. No P2, no faked native origin.
4. **Sequence = Phase A (technician identity) first.**
5. **Scope rule (owner, 2026-08-06): touch ONLY what Albusto lacks as a class, or what is
   SYNC-FED from ZB.** Anything Albusto already owns natively AND is entered in Albusto (not
   synced) is left as-is — no migration, no reconcile, no compare-against-ZB.
   - Provider time-off, service zones/districts/radii, and work schedules ARE native Albusto
     features with the correct data (owner-entered, Albusto is master). Phase A only RE-KEYS
     their 8 tables (ZB-id → native uuid); VALUES are never migrated or compared against ZB.
   - What DOES get a native replacement: the technician DIRECTORY/identity — Albusto has no
     native technician-directory class today and the active roster + display name are live-fed
     from ZB `/team_members`. That is exactly what Phase A builds.
   - `compare` mode's against-ZB check therefore narrows to ROSTER IDENTITY only (active set +
     display name). `SAB-A-ZONE-UUID-PARITY` proves re-key INVARIANCE (read-by-uuid ==
     read-by-zb-id on the same Albusto config), not native-vs-ZB.

## Current-state map (Codex discovery, file:line)
### The crux — technician roster is 100% live from ZB
- `technicianRosterService.listActive` calls ZB `/team_members` on EVERY request, no cache:
  `backend/src/services/technicianRosterService.js:40-75`, `backend/src/services/zenbookerClient.js:613-638`.
- Cutting it empties: slot engine (`slotEngineService.js:124-149,318-388`), `recommendSlots`
  (→ voice/outbound/yelp "unavailable"), tech settings (`routes/technicians.js:34-142`),
  **service-area settings** (`technicianServiceAreaService.js:52-95,197-251` — the ZONE-STRICT
  work), availability (`technicianAvailabilityService.js:173-188`), company-wide time-off
  (`timeOffService.js:153-181`), provider picker (`JobTechnicianControl.tsx:44-59`).

### Job-card provider display does NOT break (owner constraint 1 already met)
- Name is denormalized into `jobs.assigned_techs[]`, not a live roster join
  (`jobsService.js:118-165,182-221`; `JobMobileCard.tsx:99-117`; `jobHelpers.tsx:177-180`).
  A ZB-only/deactivated tech still renders today and after cutoff. Empty-provider sync keeps
  the existing snapshot (`jobsService.js:1541-1547`).

### Identity planes
- Albusto UUID: `crm_users.id`, `company_memberships.user_id`, `jobs.assigned_provider_user_ids[]`.
- ZB TEXT: `company_user_profiles.zenbooker_team_member_id` (the bridge),
  `jobs.assigned_techs[].id`, `technician_profiles.tech_id`, `technician_base_locations.tech_id`,
  `technician_time_off.technician_id`, `technician_work_schedules.technician_id`,
  district/radius assignments, `technician_area_wildcards` (mig 239).
- Bridge (company-scoped): `membershipQueries.js:193-247`. ZB id format `1777…x394…`.

### Contacts & the duplicate cause
- Two disagreeing matchers: hourly sync `upsertFromZenbooker` conflicts ONLY on
  `zenbooker_customer_id` (`contactsService.js:338-400`); webhook matcher = ZB id → exact
  first+last+phone → +email → create (`zenbookerSyncService.js:492-570`). Ordinary deduper is
  name-first (`contactDedupeService.js:52-158,222-251`). Result: same-phone-different-name → dup.
- Prod: 3637 contacts, 3525 (97%) ZB-sourced; 57 duplicate phone sets / 84 extra rows.

### Payments — Full sync gaps (owner's suspicion confirmed)
- Route `POST /api/zenbooker/payments/sync` → `syncFullHistory`
  (`routes/zenbooker/payments.js:17-70`, `zenbookerPaymentsSyncService.js:606-710`).
- Gaps: cursor in React state only (reload → restart at 0); swallowed projection/reconcile
  errors; per-row commits (crash = partial page); NO source-vs-ledger reconciliation; refunds
  staged without adjustment; `parseFloat||null` turns $0 → null; no explicit sort.
- Native ledger `payment_transactions` already holds the 1430 zb rows as
  `external_source='zenbooker'`. They can stay as immutable imports after cutoff.

### Config, workers, security
- Env: `ZENBOOKER_API_KEY/_BASE_URL/_TIMEOUT_MS/_DEFAULT_COMPANY_ID` (`zenbookerClient.js:23-39`);
  per-company `companies.zenbooker_api_key`/`zenbooker_webhook_key`; `FEATURE_ZENBOOKER_SYNC`.
- Workers/crons: hourly contact cron (`reconcile.cron:15-17`), job webhooks
  (`integrations-zenbooker.js:34-229`), queued `zb_job_sync` worker (`workers/agentHandlers.js:114-180`),
  5s delayed assignment re-fetch, manual payment sync. Startup job cron is a stub (`zbJobsSyncCron.js`).
- ⚠️ SECURITY: hard-coded ZB credential fallback in `scripts/search_part_numbers.js:9` — rotate + remove.
- ⚠️ TENANCY: older `getClient()` methods are unscoped and can hit the default ZB account from a
  tenant route (`zenbookerClient.js:118-280,356-580`). Harden or gate during transition.

### MCP parity
- reschedule/cancel appointment skills push to ZB via `scheduleService`
  (`agentSkills/skills/{reschedule,cancel}Appointment.js`); MCP job schema exposes
  `zenbooker_job_id/zb_status/zb_rescheduled/zb_canceled` (`agentSkillsMcpRegistry.js:994-1004`).
- Keep signatures + fields nullable ≥1 release; make shared job/schedule services do native ops
  before disabling ZB branches. No new MCP permission needed for decoupling itself.

## Phased plan (each phase leaves the system working)
- **Phase 0 — safety:** rotate the hard-coded credential; add integration mode live|read_only|off;
  baseline counts (done). Rollback: mode → live.
- **Phase A — technician identity Albusto-native (NEXT):** native `technicians` directory
  (uuid, company_id, name, active, optional crm_user_id) + external-identity map
  (company_id, source, external_id); import live roster + every distinct historical
  `assigned_techs` id as an inactive technician; repoint schedules/zones/bases/time-off/mig239
  to the native uuid via the map; roster/slots/settings read native; dual-read compare before
  switch. De-risks the biggest hard failure. Rollback: adapter back to ZB read, native data kept.
- **Phase B — contact dedup + native authority:** preview pipeline, external-id mapping table,
  fix merge to preserve external ids + phone overflow, deterministic batches (safe policy above),
  ZB import → link/fill-empty only → read-only → stop.
- **Phase C — booking/job ops native (booking master = Albusto):** native service catalog +
  territory, slots on native data only, job create local-first, remove ZB from
  reschedule/assign/cancel/complete/note. Owner owns the job-sync migration.
- **Phase D — payment freeze:** durable checkpoint, final reconciled import + count/amount
  reconciliation, refund policy, mark cutoff, `zb_payments` frozen, new payments native.
- **Phase E — freeze/disable ZB:** read-only → verify → disable crons/webhooks/workers/buttons →
  revoke creds after a monitoring window.
- **Phase F — remove ZB code:** keep provenance columns; drop schema later, separately reviewed.

## Tenancy & Roles
Every native technician read/write is `company_id`-scoped (canon). The technician directory and
external-id map carry `company_id`; the ZB→native bridge stays company-scoped. Provider-scope
authz continues to key on `jobs.assigned_provider_user_ids` (Albusto UUID). Settings writes
require `tenant.company.manage` as today.

## Phase A design (APPROVED 2026-08-06) — technician identity Albusto-native
Migration **240** (verified free vs origin/master@aa899c33; prod PG 17.10 supports the SQL;
`company_memberships.uq_user_company` exists for the composite FK).

**Schema:** `technicians` (uuid pk, company_id, display_name, active, optional crm_user_id via
composite membership FK `ON DELETE SET NULL`, created_at) + `technician_external_identities`
(PK `(company_id, source, external_id)` → technician uuid, source='zenbooker'). Add a parallel
`technician_uuid` column (NOT VALID composite FK, dual-read) to all **eight** ZB-keyed tables:
technician_profiles, _base_locations, _time_off, _work_schedules, **_work_schedule_days**
(child table — was omitted from the brief, Codex caught it), _district_assignments,
_radius_assignments, _area_wildcards (mig 239). Legacy TEXT keys stay, dual-written.

**Compatibility-key rule (Codex pushback, accepted):** the public roster `{id,name}` contract
keeps an assignment-compatible `id` = ZB external id when mapped, else the native uuid string;
every internal row also carries `technician_uuid`. `jobs.assigned_techs` and
`jobs.assigned_provider_user_ids` are NEVER rewritten. Internal joins use the uuid.

**Backfill (idempotent CLI, `--company-id`, `--dry-run` default):** import live ZB roster →
active technicians + map rows (via `company_user_profiles.zenbooker_team_member_id`); create
INACTIVE historical technicians for every distinct `jobs.assigned_techs[].id` + any config-only
legacy key not already mapped, so absent techs resolve. Exclude `__company__` sentinel.
Data-driven (no hardcoded ids/names). Rerun preserves every uuid, zero new rows. An empty/
incomplete ZB fetch must NOT deactivate the directory.

**Cutover — per-company, fail-closed:** `TECHNICIAN_DIRECTORY_MODE=legacy|compare|native` +
`TECHNICIAN_DIRECTORY_COMPANY_IDS` allowlist (default legacy, no implicit company). `compare`
shadow-evaluates native vs ZB roster/eligibility/schedule/bases/time-off; `native` makes ZERO
`/team_members` calls. Cutover blocked until: active ZB set == active native set; every job-
snapshot external id has exactly one company-scoped map; every non-sentinel legacy row has a
uuid; work-schedule day uuid == parent uuid; compare shows zero unexplained diffs; a forced ZB
outage leaves roster/settings/bases/schedules/zones/slots/time-off/availability/picker working;
`jobs.assigned_*` byte-unchanged. Rollback after switch = mode→legacy (never drop mig 240).

**Tasks T1–T6:** T1 migration 240 + native query foundation; T2 idempotent import/backfill CLI;
T3 parallel uuid read/write for all 8 tables; T4 native roster/availability/time-off/bases/slots/
settings + mode switch; T5 job-boundary + MCP compatibility (signatures/permissions unchanged);
T6 compare-gate + per-company native cutover + attack-only re-review.

**Named sabotage `SAB-A-ZONE-UUID-PARITY`:** real DB fixture, two companies sharing one ZB
external id; tech A→North, B→unassigned, C→wildcard; native and legacy readers must yield the
same eligible set (North: A,C; other: C; B: never); flip the ZONE-STRICT empty branch
(`technicianServiceAreaService.js:264` `size===0 → true`) → parity test RED → restore edit (not
git) → green; and removing company scope from the external-map join must fail the shared-id case.

## Verification
### T1 (migration 240 + native query layer) — DONE, commits d96be1ad, 8c6ade76
- Migration proven by a rolled-back apply against the REAL prod schema (PG 17.10): all
  objects + 8 `*_native_fk` create, `ROLLBACK` leaves 0 tables. No persistent change.
- `backend/src/db/technicianDirectoryQueries.js` — company-scoped primitives (create /
  upsert-external / resolve external↔uuid / list-active / link-crm-user); no ZB calls, no
  default-company fallback; company_id is the first bound param of every query.
- Unit test (mocked pool, runs without a DB), 7/7:
  `env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/" --runTestsByPath tests/technicianDirectoryQueries.test.js`
- Sabotage SAB-T1-TENANT: reorder `resolveExternalToUuid` params so company isn't `$1` →
  1 failed → restore from cp backup → 7 passed.
- Deferred: the full `.db` round-trip against migration 240 runs at DEPLOY (the local dev DB
  `twilio_calls` is not fully migrated — missing company_memberships / mig-239 table /
  work_schedule_days). Add `tests/nativeTechnicianDirectory.db.test.js` when a migrated test
  DB exists, or verify at the deploy migration step.
- Codex L-016 twice (session compacted, drafted-without-applying); T1 code written by Claude
  from the approved design.

### T2 (idempotent backfill CLI) — DONE, commit ca0b6417
- `scripts/backfillNativeTechnicians.js` — one company, `--dry-run` default, `--apply` = one
  row-locked (`FOR UPDATE`) transaction. Live roster → active technicians + external map
  (reuses T1 queries + the membership bridge); historical `jobs.assigned_techs` ids + config-only
  keys from the 8 tables → INACTIVE technicians; `__company__` excluded; name precedence
  live→job→profile→crm→external. Five refusal guards abort before any write; an empty/incomplete
  ZB fetch never deactivates. No default-company fallback; every query company_id-scoped.
- Unit test (mocked, no DB), 12/12:
  `env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/" --runTestsByPath tests/nativeTechnicianBackfill.test.js`
- Sabotage SAB-T2-NO-WIPE: neuter the empty-roster guard → "roster unexpectedly empty" test red →
  restore → 12 passed. Proves an empty ZB response can't wipe the active directory.
- `tests/nativeTechnicianBackfill.db.test.js` written; runs at DEPLOY (skips locally — dev DB not migrated).
- Built by Codex in a FRESH session (per L-022, not the compacted one) — applied cleanly, no L-016.

### T3a (§3.3 config re-key backfill) — DONE, commit 8ed51dcc
- Backfill CLI now populates `technician_uuid` on all 8 config tables from the external map,
  inside the SAME apply transaction after identities exist; idempotent (`IS DISTINCT FROM`),
  `__company__` base row excluded (stays NULL). `repoint_rows` in the report; dry-run previews
  it read-only. Pure re-key of Albusto-master config (decision #5) — values untouched.
- Unit 13/13 (mocked). Real-DB test against `albusto_test` 1/1: after --apply every non-sentinel
  config row = the mapped uuid, `__company__` NULL, second --apply repoints 0, foreign tenant
  unchanged. Sabotage SAB-T3A-IDEMPOTENT: drop the `IS DISTINCT FROM` guard → second apply
  re-repoints 8 → db test red (Expected 0, Received 8) → restore → green.
- Codex fresh session; applied cleanly.

### T3b-1 (service-area/zone re-key) — DONE, commit 55b15cf5
technicianServiceArea{Service,Queries} read district/radius/wildcard by `technician_uuid` first,
fallback to legacy TEXT via the map (COALESCE + company-scoped LEFT JOIN); roster id normalized to
canonical uuid (accepts uuid or ZB id); writes dual-key. ZONE-STRICT semantics byte-preserved.
Verified albusto_test: unit 14/14, regression 52/52 (routes+slot-proxy+recommendSlots), migration
5/5. Crown-jewel `SAB-A-ZONE-UUID-PARITY` (real .db, 2 tests): same config via uuid == via ZB-id →
same eligible set ({A,C}/{C}/never), list+radius, per-company. Sabotage: flip ZONE-STRICT empty
branch → both parity tests red → restore.

### T3b-2 (base-locations/time-off/work-schedule re-key) — DONE, commit 142f4ea2
The three remaining config query layers read uuid-first/fallback + dual-write (work_schedule_days
in lockstep); __company__ never resolved as a technician. Verified albusto_test: unit 82/82 (5
suites), three real-DB re-key round-trips 11/11. Sabotage SAB-T3B2-TIME-OFF: drop company scope on
the map join → cross-tenant test red → restore.

### T3b-3 (gap-closure) + T3b-4 (CRITICAL empty-directory fix) — DONE, commit 1a10e79f
Surfaced by the 2026-08-06 completeness audit (below).
- **T3b-3 gap-closure:** `technician_profiles` (the 8th config table) was schema-provisioned by mig 240
  but its service was legacy-key-only → now uuid-first read + dual-write like the other 7.
  `technicianBaseLocationsService.list()` read the roster via a direct `getTeamMembers` → now routed
  through the mode-aware `technicianRosterService.listActive`.
- **T3b-4 CRITICAL:** the uuid-first re-key was NOT a superset of legacy — on an EMPTY native directory
  (pre-backfill = current prod) it (a) THREW "Technician identity not found" on every technician config
  WRITE (base/schedule/time-off/profile/service-area) and (b) DROPPED legacy rows on READ (company-wide
  reads gated on `resolved uuid IS NOT NULL`; filtered reads resolved the legacy id to null → []). This
  would have broken all technician scheduling on deploy. Root cause: the re-key assumed every technician
  resolves to a uuid; false before backfill. All mocked/.db tests seeded an identity first, so none
  caught it. **Fix:** `resolveTechnicianIdentity` never throws for a non-empty legacy id (unmapped → 
  `technician_uuid: null`, legacy-only write); reads use a company-scoped TEXT match key
  `COALESCE(technician_uuid::text, e.technician_id::text, tech_id)`; company-wide reads keep unmapped
  legacy rows. Applied uniformly across all 5 re-keyed modules.
Verified albusto_test: `baseLocationStructured` green; new `technicianRekeyEmptyDirectory.db.test.js`
proves write→read round-trips for a legacy id with ZERO identity across every surface + tenant fence +
backfill-transition parity; independent architect probe (empty-dir round-trip + tenant fence) green;
full 97-suite blast-radius clean (the only reds are 10 pre-existing seed-dependent suites that fail
identically on the pre-ZB-DECOUPLE base commit). Sabotage: re-add the throw → empty-dir test reds → restore.

### T4 (native roster + mode switch) — DONE, commit 6fe52fee
`TECHNICIAN_DIRECTORY_MODE=legacy|compare|native` (default legacy) + `TECHNICIAN_DIRECTORY_COMPANY_IDS`
allowlist, fail-closed (parse error / unknown company → legacy). Roster: `native` = `listActiveTechnicians`
(ZERO getTeamMembers, compat ids = ZB external id when mapped else uuid); `compare` returns legacy +
logs `rosterDifference` (identity only, per decision #5); availability resolves `(company_id, crm_user_id)
→ uuid` via `findActiveTechnicianByCrmUserId`. Verified albusto_test: 89/89 unit+regression (7 suites) +
`nativeRosterMode.db.test.js` 1/1. Sabotage `SAB-T4-ZB-OUTAGE`: make native mode fall through to ZB →
forced-outage test reds → restore → green (native roster proven independent of a ZB outage).

### T5 (job-boundary + MCP compatibility) — DONE, commit de7fea4d
The re-key does not move the job authorization plane or the ZB outbound contract.
- **authz plane stays `crm_users.id`.** `membershipQueries.resolveProviderUserIds` widened (INNER→LEFT
  JOIN) to also bridge native technician UUIDs (`technicians.crm_user_id`) and external ids, while the
  legacy `company_user_profiles.zenbooker_team_member_id` clause is preserved verbatim. The re-key never
  writes `assigned_techs`; the mirror sets `assigned_provider_user_ids` only (COALESCE legacy-first).
- **native-only UUIDs never leak to ZB.** New `resolveCompatibilityIdsToExternal` (company-scoped)
  gates all 5 ZB-push seams — reschedule route, ZB create route (`routes/zenbooker.js`), ZB assign route
  (`routes/zenbooker/jobs.js`), `leadsService.convertLead`, `scheduleService.reassignItem`. A UUID with
  no ZB external identity drops to a safe no-op / ZB auto-assignment; legacy ZB ids pass through unchanged.
- **MCP parity.** `agentSkillsMcpRegistry` / `chatgptMcp*` / appointment skills byte-unchanged (not in the
  diff); ZB job fields (`zenbooker_job_id`/`zb_status`/`zb_rescheduled`/`zb_canceled`) still exposed
  nullable; no new tool or permission.
Verified: 122 green (93 named job/MCP suites `jobsProviderScope, pf007ProviderScope, recommendSlots,
agentSkillsWriteSkills, scheduleServiceRescheduleZb, jobsCreate, leadsService.convert` + 29 native `.db`
set). **Real-PG gate probe** (`resolveProviderUserIds` on albusto_test): legacy profile-bridge resolves
to the home crm_user with an EMPTY native directory (current prod state), and the same/other ZB id is
company-scoped both directions → GREEN. Sabotage `SAB-T5-LEGACY-AUTHZ`: neuter the legacy OR-clause →
provider loses its own job visibility → probe RED → restore → GREEN.

### T6 part (c) (attack-only tenant/RBAC red-team) — DONE, commit 7e24b218
`tests/nativeTechnicianTenantIsolation.db.test.js` — 8 adversarial real-PG cases + a roster-collision
case prove nothing from company B resolves, lists, is read, or is assigned under company A across the
whole re-key surface: external↔uuid resolvers, `resolveCompatibilityIdsToExternal` (ZB-leak guard),
`listActiveTechnicians`, `findActiveTechnicianByCrmUserId`, `resolveProviderUserIds` (authz mirror by
uuid AND external id), service-area eligibility, base-location/time-off/work-schedule reads — every
foreign-tenant probe fails closed (null / []). Native-mode roster excludes B even with identical
display_name + external_id. **FINDINGS: no cross-tenant leak.** No production code changed (red-team =
tests only). Verified albusto_test: 24/24 (6 suites). Three break→red→restore sabotages each redded
exactly its probe: resolver `company_id` scope, authz-mirror scope (both by the implementer), and
`listActiveTechnicians` scope (independent architect control).

### T6 parts (a)(b) — GO-LIVE RUNBOOK (owner-gated; executes only in a deploy window, not run yet)
Nothing here changes prod until the owner says «да». Per-company, reversible:
1. **Backup + deploy the code** (migration 240 + query/service layers + mode switch), still `legacy`.
2. **Backfill the pilot company:** `node scripts/backfillNativeTechnicians.js --company-id <uuid> --dry-run`
   → review roster/inactive/repoint counts → `--apply`. Idempotent; empty ZB fetch never deactivates.
3. **compare-gate:** set `TECHNICIAN_DIRECTORY_MODE=compare` + `TECHNICIAN_DIRECTORY_COMPANY_IDS=<uuid>`,
   exercise the roster, confirm the `rosterDifference` log is EMPTY (identity only — per decision #5 we
   never diff config VALUES; Albusto is master). A non-empty diff = STOP, do not cut over.
4. **cut over:** flip `TECHNICIAN_DIRECTORY_MODE=native` for that one `company_id`. Roster now serves
   from `technicians` with ZERO `getTeamMembers`; ZB stays reachable for legacy job push only.
5. **rollback (instant):** set the pilot company back to `legacy` (or drop it from the allowlist).
   Both planes are dual-keyed, so no data changes on rollback; the mode is the only lever.
Fail-closed everywhere: a parse error or an unknown company falls back to `legacy` automatically.

## NEXT (re-entry for a fresh session)
State: **Phase A CODE-COMPLETE — T1–T6 done, gated, committed.** Migration 240 + query layer + backfill
CLI + §3.3 config re-key + 4 config service layers + native roster/mode switch + job-boundary/MCP
compatibility + attack-only tenant-isolation red-team. **Nothing deployed; ZB untouched; dual-read
defaults `legacy`; native directory empty on prod.** Next actions are owner-gated: run the GO-LIVE
RUNBOOK above for the pilot company when the owner approves a deploy, then Phase B (contact dedup).

<details><summary>Historical T3 re-entry note (superseded — kept for provenance)</summary>

**T3 = re-key the 8 config tables to native uuid + service dual-read/write.** Two parts:
(a) fold the §3.3 parallel-column backfill (`SET technician_uuid FROM the map`) into the
    backfill CLI's apply transaction — idempotent; T2 did NOT do this yet.
(b) make technicianServiceArea / slotEngine.buildTechnicians / roster / routes/technicians /
    availability / timeOff / baseLocations / workSchedule services read `technician_uuid`
    first (legacy TEXT via the map when null) and dual-write both keys.
Per decision #5: this is a PURE RE-KEY — config values are Albusto-master, never migrated or
compared against ZB. The sabotage `SAB-A-ZONE-UUID-PARITY` proves read-by-uuid == read-by-zb-id
yields the same eligible set (flip the ZONE-STRICT empty branch + drop company scope).
</details>

**Migrated test DB — BUILT (2026-08-06).** Local `albusto_test` on localhost:5432 holds the full
prod schema (307 tables, incl. mig-239 `technician_area_wildcards`) + migration 240 (2 new tables,
8 `technician_uuid` cols, 8 native FKs). Run any `.db` test against it:
`DATABASE_URL=postgresql://localhost/albusto_test env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/" --runTestsByPath <file>`
T2's `nativeTechnicianBackfill.db.test.js` now PASSES here (retro-closes T2's deferred DB check).
Rebuild recipe (no local psql client; use node `pg`): create db `albusto_test`; `ssh deploy@prod
'docker exec albusto-postgres-1 pg_dump -U albusto -d albusto --schema-only --no-owner --no-privileges'`
→ strip lines matching `^\\` and `transaction_timeout` (PG17→PG15 portability) → load via node → apply mig 240.


## Phase A completeness audit (2026-08-06) — findings, fixes, deferred
An adversarial gap-audit + a 97-suite import-based blast-radius run + real-DB probing were run before
declaring Phase A done. Net: Phase A backend is complete and safe; the audit caught one would-be
prod-breaker (fixed in T3b-4) and a set of genuinely later-phase items (recorded here so nothing is lost).

**Fixed now:** T3b-3 (profiles re-key + base-locations roster adapter), T3b-4 (CRITICAL empty-directory
degradation — see above), the `baseLocationStructured` stale mock, and the hard-coded ZB key removed from
`scripts/search_part_numbers.js` (owner rotates the live secret; it remains in git history).

**Deferred — remaining before a full native cutover (NOT Phase A blockers; mostly frontend / later phase):**
1. **Frontend roster still bypasses the mode switch** — `/api/zenbooker/team-members` (routes/zenbooker.js)
   and the hooks `useProviders.ts` / `useScheduleData.ts` / `CustomTimeModal.tsx` fetch the ZB roster
   directly. In native mode the backend serves native, but these UI surfaces would still hit ZB. Last-mile
   cutover wiring (Phase C / frontend).
2. **createFromSlot input validation** — `/schedule/items/from-slot` writes a client `assignee_id` /
   `assigned_provider_user_ids` straight to the authz mirror without resolving through the crm_users plane.
   Pre-existing (Phase A did not touch it); harden before native cutover so a native uuid cannot be injected.
3. **Admin re-link doesn't update the native map** — routes/users.js bridge edits update the legacy
   `company_user_profiles` bridge but not `technicians.crm_user_id` / the external map (only the backfill CLI
   calls `linkCrmUser`). Phase C native-maintenance.
4. **Native directory is import-only** — no production route to create/rename/activate/link a native
   technician; seeded solely by the backfill CLI. Phase C.
5. **Cutover invariants are procedural** — `native` mode activates without code-enforcing a successful
   backfill/compare. Fail-closed to legacy on errors; harden if desired.
6. **ZB client stays on the global (master) account** (zenbookerClient.js getClient) and logs full ZB
   create payloads (PII). OUT OF SCOPE per owner ("fix all marketplace tenant-isolation EXCEPT Zenbooker");
   belongs to Phase E/F.
7. Mig 239 rollback missing (below); `zbJobsSyncCron` remains a pre-existing stub.

### Debt surfaced
- mig 239 (`technician_area_wildcards`, shipped 2026-08-05) has no `rollback_239_*.sql` — add
  a `DROP TABLE technician_area_wildcards` rollback for ledger consistency (not a Phase A blocker).

## Phase B — Contact de-duplication (design frozen 2026-08-06)
Goal (owner): "наконец-то убрать дубли в контактах". Two parts: (1) FIX the root cause so the ZB sync
stops creating duplicate contacts; (2) BULK-MERGE the existing dup sets safely (no data loss). Scale
snapshot: 3,637 contacts / 3,525 ZB-sourced / **57 phone-dup sets / 84 extra rows** (owner reruns the
dup-count query on prod). Root cause: `zenbookerSyncService.js:615` overwrites fields + matches too
loosely; no company-scoped contact identity/phone dedup. Existing `mergeContacts` can LOSE data
(phones/notes/Stripe/masking/closed tasks) if reused unchanged — must be extended first.

**Frozen owner decisions:**
1. **Survivor** = most business-links → most-complete → oldest `created_at` → lowest id.
2. **Merge trigger = normalized phone match (company-scoped), INCLUDING across ZB-sourced ↔ manual.**
   Owner chose aggressive phone-merge (over "phone+email must agree"). Safe because donors are reversible
   (see #3) and every merge is surfaced in a mandatory dry-run before apply.
3. **Donor disposition = SOFT-DELETE / archive** (`deleted_at`, hidden, fully reversible) — NOT hard
   delete. Plus an `old_id → survivor` audit redirect so links resolve.
4. **Shared household phones (same number, clearly different people) are NOT dups** → mark the number
   `shared`, keep contacts separate, exclude from uniqueness + bulk-merge.
5. Email: use a unique email as a linking/corroboration signal now; defer any email-only cleanup.
   Frozen guardrails: NEVER merge on name alone; a same-phone set whose names DIVERGE is flagged in the
   dry-run as probable-household for owner review (reconciles #2 vs #4); fill-empty / never-steal on the
   survivor's non-blank scalars.

**Phased plan (each gated on albusto_test + a real-DB sabotage; nothing deployed without owner «да»):**
- **B1 — identity foundation:** migration `contact_external_identities(company_id,source,external_id →
  contact_id)` + a lossless `contact_phones` inventory (normalized phone, label, primary/shared) +
  `contacts.deleted_at` if absent; company-scoped lookup index + partial-unique claim on
  `(company_id, normalized_phone) WHERE NOT shared`. (⚠ migration number: my branch's max is 240 =
  native tech dir; use **241** here. At master integration BOTH renumber above master's real max —
  master's 240 = FSM-JOB-ACTIONS-001; see parallel-migration-collision.)
- **B2 — root-cause resolver:** one company-scoped resolver used by hourly sync + webhooks + job-contact
  lookup: exact external-id → unique phone/email owner → else create-once + atomically claim identity;
  phone↔email conflict or multi-owner → review, never insert; transactional/advisory lock. Reuse
  `contactPropagationService` fill-empty/never-steal; stop the ZB overwrite at zenbookerSyncService.js:615.
- **B3 — merge hardening:** extend `mergeContacts` to move EVERY contact/timeline FK (fail on unknown ref),
  preserve all identities + phones, identity-merge notes, rehome timeline tasks/history, QUARANTINE
  Stripe/saved-card conflicts, assert zero donor refs before archiving the donor.
- **B4 — bulk-merge CLI:** `--company-id --dry-run|--apply`, fingerprinted plan (survivor/donors/identities/
  child counts/scalar conflicts/card blockers/shared disposition), one set per txn (lock members asc id,
  revalidate fingerprint, call the shared merge service, write audit redirect, commit), idempotent reruns,
  full report. Pause ZB import during apply. DRY-RUN default; apply is owner-gated per company.
- **B5 — tenancy/RBAC red-team + tests** on albusto_test (dup round-trips, survivor rule, household
  exclusion, cross-tenant fence, reversibility of archive).

### Phase B STATUS — CODE-COMPLETE (B1–B5 done, gated, committed; nothing deployed)
- **B1 ✓** `3f594c2f` — mig 241 (contact_external_identities + contact_phones inventory + contacts.deleted_at)
  + contactIdentityQueries; non-unique phone index (unique claim deferred to post-merge). 16/16.
- **B2 ✓** `ce3e85c9` — contactResolverService wired into hourly sync + webhooks + job→contact; advisory-locked,
  ordered match (identity→non-shared phone→survivor-if-multi→email→create), never-steal; removed the blind
  overwrite. Root cause fixed. 15 .db + 36 unit + architect probe (same phone → one contact).
- **B3 ✓** `944208fa` — lossless merge: 25 FK tables + polymorphic rehomed from a data-driven inventory;
  runtime drift guard (pg_constraint vs inventory → throw) + zero-donor-reference assertion; donor SOFT-delete;
  Stripe/masking conflicts quarantined; old_id→survivor redirect (mig 242); idempotent. 114 tests.
- **B4 ✓** `f959c229` — scripts/bulkMergeContacts.js dry-run|apply; frozen survivor rule; household guard
  (name-divergent same-phone → skip); dry-run write-free; exactly-one-mode required (can't apply by default);
  per-set txn + fingerprint revalidation; never hard-deletes. Fixture 7→5, rerun no-op, tenant fence.
- **B5 ✓** `91a35f4d` — attack-only tenant red-team (contactDedupTenantIsolation.db.test.js). FINDING (fixed):
  assertNoDonorReferences filtered by the referencing row's company_id → a cross-tenant reference could be
  archived/orphaned; guard is now tenant-exhaustive (throws → refuses merge). 74/74 Phase B regression.

### Phase B GO-LIVE RUNBOOK (owner-gated; nothing runs on prod without «да»)
1. Backup prod DB. Deploy the code (B1–B5) + apply migrations **241 & 242** (renumber at master integration —
   my branch reused 240 for the native tech dir; master's 240 = FSM-JOB-ACTIONS-001).
2. Backfill contact_phones is inside mig 241 (idempotent). Confirm the dup-count query on prod
   (expect ~57 sets / ~84 extra rows).
3. **DRY-RUN** the pilot company: `node scripts/bulkMergeContacts.js --company-id <ABC Homes uuid> --dry-run`
   → owner reviews the plan file (survivors, donors, household + quarantine buckets). Mark any real household
   numbers `is_shared` before apply.
4. **PAUSE ZB contact import** (a live ZB writer can resurrect a donor), then `--apply` for that company.
5. Rollback lever: donors are soft-deleted (contacts.deleted_at) + redirected — reversible; migrations 241/242
   have rollbacks. B2 keeps new dups from returning.

## Open owner items (non-blocking)
- ZB raw/receipt/link retention period (default: keep as provenance indefinitely until asked).
- Imported-payment UI label: "Zenbooker" vs "Legacy import" (default: keep "Zenbooker").

## COURSE CHANGE (owner, 2026-08-09) — FULL Zenbooker removal
Owner: «Я хочу чтобы все зависимости и интеграции с Zenbooker были удалены, он не нужен
больше». The former standing rule "ZB job creation stays ON" is REVOKED. The phased plan
above is now the removal roadmap; remaining work continues as Phases C–F.

## Phase C — frontend last-mile + native maintenance (STARTED 2026-08-09)

### Staging rehearsal of the Phase A go-live runbook — DONE 2026-08-09
Executed on the STAGING copy (Mac mini, prod data snapshot; see docs/deploy/STAGING-ENV-001.md):
backfill `--dry-run` → `--apply` for company `…0001` (roster 3 live + 3 historical → 6 native
technicians + 6 external identities, 39/40 config rows repointed — the 40th is the
`__company__` base sentinel, excluded by design; `writes_performed: 51`), then
`TECHNICIAN_DIRECTORY_MODE=native` + allowlist. `listActive` resolves Ali/Robert/Russell with
ZERO ZB calls. The ZB key was injected into the single CLI process only and destroyed after.
PROD is still legacy with an EMPTY native directory — the prod cutover (Phase D) reruns this
same runbook there (backfill + compare-gate + flip).

### C1 — `/api/zenbooker/team-members` is mode-aware — DONE 2026-08-09
Deferred #1 closed. The route no longer calls the ZB client directly; it delegates to
`technicianRosterService.listActive` (native → zero ZB; legacy/compare → unchanged ZB fetch).
Consumer audit (2026-08-09): useProviders / useScheduleData / CompanyUserDialogs /
CustomTimeModal(getTeamMembers) read ONLY `{id, name}`; TechnicianPhotosPage uses
`techniciansApi` (already mode-aware), not this route. Native `id` = legacy ZB external id
(uuid fallback) → assignment flows byte-compatible. Route maps `err.httpStatus` (502 on ZB
outage in legacy). Contract locked by backend/tests/services/technicianRosterService.test.js
(native-never-calls-ZB / legacy shape / 502 outage / UUID validation).

### C-remaining (ordered)
- C2: createFromSlot input validation (deferred #2) — resolve assignee ids through the
  crm_users plane before writing the authz mirror.
- C3: native directory maintenance — admin re-link updates `technicians.crm_user_id` +
  external map (deferred #3); production CRUD for native technicians (deferred #4).
- C4: sweep remaining FE surfaces off `zenbookerApi` proxies (service-area-check etc. —
  inventory then port or delete).
