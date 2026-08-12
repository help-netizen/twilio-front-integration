# TECH-ID-CANON-001 — canonical technician identity

## Decision

`technicians.id` (UUID) is the only operational technician identifier. A
Zenbooker technician id is accepted at compatibility inputs and resolved through
`technician_external_identities`, but is never emitted as a roster/user id and
is never newly persisted in technician-owned configuration or
`jobs.assigned_techs`.

`crm_users.id` remains an account/authorization identity. It is not a technician
identity. In particular, `schedule_route_segments.technician_id` is intentionally
out of scope: despite its name, it stores `crm_users.id` and requires a separate
route-history migration.

## Staged rollout

### T1 — canonicalize `jobs.assigned_techs`

Run the inventory as a dry-run first. The command is company-scoped, locks only
that company's jobs, rejects unresolved ids, changes only each assignment's
`id`, and preserves `name` and all other JSON fields.

```bash
node backend/src/cli/canonicalizeJobTechnicianIds.js \
  --company-id 00000000-0000-0000-0000-000000000001

node backend/src/cli/canonicalizeJobTechnicianIds.js \
  --company-id 00000000-0000-0000-0000-000000000001 \
  --apply
```

The CLI prints `before`, projected/actual `after`, `changed_jobs`, and
`changed_assignments`. Re-running `--apply` is an idempotent zero-change run.

Read-only inventory SQL, before and after:

```sql
WITH assignments AS (
    SELECT j.id AS job_id, assignment.value
    FROM jobs j
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(j.assigned_techs) = 'array'
             THEN j.assigned_techs ELSE '[]'::jsonb END
    ) assignment(value)
    WHERE j.company_id = :'company_id'::uuid
), classified AS (
    SELECT a.job_id,
           native.id AS native_id,
           external.technician_id AS external_technician_id
    FROM assignments a
    LEFT JOIN technicians native
      ON native.company_id = :'company_id'::uuid
     AND native.id::text = a.value->>'id'
    LEFT JOIN technician_external_identities external
      ON native.id IS NULL
     AND external.company_id = :'company_id'::uuid
     AND external.source = 'zenbooker'
     AND external.external_id = a.value->>'id'
)
SELECT COUNT(DISTINCT job_id) AS jobs_with_assignments,
       COUNT(DISTINCT job_id) FILTER (
           WHERE native_id IS NULL AND external_technician_id IS NOT NULL
       ) AS legacy_jobs,
       COUNT(*) AS total_assignments,
       COUNT(*) FILTER (WHERE native_id IS NOT NULL) AS native_assignments,
       COUNT(*) FILTER (
           WHERE native_id IS NULL AND external_technician_id IS NOT NULL
       ) AS legacy_assignments,
       COUNT(*) FILTER (
           WHERE native_id IS NULL AND external_technician_id IS NULL
       ) AS unresolved_assignments
FROM classified;
```

Expected ABC precondition from the production read-only measurement:
`total_assignments=1625`, `legacy_assignments=1425`,
`native_assignments=200`, `unresolved_assignments=0`. After T1:
`legacy_assignments=0`, `native_assignments=1625`,
`unresolved_assignments=0`.

### T2 — UUID output and tolerant input

- Native roster and `/api/zenbooker/team-members` compatibility route emit
  `technicians.id` in `id` and `technician_uuid`.
- User projection emits the linked active `technicians.id` as `technician_id`.
- UUID and legacy ZB input both resolve tenant-locally to the same active native
  technician.
- Job create, direct create, lead conversion, schedule create/reassign, and job
  reschedule assignment writes canonicalize ids before persistence.
- Slot-engine technician input is built from the UUID roster. Stored scheduled
  jobs are canonical after T1, so `assigned_technicians` is also UUID-only.

### T3 — constraints and company base identity

Migration `256_technician_uuid_constraints.sql`:

- validates all eight Phase-A `NOT VALID` native FKs;
- makes `technician_uuid` `NOT NULL` in seven technician-owned tables;
- adds a stable UUID row key and `is_company_default` to
  `technician_base_locations`;
- migrates the `tech_id='__company__'` row to
  `is_company_default=TRUE, technician_uuid=NULL`;
- enforces exactly one owner kind per base row and at most one company-default
  row per company.

The API still accepts/emits the `__company__` sentinel for compatibility, but it
is synthesized at the boundary and is no longer stored in a technician-id
column.

### T4 — remove legacy TEXT keys

Migration `257_drop_legacy_technician_keys.sql` removes these columns after the
runtime readers have moved to `technician_uuid`:

- `technician_profiles.tech_id`
- `technician_base_locations.tech_id`
- `technician_time_off.technician_id`
- `technician_work_schedules.technician_id`
- `technician_work_schedule_days.technician_id`
- `technician_district_assignments.technician_id`
- `technician_radius_assignments.technician_id`
- `technician_area_wildcards.technician_id`

The migration rebuilds the affected unique/primary/child-FK constraints on the
UUID key. Zenbooker provenance remains in
`technician_external_identities`; no provenance row is deleted.

### Retired Phase-A transition artifacts

Migration 257 makes three Phase-A states impossible by design: a config row
with only a legacy TEXT key, a config row with `technician_uuid IS NULL`, and a
writer that dual-writes TEXT plus UUID. The following historical regression
suites asserted those temporary states and are retained with an `.obsolete`
suffix for archaeology, but are no longer Jest tests:

- `technicianProfilesRekey.db.test.js.obsolete`
- `technicianBaseLocationsRekey.db.test.js.obsolete`
- `timeOffRekey.db.test.js.obsolete`
- `technicianWorkScheduleRekey.db.test.js.obsolete`
- `technicianServiceAreaRekey.db.test.js.obsolete`
- `technicianRekeyEmptyDirectory.db.test.js.obsolete`

The Phase-A `backfillNativeTechnicians` tool is also retired as
`scripts/backfillNativeTechnicians.js.obsolete`, together with its unit and DB
suites (`nativeTechnicianBackfill.test.js.obsolete` and
`nativeTechnicianBackfill.db.test.js.obsolete`). It discovers and repoints the
eight removed TEXT columns and obtains its upstream roster from
`technicianRosterService`, whose post-T2 output is now native UUID. Running that
tool after migration 257 would therefore either fail on missing columns or
misclassify native UUIDs as Zenbooker identities.

This does not replace a broken test with an isolated substitute. The supported
post-cutover behaviors remain covered on real PostgreSQL: T1 job-assignment
backfill/idempotency/T-blast in `technicianIdCanon.db.test.js`, the 256/257
schema transition in `technicianIdCanonMigration.db.test.js`, post-257
cross-tenant reads in `nativeTechnicianTenantIsolation.db.test.js`, and the
complete UUID-only merge in `technicianMerge.db.test.js`.

## Deployment guard

The migration numbers were selected after checking `origin/master` immediately
before creation and again before handoff; its maximum was `255`. Apply in order:

1. run T1 dry-run and save its JSON output;
2. run T1 `--apply`, then repeat the read-only inventory;
3. deploy the UUID-output/dual-input code;
4. apply migration 256;
5. deploy the UUID-only configuration readers/writers if deployments are split;
6. confirm the legacy-reader search below is empty, then apply migration 257.

Do not run migration 257 while an older application instance that reads the
legacy columns is still serving traffic.

## MCP parity

No capability, permission, tool, or registry entry changes. Existing Job MCP
outputs keep the same `assigned_techs[].id` field and JSON shape, but its value
is now an Albusto technician UUID. This is a field-value compatibility impact,
not a new MCP capability.

## Frontend boundary

No frontend files are changed. Current frontend code treats technician ids as
opaque strings. These comments are stale but not functional readers and remain
for the frontend owner:

- `frontend/src/services/scheduleApi.ts` describes time-off ids as ZB TEXT;
- `frontend/src/components/leads/useConvertToJob.ts` says `roster-compat`;
- `frontend/src/hooks/useCompanyUsers.ts` says `roster-compat`;
- `frontend/src/services/technicianBaseLocationsApi.ts` says `__company__` is
  stored in the technician column (it is now only an API sentinel).

## Verification

Task-specific real-DB suites (local PostgreSQL only):

```bash
node --use-bundled-ca --experimental-vm-modules \
  ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath \
  tests/technicianIdCanon.db.test.js \
  --testPathIgnorePatterns '/node_modules/'

node --use-bundled-ca --experimental-vm-modules \
  ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath \
  tests/technicianIdCanonMigration.db.test.js \
  --testPathIgnorePatterns '/node_modules/'
```

Post-T4 technician merge regression suite:

```bash
DATABASE_URL=postgresql://localhost/albusto_test \
node --use-bundled-ca --experimental-vm-modules \
  ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath \
  tests/technicianMerge.db.test.js \
  --testPathIgnorePatterns '/node_modules/'
```

Affected backend/unit suites:

```bash
node --use-bundled-ca --experimental-vm-modules \
  ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath \
  tests/technicianRosterService.test.js \
  tests/userTechnicianProjection.test.js \
  tests/technicianIdCanonCli.test.js \
  tests/jobsDescriptionSync.test.js \
  tests/jobsCreate.test.js \
  tests/schedRouteIntegration.test.js \
  tests/scheduleServiceRescheduleZb.test.js \
  tests/jobActivityMutations.test.js \
  tests/schedRouteGaps.test.js \
  tests/technicianBaseLocations.test.js \
  tests/baseLocationStructured.test.js \
  tests/technicianWorkScheduleMigration.test.js \
  tests/technicianWorkScheduleService.test.js \
  tests/technicianServiceAreaMigration.test.js \
  tests/technicianServiceAreaService.test.js \
  tests/timeOffRoutes.test.js \
  tests/technicianUnavailability.test.js \
  tests/scheduleReassign.test.js \
  --testPathIgnorePatterns '/node_modules/'
```

Legacy-reader gate before migration 257:

```bash
git grep -n -E \
  'technician_profiles.*tech_id|technician_base_locations.*tech_id|technician_time_off.*technician_id|technician_work_schedules.*technician_id|technician_work_schedule_days.*technician_id|technician_district_assignments.*technician_id|technician_radius_assignments.*technician_id|technician_area_wildcards.*technician_id' \
  -- backend/src src scripts ':(exclude)scripts/*.obsolete'
```

The result must be empty. Migration/test fixtures, rollback SQL, and explicitly
retired `.obsolete` archaeology are excluded from this runtime-reader gate.

The final affected-domain gate is intentionally broader than the task-specific
commands above:

```bash
unset NODE_USE_SYSTEM_CA
DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --testPathIgnorePatterns "/node_modules/" "frontend/" --runInBand --forceExit --testPathPatterns "(technician|roster|timeOff|schedule|jobsCreate|jobsService|jobActivity|baseLocation|rateMe|leadsService|membership)"
```

## Sabotage result

The T1 backfill test was run once after removing its company predicates and the
now-unused bind. The T-blast assertion failed with two changed jobs/assignments
instead of one, proving the foreign tenant was reached. The service was restored
from a `cp` backup (not git), the backup was deleted, all three company scopes
were rechecked, and the real-DB suite passed again.
