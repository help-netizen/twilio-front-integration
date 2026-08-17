# JOB_CODE_FEISTEL_KEY deploy prerequisite

Migration `273_job_public_code_key_rotation.sql` and every application database
connection must use one stable value from the deployment secret
`JOB_CODE_FEISTEL_KEY`. Never commit the production value and never generate a
replacement during deploy: changing it rewrites all job public codes.

Before migrations:

```bash
test -n "$JOB_CODE_FEISTEL_KEY"
case "$JOB_CODE_FEISTEL_KEY" in
  *[!0-9]*|'') exit 1 ;;
esac
```

Install the same value as the database default **before** migration 273. This is
the bridge for raw `psql` and connections held by the old application process;
`ALTER DATABASE` affects new sessions, while migration 273 deliberately reads
the just-written catalog value for already-open sessions:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
\getenv job_code_key JOB_CODE_FEISTEL_KEY
SELECT format(
  'ALTER DATABASE %I SET app.job_code_feistel_key TO %L',
  current_database(),
  :'job_code_key'
) \gexec
SQL
```

Then apply migrations with the project's normal psql runner. No `PGOPTIONS`
transport is required for the migration process:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f backend/db/migrations/273_job_public_code_key_rotation.sql
```

Finally restart the application with `JOB_CODE_FEISTEL_KEY` set to the same
value. New/replacement Node pool connections pass it as the authoritative
session option. Migration 273 stores only a one-way fingerprint: the same key is
a no-op; a different key aborts before any `public_code` is changed.

If the application env value is absent/invalid, the process and telephony still
start, `/health` reports `jobNumbering.degraded=true`, and startup diagnostics
log/persist `JOB_CODE_FEISTEL_KEY_REQUIRED`/`INVALID`. Only job creation fails
with that explicit database error. This bounded degradation is intentional:
numbering configuration must not take down inbound calls.

Deployment order is fixed:

1. `ALTER DATABASE ... SET` from the environment secret.
2. Apply migration 273 and the remaining migrations.
3. Restart the application with the same environment value.
