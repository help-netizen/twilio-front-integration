# Local PostgreSQL test database

DB-backed Jest suites assume that `albusto_test` has the repository schema.
They must not be accepted as baseline-red or silently skipped when a column is
missing.

## Preflight

Use a task-specific URL and verify the database name before applying anything:

```bash
ALBUSTO_TEST_DATABASE_URL=postgresql://localhost/albusto_test
psql "$ALBUSTO_TEST_DATABASE_URL" -Atc 'SELECT current_database()'
```

The result must be exactly `albusto_test`.

For the schema drift found on 2026-08-17, apply the missing idempotent migrations
with real `psql` and stop on the first error:

```bash
psql "$ALBUSTO_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f backend/db/migrations/259_task_snoozed_until.sql
psql "$ALBUSTO_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f backend/db/migrations/265_estimate_public_token_expiry.sql
psql "$ALBUSTO_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f backend/db/migrations/271_job_numbering.sql
```

The corresponding symptoms were `tasks.snoozed_until` missing,
`estimates.public_token_expires_at` missing, and `jobs.job_seq`/`public_code`
missing. These are local schema drift, not reasons to weaken or skip the tests.

New migrations in the working diff must then be applied in numeric order using
the same `psql -v ON_ERROR_STOP=1 -f` contract before DB suites are run. A
migration that requires an operational deployment setting must follow its own
runbook; do not invent a value merely to make a test database migrate.

