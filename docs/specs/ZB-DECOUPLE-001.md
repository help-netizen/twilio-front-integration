# ZB-DECOUPLE-001 — Detach Albusto from Zenbooker

Status: PLAN APPROVED (2026-08-06). Phase A next. Owner: help@bostonmasters.com (ABC Homes).
Mode: tandem (Claude lead/design, Codex engineering). This file is the re-entry point.

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

### T2..T6 — not started (see Phase A design above).


### Debt surfaced
- mig 239 (`technician_area_wildcards`, shipped 2026-08-05) has no `rollback_239_*.sql` — add
  a `DROP TABLE technician_area_wildcards` rollback for ledger consistency (not a Phase A blocker).

## Open owner items (non-blocking)
- ZB raw/receipt/link retention period (default: keep as provenance indefinitely until asked).
- Imported-payment UI label: "Zenbooker" vs "Legacy import" (default: keep "Zenbooker").
