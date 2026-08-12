# PROVIDER-MIRROR-INVARIANT-001 — database-owned provider visibility mirror

Status: implemented, not deployed  
Decision: A — keep `jobs.assigned_provider_user_ids`, but make PostgreSQL its owner  
Migration: `258_provider_mirror_invariant.sql`  
Rollback: `rollback_258_provider_mirror_invariant.sql`

## Scope

This change makes provider visibility structurally consistent without choosing or
preparing option C. It does not change the frontend, provider-list predicates, the
mobile contract, MCP output, or the canonical `technicians.id` work already shipped
in `553c1af2`.

The database, not a writer, owns the persisted value. Application-side resolution
remains as a rollout-compatible optimization, but a missing, stale, or forged value
is overwritten by the database.

## Invariant

For every job, `assigned_provider_user_ids` is the sorted, unique JSON array of
`company_memberships.user_id` values for assignments which satisfy every condition:

1. The assignment is resolved inside `jobs.company_id`, either directly through a
   canonical `technicians.id` UUID or through a company-scoped
   `technician_external_identities` row with `source = 'zenbooker'`.
2. The resolved technician is `active = TRUE`.
3. The technician has `crm_user_id` linked to an `active` membership in the same
   company.

Invalid/non-array `assigned_techs`, blank ids, unmapped ids, inactive technicians,
unlinked technicians, and inactive/missing memberships grant visibility to nobody.
The one authoritative formula is
`resolve_job_provider_user_ids(company_id, assigned_techs)`.

`refresh_job_provider_mirrors(...)` is the tenant-scoped, idempotent bulk execution
primitive. It does not contain a second formula; it applies the resolver above and
updates only rows whose stored JSON is distinct from the derived JSON.

## Trigger coverage

| Mutation source | Events | Trigger shape | Recompute target |
|---|---|---|---|
| `jobs` | `INSERT` | `BEFORE`, row | The new job |
| `jobs.company_id`, `assigned_techs`, or `assigned_provider_user_ids` | `UPDATE` | `BEFORE`, row | The updated job |
| `technician_external_identities` | `INSERT/UPDATE/DELETE` | `AFTER`, statement-level transition tables | Jobs in affected tenants using the old/new external id or technician UUID |
| `technicians` | `INSERT/UPDATE/DELETE`; UPDATE work is skipped unless `company_id`, `id`, `crm_user_id`, or `active` changed | `AFTER`, statement-level transition tables | Jobs in affected tenants using the old/new technician UUID or its current external identity |
| `company_memberships` | `INSERT/UPDATE/DELETE`; UPDATE work is skipped unless `company_id`, `user_id`, or `status` changed | `AFTER`, statement-level transition tables | All jobs in affected tenant(s) |

Membership recompute is intentionally company-wide. On membership deletion, the
existing FK may already have executed `ON DELETE SET NULL (crm_user_id)` before the
statement trigger runs, so targeting through the now-removed link would be
incorrect. The final `IS DISTINCT FROM` predicate prevents unrelated jobs in that
tenant from being written.

Every relationship-chain trigger is statement-level: a bulk identity, technician,
or membership operation invokes one bulk refresh, not one refresh per changed source
row. Every update remains company-filtered before any job can be selected.

## Direct writes and privileged bypasses

The two `jobs` triggers are `BEFORE` triggers. Consequently both the stored row and
`INSERT/UPDATE ... RETURNING` contain the derived mirror. Supplying an arbitrary
`assigned_provider_user_ids`, including another tenant's user id, cannot survive the
statement.

All eleven invariant triggers are enabled as `ALWAYS`:

- `session_replication_role = replica` does **not** bypass them. The real-DB suite
  writes a forged mirror in replica mode and receives the correct derived value.
- `ALTER TABLE ... DISABLE TRIGGER ...` and `DISABLE TRIGGER ALL` are privileged,
  explicit bypasses and disable even an `ALWAYS` trigger. No trigger design can
  defend against an administrator disabling the trigger itself.

`scripts/import-local-data.js` intentionally uses `DISABLE TRIGGER ALL`. After data
load it now:

1. re-enables triggers;
2. restores the eleven invariant triggers to `ENABLE ALWAYS` (plain
   `ENABLE TRIGGER ALL` downgrades them to origin-only mode);
3. calls one explicit full recompute for every company currently present in `jobs`;
4. reports the repaired row count before commit.

Any future privileged importer which disables triggers inherits the same contract:
restore `ALWAYS`, then call `refresh_job_provider_mirrors` before commit. Skipping
that call can leave drift by definition; the real-DB suite demonstrates both the
bypass and the repair.

## Migration and rollback

The migration number was selected after checking `origin/master` at
`3bb13973411b49b9a125cc25de457c1cbf32d5b9`; its highest forward migration was 257,
so this change uses 258.

Migration order is:

1. create the authoritative resolver and bulk refresh function;
2. create and mark all triggers `ALWAYS`;
3. run a full, all-tenant recompute so the invariant is true at migration commit.

Rollback removes the eleven triggers and their functions. It deliberately leaves
the last consistent mirror values in place: values overwritten by the initial
repair cannot be reconstructed, and destroying a valid authorization projection
would make rollback less safe.

## Performance

Environment: local PostgreSQL 15.15, isolated temporary schemas with production-
shape indexes, 1,602 jobs (the established production assigned-job scale), six
runs per case; the reported number is the median of five runs after one warm-up.
No production or staging database was touched.

The bulk-reassign baseline writes both assignment columns correctly, so the delta
measures database enforcement rather than comparing correct work with an incomplete
writer.

| Workload (1,602 jobs) | Before | After | Ratio | After per job |
|---|---:|---:|---:|---:|
| One bulk reassign statement | 9.373 ms | 90.552 ms | 9.66x | 0.0565 ms |
| Trigger-disabled import: insert + required repair | 5.964 ms | 162.828 ms | 27.30x | 0.1016 ms |

Bulk reassign spent 74.807 ms inside the row trigger. Its top plan used 17,868
shared-hit blocks before and 29,084 after, with 44 dirtied/written blocks in both
cases. The protected import's component medians were 5.154 ms to insert and 157.718
ms to run the full recompute; it ended with zero drift rows. The old import ended
with all 1,602
rows drifted in this intentionally mirror-less fixture.

The relative ratios are large because the baseline does almost no relationship
resolution, but the absolute cost at the observed production scale is 91 ms for an
unusual all-jobs reassignment and 163 ms for a privileged bulk import. Ordinary
single-job writes amortize to roughly 0.06 ms in this fixture. Relationship
mutations are already statement-level, so they cannot multiply refresh calls by the
number of changed identities/memberships.

The row-level `jobs` trigger is retained because `BEFORE` both protects a forged
mirror and makes `RETURNING` correct. If frequent 10k+ all-job rewrites become a
real workload and the measured latency breaches its SLA, the next optimization is
an `AFTER ... REFERENCING NEW TABLE` statement trigger backed by a set-based resolver.
That trades away corrected values in the original statement's `RETURNING`, needs a
recursion guard for its internal update, and must preserve a single formula. It is
not justified by the current absolute latency and is not part of this migration.

## Verification

### Real PostgreSQL invariant and rollback suite

Exact command:

```sh
unset NODE_USE_SYSTEM_CA; node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/providerMirrorInvariantMigration.db.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
```

Result: `PASS`, 1 suite, 12/12 tests. It covers:

- raw `UPDATE jobs SET assigned_techs = ...`;
- `INSERT jobs` with the mirror column omitted (the 1682 shape);
- late `technicians.crm_user_id` link across two existing jobs;
- membership deactivation and deletion;
- forged foreign user id overwrite;
- external identity `INSERT/UPDATE/DELETE`;
- technician `active` transitions;
- byte-for-byte neighbouring-tenant snapshot;
- `session_replication_role = replica`;
- explicit trigger disable plus full repair;
- all eleven `tgenabled = 'A'` modes;
- migration rollback.

### Sabotage negative control

Backup and restore were performed with an explicit copy:

```sh
cp backend/db/migrations/258_provider_mirror_invariant.sql /tmp/258_provider_mirror_invariant.sql.cp
cp /tmp/258_provider_mirror_invariant.sql.cp backend/db/migrations/258_provider_mirror_invariant.sql
```

Between those commands, the `CREATE TRIGGER trg_jobs_provider_mirror_insert` block
was removed. Exact red command:

```sh
unset NODE_USE_SYSTEM_CA; node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/providerMirrorInvariantMigration.db.test.js --testPathIgnorePatterns "/node_modules/" --runInBand --testNamePattern "INSERT jobs without the mirror column"
```

Result: expected `FAIL`, 1 failed test: received `[]` instead of the linked CRM user
id. The migration was restored byte-for-byte from the copy, the temporary copy was
removed, and the full 12-test suite was rerun green.

### Reproducible local benchmark

Exact command:

```sh
unset NODE_USE_SYSTEM_CA; node --use-bundled-ca scripts/benchmark-provider-mirror-invariant.js
```

Result: the figures in the Performance section; the script removed both temporary
schemas and closed its pool.

### Backend regression gate

Exact affected-area command:

```sh
unset NODE_USE_SYSTEM_CA; node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/jobProviderMirrorQueries.test.js tests/pf007ProviderScope.test.js tests/scheduleReassign.test.js tests/providerMirrorLifecycle.db.test.js tests/technicianDirectoryQueries.test.js backend/tests/services/technicianDirectoryService.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
```

Result: `PASS`, 6 suites, 46/46 tests.

Exact tenant-safety command:

```sh
unset NODE_USE_SYSTEM_CA; node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/tenantSafetyLint.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
```

Result: `PASS`, 1 suite, 10/10 tests.

The broader sibling sweep passed 15 suites (146 tests), skipped two DB suites whose
prerequisite native tables are absent from the stale local public schema, and exposed
the unrelated existing `tests/routes/rolesPermissions.test.js` failure (9 failures).
That suite fails identically in isolation and does not exercise the changed
`resolveProviderUserIds` function; no role/editor code was changed here.

## Risks and operational notes

- Applying migration 258 takes write locks while trigger objects are installed and
  updates only currently drifted jobs during the initial recompute. Schedule it as
  a normal schema migration; do not run it manually on production.
- Membership changes recompute all drifted jobs in the affected company. This is
  correctness-first because delete cascades remove the narrower link.
- A database owner can always disable or drop enforcement. Privileged tooling must
  follow the explicit repair contract above.
- Application resolvers remain temporarily duplicated for rollout compatibility.
  They now include the same `technicians.active = TRUE` rule and deterministic id
  ordering, but their result is advisory: the DB resolver always owns the stored
  value.
