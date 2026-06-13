# QA Report - ALB migrations 096-099

Дата QA: 2026-06-13  
Ветка/worktree: `claude/distracted-pascal-b65258`  
Режим: read-only audit; код не изменялся, создан только этот отчёт.

## Итоговый вердикт

| Область | Вердикт | Обоснование |
|---|---|---|
| `096_pf007_provider_scope_hardening.sql` | deploy-with-notes | Fresh/re-run проходят; company-scoped backfill работает на обязательных фикстурах. Найден major-риск: один `zenbooker_team_member_id` может быть назначен нескольким active users в одной компании, что расширяет provider visibility. |
| `097_alb101_signup_otp_trusted_devices.sql` | safe-to-deploy | Fresh/re-run проходят; CHECK `phone_otp.purpose`, UNIQUE `trusted_devices.device_id_hash`, FK CASCADE работают. |
| `098_alb107_company_telephony.sql` | deploy-with-notes | Fresh/re-run проходят; CHECK/UNIQUE работают. Найден major-риск в conflict-пути `phone_number_settings`: повторный upsert номера переносит строку на другую компанию, но оставляет tenant-scoped `group_id` и старые metadata. |
| `099_alb107_phase2_softphone_a2p.sql` | safe-to-deploy if 098 applied | Fresh/re-run проходят после 098; CHECK статусов A2P работает. Без 098 падает понятной ошибкой `relation "company_telephony" does not exist`. |
| Full runner path | blocked | `v3_schema.sql` не применим к пустой БД с `ON_ERROR_STOP`; `apply_migrations.js` проглатывает ошибки и возвращает exit 0, при этом 096/098/099 не применяются. |

## Матрица применения

| Миграция | fresh-run на `schema_pre_096` | re-run / идемпотентность | downgrade-замечания |
|---|---|---|---|
| 096 | OK: `ALTER TABLE`, indexes, `UPDATE 0` на пустом baseline | OK: только NOTICE `already exists`, `UPDATE 0` | Rollback-файла нет. Drop column/index удалит internal assignment mirror; backfill one-way от текущих `assigned_techs`. |
| 097 | OK: `phone_otp`, `trusted_devices`, user/company columns | OK: только NOTICE `already exists` | Rollback-файла нет. Drop tables удалит OTP/trusted device audit state. |
| 098 | OK: `company_telephony`, phone number columns/index | OK: только NOTICE `already exists` | Rollback-файла нет. Drop `company_telephony` удалит encrypted tenant Twilio credentials. |
| 099 | OK после 098 | OK: только NOTICE `already exists` | Rollback-файла нет. Зависит от 098; downgrade должен сначала обработать A2P rows/softphone columns. |

## Findings

```yaml
id: "MIG-001"
severity: blocker
type: data-risk
migration: "runner"
location: "apply_migrations.js:17-23; backend/db/v3_schema.sql:221-230"
repro: |
  docker run -d --name qa-mig-full -e POSTGRES_PASSWORD=qa -e POSTGRES_DB=qa_full -p 127.0.0.1:55432:5432 -v "$PWD":/work postgres:17
  docker exec qa-mig-full psql postgresql://postgres:qa@localhost:5432/qa_full -v ON_ERROR_STOP=1 -f /work/backend/db/v3_schema.sql
  DATABASE_URL=postgresql://postgres:qa@127.0.0.1:55432/qa_full node apply_migrations.js
expected: "Full chain should stop on the first schema/migration error and return non-zero; 096-099 should not be reported as done unless applied."
actual: |
  v3_schema.sql fails at service_territories because companies does not exist.
  apply_migrations.js catches and ignores every migration error, then exits 0 with "Done running all migrations."
  In the observed run it swallowed failures for 096, 098, and 099:
  096: relation "company_user_profiles" does not exist
  098: relation "phone_number_settings" does not exist
  099: relation "company_telephony" does not exist
suggestion: "Make the runner fail fast by default; only allow explicitly whitelisted idempotency errors, and return non-zero if any migration fails."
```

Context: this does not affect direct application of 096-099 on `schema_pre_096.sql`, which passed. It does block using the repository runner as deployment evidence.

```yaml
id: "MIG-002"
severity: major
type: bug
migration: "baseline"
location: "backend/db/v3_schema.sql:221-230"
repro: |
  docker exec qa-mig-full psql postgresql://postgres:qa@localhost:5432/qa_full -v ON_ERROR_STOP=1 -f /work/backend/db/v3_schema.sql
expected: "The documented empty-DB bootstrap path v3_schema -> 001..099 should create required dependencies in order."
actual: "psql stops at line 230: relation \"companies\" does not exist, because service_territories references companies before companies is created."
suggestion: "Either move companies creation before service_territories in v3 bootstrap or remove this object from v3_schema and let numbered migrations create it in dependency order."
```

Context: primary QA baseline `backend/db/test-fixtures/schema_pre_096.sql` loaded successfully on PostgreSQL 17.10.

```yaml
id: "MIG-003"
severity: major
type: security
migration: "096"
location: "backend/db/migrations/096_pf007_provider_scope_hardening.sql:26-28,55; backend/src/db/membershipQueries.js:144-149"
repro: |
  -- After applying 096 on schema_pre_096:
  -- create two active memberships in the same company with the same company_user_profiles.zenbooker_team_member_id = 'tech-same'
  -- then run the 096 backfill UPDATE for a job assigned_techs='[{"id":"tech-same"}]'.
  SELECT zenbooker_job_id, jsonb_array_length(assigned_provider_user_ids), assigned_provider_user_ids
  FROM jobs
  WHERE zenbooker_job_id = 'qa-096-same';
expected: "One external provider id should resolve to one internal crm_users.id within a tenant, or duplicate active mappings should be rejected."
actual: "The job resolved to two active users in the same company; `assigned_provider_user_ids` contained both CRM user ids."
suggestion: "Enforce tenant-scoped uniqueness for active provider bridge mappings, either in app transaction checks or via a schema design that can support a company-scoped unique constraint."
```

Context: mandatory 096 cases passed: same-company active mapping resolved; cross-company, unmapped, inactive membership, `NULL`, non-array JSON, and `[{}]` resolved to `[]`. The risk is duplicate mappings inside the same tenant.

```yaml
id: "MIG-004"
severity: major
type: data-risk
migration: "098"
location: "backend/db/migrations/098_alb107_company_telephony.sql:27-31; backend/src/services/telephonyTenantService.js:203-211,229-234"
repro: |
  -- Insert +15550980001 for company A with group_id='qa-grp-a', locality='Boston',
  -- capabilities='{\"voice\":true,\"sms\":true}', purchased_at='2026-01-01'.
  -- Then run the same ON CONFLICT(phone_number) DO UPDATE path used by buyNumber
  -- for company B with sid='PNQA098B2', locality='Cambridge',
  -- capabilities='{\"voice\":true,\"sms\":false}', purchased_at='2026-02-02'.
  SELECT pns.phone_number, c.slug AS current_company, pns.group_id,
         ug.company_id AS group_company_id,
         (ug.company_id = pns.company_id::text) AS group_matches_company,
         pns.locality, pns.capabilities, pns.purchased_at::date
  FROM phone_number_settings pns
  JOIN companies c ON c.id = pns.company_id
  LEFT JOIN user_groups ug ON ug.id = pns.group_id
  WHERE pns.phone_number = '+15550980001';
expected: "Repeat insert for the same number should either be rejected across tenants or reset/update tenant-scoped fields and all newly added number metadata."
actual: "The row moved to company B and SID changed, but `group_id` still pointed to company A; locality/capabilities/purchased_at stayed Boston/{voice:true,sms:true}/2026-01-01."
suggestion: "On phone-number conflict, update `locality`, `capabilities`, `purchased_at`, and clear or validate `group_id`/routing fields when `company_id` changes. Also join `user_groups` with company scope in telephonyTenantService.listNumbers."
```

Context: direct CHECK for `company_telephony.status` rejected invalid `active`, and duplicate `twilio_subaccount_sid` was rejected by the UNIQUE constraint. The repeated-number behavior is the risky part.

```yaml
id: "MIG-005"
severity: minor
type: perf
migration: "098"
location: "backend/db/migrations/098_alb107_company_telephony.sql:10,22-24"
repro: |
  SELECT indexname, indexdef
  FROM pg_indexes
  WHERE tablename='company_telephony'
  ORDER BY indexname;
expected: "Avoid redundant indexes unless they serve a distinct query pattern."
actual: "`twilio_subaccount_sid TEXT UNIQUE` creates `company_telephony_twilio_subaccount_sid_key`; migration also creates partial btree `idx_company_telephony_subaccount` on the same column for non-null rows."
suggestion: "Remove the extra partial index unless measured query plans prove it is needed; the unique index can satisfy equality lookups on non-null SID."
```

## Выполненные проверки

- PostgreSQL: `postgres:17.10` Docker image.
- Baseline: `backend/db/test-fixtures/schema_pre_096.sql` loaded with `ON_ERROR_STOP=1`.
- 096-099: each applied once and then re-applied; no errors, only expected `already exists` NOTICE on re-run.
- DDL shape: inspected affected tables, columns, defaults, nullability, indexes, CHECK/FK constraints, and comments.
- 096 data semantics: tested same-company active, cross-company active, unmapped, inactive membership, `assigned_techs = NULL`, non-array JSON, and `[{}]`.
- 097 semantics: valid `phone_otp.purpose` values inserted; invalid purpose rejected; duplicate trusted device hash rejected; deleting `crm_users` cascaded trusted devices.
- 098 semantics: invalid telephony status rejected; duplicate subaccount SID rejected; repeated phone number upsert tested.
- 099 semantics: all allowed A2P statuses inserted; invalid status rejected.
- Order checks: 097 without 096 succeeds; 099 without 098 fails clearly with `relation "company_telephony" does not exist`.
- Security/schema: no GRANT/OWNER changes in 096-099; `phone_otp.code_hash`, `twilio_auth_token_enc`, and `api_key_secret_enc` have no plaintext defaults.

## Performance and lock notes

096 backfill on 100k synthetic jobs:

- Setup: one company, one active provider bridge, 100k jobs; 10% mapped.
- Insert 100k jobs: about 1.335s in the disposable Docker DB.
- Backfill `EXPLAIN ANALYZE`: about 0.624s total; 10k rows updated; 90k rows scanned and skipped by `IS DISTINCT FROM`.
- Plan shape: full index scan over `jobs`, lateral `jsonb_array_elements`, hash/seq scan over small `company_user_profiles`, merge join back to `jobs`.
- Prod implication: the 096 `UPDATE jobs ...` is one transaction over the whole jobs table. It holds a `ROW EXCLUSIVE` table lock and row locks for changed rows; it can still create write pressure and WAL proportional to changed rows. Consider batching if prod `jobs` is much larger than the tested scale.

DDL lock classes:

- `ALTER TABLE ... ADD COLUMN` takes an `ACCESS EXCLUSIVE` table lock, but nullable/default metadata-only additions should be brief in modern PostgreSQL.
- `CREATE INDEX` without `CONCURRENTLY` can block writes while building. This matters most for `jobs`, `company_user_profiles`, and `phone_number_settings`.
- `CREATE TABLE` affects new tables only.

Index notes:

- `idx_jobs_assigned_provider_user_ids` with `jsonb_path_ops` is appropriate for service queries using `assigned_provider_user_ids @> ...`.
- `idx_jobs_company_start_date(company_id, start_date DESC)` is not a duplicate of existing single-column indexes and matches company-scoped date ordering.
- `idx_company_telephony_subaccount` appears redundant with the UNIQUE index from `twilio_subaccount_sid`.

## Open questions

- Should the Zenbooker provider bridge be one-to-one per tenant for active memberships? If yes, 096 needs an enforceable uniqueness strategy.
- Is `apply_migrations.js` used for any deployment or CI path? If yes, the runner behavior is a release blocker.
- Is `v3_schema.sql` still a supported empty-DB bootstrap artifact? If yes, it currently needs dependency-order repair.
- For phone numbers, should a repeated `phone_number` conflict ever move ownership across companies, or should it be rejected unless the old row is explicitly released first?
- Should `telephonyTenantService.listNumbers` scope the `user_groups` join by `ug.company_id = pns.company_id::text` like other routes already do?
