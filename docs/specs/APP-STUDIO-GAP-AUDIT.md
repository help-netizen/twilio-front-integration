# APP-STUDIO Ф1–Ф6 — final gap audit

## FINAL Ф1–Ф6 CLOSURE (2026-08-01, master `752cee72`)

This closure re-ran the original adversarial spec↔code method across
`APP-STUDIO-001`, `APP-GW-001`, `APP-RUN-001`, `APP-BUILD-001`,
`APP-SVC-001`, `APP-SANDBOX-001`, and `APP-MOD-001`, with emphasis on changes
after the first audit and the seams between phases. The older point-in-time
registry remains below as historical evidence; this section is authoritative
for the final Ф1–Ф6 state.

| Final finding class | Found | Fixed now | Open |
|---|---:|---:|---:|
| P0 | 3 | 3 | 0 |
| P1 | 5 | 5 | 0 |
| P2 | 3 | 0 | 3 |
| Deferred to Ф7/Ф8 | 2 groups | 0 | 2 groups |
| Spec contradiction requiring owner/architect decision | 1 | 0 | 1 |

### Seam verdicts

1. **CRM→runner HTTP is fail closed and preserves the in-process guarantees.**
   A live runner now calls the fixed CRM
   `/internal/app-runtime/v1/runs/authorize` endpoint before creating an
   isolate. CRM binds the caller-supplied hash to the run's DB-pinned artifact,
   re-resolves the full active chain, live consent, and current delegated RBAC,
   and atomically consumes a one-time execution slot. An unavailable/denying
   CRM prevents compilation; there is no runner-local authorization fallback
   and no CRM-local execution fallback.
2. **No real-run path reaches source compilation without the live gate.** The
   standalone CLI and `/v1/run` both use `executionMode: live`. The only bypass
   is the explicit `executionMode: sandbox` used by `/v1/dry-run`, where draft
   execution against synthetic fixtures is the required product behavior.
   Completion requires prior execution admission and cannot turn a revoked run
   back into `completed`/`failed`.
3. **Moderation owns all production status writes.** A repository-wide search
   finds production `UPDATE app_versions ... status` only in
   `appVersionTransitionService`; the other matches are migrations/rollback and
   adversarial tests. Migration 223 still rejects direct status writes at the
   database boundary.
4. **Sandbox and live data planes remain disjoint.** `/v1/dry-run` alone passes
   an in-memory synthetic fixture projector and never creates a CRM gateway
   client. `/v1/run` is explicitly live, receives no fixture fields, preflights
   CRM, and uses only the real gateway bridge. Exact endpoint-specific envelope
   keys reject fixture/seed fields on live runs and run-token fields on dry runs.
5. **App Studio remains tenant-admin-only and tenant-scoped.** Permission and
   exact `tenant_admin` checks now run before feature/configuration checks, so a
   non-admin cannot learn enablement or runner configuration state. The real
   protected mount remains `src/server.js:168`; tenant repository queries remain
   company-scoped and foreign chat/version actions remain indistinguishable 404s.
6. **Prior closure controls F1–F8 remain effective.** Artifact byte pinning,
   aggregate controls, PII/secret scrubbing and retention deadlines, remote-only
   runner use, consume-time revocation, membership deletion fail-closed, safe
   audit identities, and reflective scanner rejection all remain covered. This
   closure strengthened F1/F2/F3 rather than replacing them.
7. **No Node 24/native dependency remains in the CRM container.** Root
   `package.json` has no `isolated-vm`; the CRM builder calls the runner over
   HTTP. Node 24 and `isolated-vm` remain intentionally isolated to
   `apps-runtime/Dockerfile` and `apps-runtime/package.json`.

### Final P0 findings

#### FINAL-P0-01 — Caller-controlled hash could authorize arbitrary live source — FIXED

Before this closure, `/v1/run` compared source bytes only with a hash supplied
in the same service request. A service-token holder could therefore provide
arbitrary source plus its own hash, and a zero-tool app never forced validation
of the run token/live authority. **FIXED** by the pre-compilation CRM admission
endpoint, `GatewayClient.authorizeRunSource`, live consent/RBAC intersection,
and DB comparison with `app_runs.artifact_sha256`. Test:
`SAB APP-FINAL-P0 live execution requires CRM-authoritative artifact authorization before compile`.

#### FINAL-P0-02 — Run token replay and zero-tool apps bypassed aggregate resource controls — FIXED

Before this closure, one valid token could be submitted to `/v1/run` more than
once, and `app_runtime_usage` counted only gateway calls, so a zero-tool app had
no per-installation execution ceiling. **FIXED** by migration 224's one-time
`execution_authorized_at`, UTC daily `runs_started` and `wall_ms_used` budgets,
and atomic `DAILY_RUN_LIMIT`/`DAILY_WALL_MS_LIMIT` auto-suspension. Gateway calls
and completion both require the admitted run, and completion preserves revoked
status. Test:
`SAB APP-FINAL-P0 DB admission is hash-pinned, one-time, consent-live, metered, and required by calls/completion`.

#### FINAL-P0-03 — Retention expiry existed but no production cleanup called it — FIXED

Before this closure, expired builder-message deletion was reachable only from a
test/helper. **FIXED** by ID-only company discovery followed by explicit
company-scoped batch deletion in the already production-started daily retention
scheduler (`src/server.js:491`, unchanged), which drains all expired batches
while preserving chat rows. Tests:
`SAB APP-FINAL-P0 production retention tick drains every expired builder-message batch`
plus the real-PostgreSQL builder tenant/blast test.

### Final P1 findings

#### FINAL-P1-01 — Transition mutation responses leaked source and internal columns — FIXED

`UPDATE ... RETURNING *`, the idempotent review path, and rejected-version fork
returned raw `source_code` through tenant and platform mutation APIs, bypassing
the moderation detail page's “Show code” audit. **FIXED** with an exact response
projection shared by every transition/fork return path. Real-PostgreSQL test:
`SAB APP-FINAL-P1 transition responses omit source and rejection sinks are scrubbed across the full matrix`.

#### FINAL-P1-02 — Feature/runner configuration leaked before tenant-admin denial — FIXED

Product/config middleware ran before permission and role middleware, allowing a
non-admin to distinguish 404 disabled from 503 misconfigured. **FIXED** by
running `tenant.integrations.manage` and exact tenant-admin checks first. Test:
`SAB non-admin authorization runs before feature and runner configuration disclosure`.

#### FINAL-P1-03 — Moderation rejection reason created three secret/PII sinks — FIXED

The raw super-admin reason was stored in `app_versions.rejection_reason`, audit
details, and an author-visible builder message. **FIXED** by applying the shared
secret/email/phone/long-number scrubber before length validation and before any
of those writes. The full-matrix real-PostgreSQL test asserts all three sinks.

#### P1-09 — Raw X-Forwarded-For trust and stale in-memory rate keys — FIXED

`requestIp` now uses Express's trust-boundary-derived `req.ip`/socket address,
never raw XFF, and every consume sweep removes expired keys from both maps.
Tests: `SAB spoofed X-Forwarded-For cannot split an unauthenticated IP budget`
and `expired attacker-controlled rate keys are swept from both stores`.

#### P1-08 — Fresh attack-only review/sabotage evidence — FIXED

This Ф1–Ф6 audit is the fresh cross-phase review. Its critical controls have
named tests and recorded BREAK→red→restore evidence in the verification log
below; no weakened test or production bypass remains after restore.

### P2 remaining after final closure

1. **Builder audit outage edge:** quota reservation followed by a failure in
   `getGenerationContext` can still miss the failure message/audit, and
   `insertAudit` does not assert one inserted row. This cannot create or execute
   an artifact (historical P2-01).
2. **Semantic free-text PII:** deterministic scrubbing covers secrets, email,
   phone, and long numeric identifiers, but cannot reliably identify every
   human name or prose address without a product DLP policy. Retention is now
   operational; no newly added queue/service/page sink remains raw.
3. **Deployment attestation:** the repository proves the separate Node 24 image
   and CRM package boundary, but cannot attest the live app server's read-only
   rootfs, cap-drop, pids/CPU/memory limits, absence of docker.sock, or network
   ACL. Those remain an operations acceptance check, not a CRM-container native
   dependency.

Historical P2-02 (host byte ceilings) is **FIXED** by the 256 KiB runner request
and CRM response caps plus the gateway response cap. Historical P2-03 is
**FIXED** by the expanded real-PostgreSQL provider/custom deny, live permission,
membership deletion, installer change, kill-state, T-own/T-foreign/T-blast
matrix.

### Deferred and specification conflict

- **DEFERRED Ф7:** arbitrary egress/proxy remains absent exactly as required by
  `APP-STUDIO-001:130-131` and `APP-MOD-001:134-136`.
- **DEFERRED Ф8:** public catalog/commerce, KYC, 2FA, payout/payment, and the
  unresolved builder-token wallet debit/tariff belong to the money/public phase
  (`APP-STUDIO-001:132-144`; `APP-MOD-001:125-127,134-136`). No rate or charging
  contract was invented in this closure.
- **SPEC CONTRADICTION:** master roadmap `APP-STUDIO-001:129` calls Ф6 “typed
  writes,” while the supplied Ф6 implementation spec `APP-MOD-001:134-136`
  explicitly excludes new tools and write permissions and instead defines
  moderation. This audit followed the phase-specific spec and did not invent a
  write catalog. The roadmap/phase numbering needs an owner decision.

### Verification and sabotage record

The final command results and exact green/red counts are recorded in the task
handoff. Named sabotage controls:

- `SAB APP-FINAL-P0 live execution requires CRM-authoritative artifact authorization before compile`
  was observed red after bypassing the live preflight (`expected
  APP_RUNTIME_SOURCE_MISMATCH`, received `APP_RUNTIME_USAGE_REPORT_FAILED`), then
  the preflight was restored.
- `SAB APP-FINAL-P1 transition responses omit source and rejection sinks are scrubbed across the full matrix`
  was observed red after returning the raw transition row (`source_code` was
  present), then the response projection was restored.

Дата аудита: 2026-07-31. Объект: текущее состояние после `1c6b989a`, `c16185df`, `e4eeccc8`. Это статический adversarial audit; код и тесты не менялись.

## SUMMARY

> Closure update (APP-GAP-FIX-001, 2026-08-01): F1–F8 below are implemented in
> the named files and marked `FIXED`. The original classification table remains
> the point-in-time audit result from 2026-07-31. The architect owns the commit;
> this worktree intentionally contains uncommitted implementation files.

**Вердикт: Ф1–Ф3 не готовы ни к какому production exposure.** Главная причина — нет execution-time связи `source bytes ↔ approved source_sha256 ↔ version_id/run_id`. Любой файл, включая байты draft-версии, можно подать раннеру вместе с run-token другой published-версии. Дополнительно отсутствуют обязательные per-installation spend/resource ceiling с auto-suspend, PII scrub/retention и production runner/dry-run service.

Классификация 138 пронумерованных requirement groups (повторяющиеся и неразрывно связанные нормы сведены в одну строку, но все spec-line указаны):

| Класс | Кол-во |
|---|---:|
| IMPLEMENTED | 84 |
| PARTIAL | 24 |
| MISSING | 6 |
| DEFERRED-BY-DESIGN | 17 |
| CONTRADICTION | 7 |

Прямые ответы на особые вопросы:

1. **Может ли Ф3 создать версию без passing dry run? Да, через internal code path.** Внешний service path вызывает `persistSuccess` только после `await dryRunner.validateAndDryRun` (`backend/src/services/appBuilderService.js:176-183`), и любой throw, включая timeout, уходит в failure без версии (`backend/src/services/appBuilderService.js:217-235`). Но exported `persistSuccess` сам вставляет `app_versions` (`backend/src/services/appBuilderRepository.js:301-315,383-413,460-470`) и не требует ни аттестата dry run, ни даже `scannerReport.dry_run.ok=true`. Реальный DB-тест сам демонстрирует прямой вызов (`tests/appBuilderTenancy.db.test.js:308-325,352-379`).
2. **Tool allowlist проверяется на execution time, не только при генерации.** Раннер отказывает все имена вне трёх (`apps-runtime/src/gatewayClient.js:64-69`); CRM заново проверяет fixed catalog, live `app_version_tools` и live installation consent (`backend/src/services/appRuntimeExecutor.js:32-43,70-76`; `backend/src/services/appRuntimeToolCatalog.js:6-16,28-50,60-65`). Однако execution не доказывает, что это именно код этой версии.
3. **Draft можно исполнить сегодня.** Это нормально в mocked builder dry run (`apps-runtime/src/builderDryRun.js:53-67`). Ненормально то, что manual CLI читает любой файл и передаёт его с любым run-token (`apps-runtime/src/cli.js:7-22`), а `runApplication` не принимает `version_id`/expected hash (`apps-runtime/src/runner.js:232-256`). Dev mint требует published version (`backend/src/services/appRuntimeTokenService.js:155-181`), но раннер не знает, какие байты этой published version соответствуют.
4. **Revocation не убивает in-flight request.** Новый request делает live DB resolution (`backend/src/middleware/appRuntimeAuth.js:56-59`; `backend/src/services/appRuntimeTokenService.js:277-378`). После этого context — обычный object; после `consumeRunCall` нет ни повторной kill-state проверки, ни механизма отмены read-query (`backend/src/services/appRuntimeGatewayService.js:51-72`). Отзыв до `consumeRunCall` блокируется только если отозван сам `app_runs`; отзыв прочих факторов между resolution и dispatch тоже не виден (`backend/src/services/appRuntimeTokenService.js:380-443`).

### Нумерованный реестр всех нормативных требований

#### APP-STUDIO-001

| # | Требование (источник) | Класс | Фактическое состояние |
|---:|---|---|---|
| AS-01 | Приложение — versioned source + declaration of rights, executed in an isolate (`APP-STUDIO-001:28-33`). | PARTIAL | `app_versions`/`app_version_tools` есть (`220_app_runtime_gateway.sql:6-59`), isolate есть (`runner.js:232-257`), но исполняемые bytes не связаны с version/hash. |
| AS-02 | Код пользователю не показывается (`APP-STUDIO-001:28-30`). | IMPLEMENTED | Version API не выбирает `source_code` (`appBuilderRepository.js:98-127`). |
| AS-03 | v1 только read-only; write лишь после operational proof (`APP-STUDIO-001:21`; `:119-120`; `:129`). | IMPLEMENTED | Fixed catalog имеет три read descriptors (`appRuntimeToolCatalog.js:6-16,28-46`); вызов идёт только в read service (`appRuntimeExecutor.js:70-76`). |
| AS-04 | v1 без arbitrary egress; нет `fetch`, `require`, FS, `eval`, npm; только fixed library/gateway (`APP-STUDIO-001:20,22,29-30,149-151`). | PARTIAL | В isolate каналы закрыты (`runner.js:41-56,70-76`), imports rejected (`runner.js:332-347`), но deployment network policy нет (deferred в `APP-RUN-001:137-140`). |
| AS-05 | Compute мерить/ограничивать, не биллить (`APP-STUDIO-001:23,143-144`). | PARTIAL | CPU/memory/calls ограничены (`config.js:3-8`), но `app_runtime_usage`, per-installation resource accounting и auto-suspend отсутствуют. |
| AS-06 | Production runtime живёт на отдельном app server, с CRM общается только HTTPS gateway, без DB/disk/CRM-network access (`APP-STUDIO-001:35-40`). | DEFERRED-BY-DESIGN | Phase 2 явно не включает provisioning/deployment (`APP-RUN-001:24-29,224-226`); production gap признан (`APP-BUILD-001:218-230`). |
| AS-07 | 2–4 long-lived runner containers; read-only rootfs, cap-drop, memory+swap/CPU/pids caps, никогда docker.sock (`APP-STUDIO-001:42-43`). | DEFERRED-BY-DESIGN | Dockerfile только собирает image (`apps-runtime/Dockerfile:1-31`); deployment controls отложены (`APP-RUN-001:137-140`). |
| AS-08 | Fresh isolate на каждый run: 100 ms CPU, 32 MB, ≤5 gateway calls (`APP-STUDIO-001:44-45`). | IMPLEMENTED | Limits (`config.js:3-8`), fresh `new ivm.Isolate` (`runner.js:257`), CPU/call enforcement (`runner.js:273-289,349-370`). |
| AS-09 | Внутри isolate нет DNS/direct network; единственная дверь — gateway (`APP-STUDIO-001:44-45`; `:88`). | IMPLEMENTED | `fetch`/process/module loading отключены (`runner.js:41-56,70-76`); единственный host callback создаёт `GatewayClient` (`runner.js:252-256,272-326`). |
| AS-10 | Instance identity `(app_id, installation_id, run_id)`; нет state reuse между installations; v1 без storage (`APP-STUDIO-001:46-47`). | PARTIAL | Token/DB несут installation/version/run (`appRuntimeTokenService.js:232-238,277-351`), isolate fresh (`runner.js:257`), но сами bytes не привязаны к этой identity. |
| AS-11 | Gateway принимает только registered typed operations; нет arbitrary URL (`APP-STUDIO-001:50-53`). | IMPLEMENTED | Fixed route/catalog/schema (`appRuntimeGateway.js:33-48`; `appRuntimeToolCatalog.js:49-65`; `appRuntimeRequestValidator.js:55-63`). |
| AS-12 | App code не получает CRM keys; short-lived token содержит только installation/version/run/exp/nonce (`APP-STUDIO-001:55-56`). | IMPLEMENTED | Exact claim list/validation/signing (`appRuntimeTokenService.js:10-19,93-139,232-242`); token остаётся host-side (`runner.js:232-256,272`). |
| AS-13 | `company_id` только из installation binding; любой tenant selector отвергается, не игнорируется (`APP-STUDIO-001:57-58`; `:85-86`). | IMPLEMENTED | DB chain derives company (`appRuntimeTokenService.js:277-351`); recursive rejection (`appRuntimeRequestValidator.js:31-53`). |
| AS-14 | Отдельный agent principal на installation; installer — revocable delegator (`APP-STUDIO-001:59-61`). | IMPLEMENTED | Provisioning/binding (`appRuntimeIdentityService.js:154-230`), agent audit actor (`appRuntimeAuditService.js:20-35`), disconnect revocation (`marketplaceService.js:1536-1545`). |
| AS-15 | Live intersection version tools × consent × current installer RBAC/scopes × active states на каждый call; demotion/deletion fail closed (`APP-STUDIO-001:62-64`). | PARTIAL | Next request пересчитывает DB/RBAC (`appRuntimeTokenService.js:277-378`; `appRuntimeExecutor.js:10-29,32-76`), но in-flight race не закрыт; membership deletion блокирует FK (`220_app_runtime_gateway.sql:117-119`). |
| AS-16 | Все responses проходят shared Pulse masking seam (`APP-STUDIO-001:65`). | IMPLEMENTED | Final seam (`appRuntimeGatewayService.js:69-72`); fail-closed masking (`pulseMaskingService.js:83-105,114-136`). |
| AS-17 | На каждый call: audit с app/install, request limit, spend ceiling (`APP-STUDIO-001:66`). | PARTIAL | Audit/rate/call limit есть (`appRuntimeGatewayService.js:61-93`; `appRuntimeAuditService.js:20-36`), spend ceiling нет. |
| AS-18 | Approval pins source hash; runtime отказывается исполнять другие bytes (`APP-STUDIO-001:68-70`; `:87`). | MISSING | CRM pins/checks hash лишь при mint (`appRuntimeTokenService.js:155-187,210-223`); runner API и CLI не принимают expected hash/version (`runner.js:232-256`; `cli.js:7-22`). |
| AS-19 | Draft/sandbox iteration free; super-admin approval только для prod transition; до этого работает prior approved version (`APP-STUDIO-001:71-75,145`). | DEFERRED-BY-DESIGN | Phase 3 явно не добавляет publication/moderation (`APP-BUILD-001:7-9`); создаёт только draft (`appBuilderRepository.js:383-403`). |
| AS-20 | Rejected source сохраняется; rejected→draft только fork new version (`APP-STUDIO-001:76-77`). | DEFERRED-BY-DESIGN | Rejection/moderation routes не в Ф3 (`APP-BUILD-001:7-9`). |
| AS-21 | Exact version states `draft→submitted→in_review→approved→published/revoked`; sandbox — run state, не version (`APP-STUDIO-001:78-79`). | PARTIAL | Enum есть (`220_app_runtime_gateway.sql:13-17`), но transition enforcement: любой status можно сменить на любой; sandbox run state не хранится. |
| AS-22 | Static scanner — только sorting; гарантии обязан давать runtime (`APP-STUDIO-001:80-81`). | PARTIAL | Capability/tool enforcement есть в runner/gateway, но core runtime hash control отсутствует (AS-18). |
| AS-23 | Каждый gateway tool имеет tenancy lint + T-own/T-foreign/T-blast (`APP-STUDIO-001:85-86`). | IMPLEMENTED | Real-PG matrix вызывает все 3 tools, foreign Job, B snapshot (`tests/appRuntimeTenancy.db.test.js:362-556`); DB-unavailable sentinel (`:46-52`). |
| AS-24 | Каждая audited operation read-only и помечена `installation_id` (`APP-STUDIO-001:89-90`). | PARTIAL | Каждый gateway tool attempt помечен (`appRuntimeAuditService.js:20-35`), но сам run lifecycle/output/resource operation не аудируется. |
| AS-25 | Per-installation spend/resource ceiling с auto-suspend + token revocation checked per request/cache ≤30 s (`APP-STUDIO-001:91-92`). | MISSING | Есть только in-memory requests/min (`appRuntimeRateLimit.js:25-40,55-61`) и calls/run (`appRuntimeTokenService.js:380-443`); нет spend/resource aggregate, suspend state и auto-suspend. |
| AS-26 | Apps не получают `send_estimate`/`send_invoice`/SMS (`APP-STUDIO-001:93-95`). | IMPLEMENTED | Exact three reads only (`appRuntimeToolCatalog.js:6-16,28-46`; `apps-runtime/src/config.js:10-14`). |
| AS-27 | Author stats не содержит identifiers; только pre-aggregated projection; stderr/tracebacks только super-admin (`APP-STUDIO-001:96-97`). | DEFERRED-BY-DESIGN | Author statistics/marketplace UI не в Ф1–Ф3 (`APP-BUILD-001:7-9`; `APP-STUDIO-001:124-125,132-133`). Current builder response не отдаёт stderr (`appBuilderService.js:217-235`). |
| AS-28 | Builder chat скрабит secrets **и PII**, имеет retention window; super-admin access логируется (`APP-STUDIO-001:98`). | PARTIAL | Скраббер покрывает 4 secret patterns (`appBuilderSecretScrubber.js:3-30`), но не phone/email/name/address; retention deletion нет (`221_app_studio_builder.sql:31-41`); super-admin read surface/access audit нет. |
| AS-29 | Reuse `marketplace_apps`, installations/events и `platformAppReviews` (`APP-STUDIO-001:100-103`). | PARTIAL | Marketplace app/install reused (`appRuntimeIdentityService.js:31-69`; `appBuilderRepository.js:329-350`), moderation/review queue не подключена (отложено с AS-19). |
| AS-30 | New data: versions, sole-rights tools, principals, retained chats/messages, full runs, `app_runtime_usage` (`APP-STUDIO-001:105-109`). | PARTIAL | Versions/tools/principals/run skeleton в migration 220; chats/messages в 221. `app_runs` не имеет input/output/error/resource measurements (`220...sql:127-160`); `app_runtime_usage` отсутствует. |
| AS-31 | Каждая migration имеет matching rollback (`APP-STUDIO-001:110`). | IMPLEMENTED | `220...sql` + `rollback_220...sql`; `221...sql` + `rollback_221...sql`. |
| AS-32 | Ф1 gateway даёт principal/live rights/masking/audit/limits; Ф2 — runners+isolates/manual reference app; Ф3 — builder в same artifact format/chat/versions (`APP-STUDIO-001:119-123`). | PARTIAL | Основные deliverables есть, но production runner/hash/resource controls и real App Studio mount не замкнуты. |
| AS-33 | Ф4: separate App Studio page, не feedback widget (`APP-STUDIO-001:124-125,146`). | DEFERRED-BY-DESIGN | Ф4 явно позже; фронтенда нет. |
| AS-34 | Ф5: synthetic linked data в separate DB на app server; ни одной prod CRM row (`APP-STUDIO-001:126-128,147`). | DEFERRED-BY-DESIGN | Ф5 explicitly later; current dry run использует in-memory fixtures (`builderDryRun.js:6-35`). |
| AS-35 | Ф6: narrow typed writes с install marker, limits, bulk rollback (`APP-STUDIO-001:129`). | DEFERRED-BY-DESIGN | Ф6 later; current catalog read-only. |
| AS-36 | Ф7: egress proxy с full-URL allowlist, private-address refusal, no redirects, byte budget (`APP-STUDIO-001:130-131`). | DEFERRED-BY-DESIGN | Ф7 later; no proxy/tool exists. |
| AS-37 | Ф8: public marketplace с KYC/2FA/payments (`APP-STUDIO-001:132-133`). | DEFERRED-BY-DESIGN | Ф8 later; Phase 3 makes private draft app (`appBuilderRepository.js:329-350`). |
| AS-38 | First useful slice: own company, manual run, exactly Jobs list/detail + Tasks, one approved version/principal/audit/limits; no contacts/calls/finance/write/network/triggers (`APP-STUDIO-001:135-138`). | PARTIAL | Exact tools/manual reference/principal/audit есть; no migration/flow creates the one approved reference installation/version, и arbitrary-source runner breaks “one approved version” binding. |
| AS-39 | App code не имеет own npm; reconsider only after public marketplace с supply-chain review (`APP-STUDIO-001:149-151`). | IMPLEMENTED | Runtime rejects imports and only runtime package depends on `isolated-vm` (`runner.js:332-347`; `apps-runtime/package.json:15-20`). |
| AS-40 | Generated source is stored in PostgreSQL and materialized by runtime, not kept as deployment filesystem state (`APP-STUDIO-001:19`). | PARTIAL | Source is stored in `app_versions.source_code` (`220_app_runtime_gateway.sql:6-12`), but no runtime materialization/service path exists; CLI reads a caller-selected filesystem file (`apps-runtime/src/cli.js:7-22`). |
| AS-41 | Builder LLM tokens are charged to the customer wallet; compute itself is measured/limited but not billed (`APP-STUDIO-001:143-144`). | MISSING | Phase 3 records `token_usage` and increments a company/day generation count (`appBuilderRepository.js:200-215,218-252`), but no wallet/debit service is called anywhere in the generation path (`appBuilderService.js:145-235`). |

#### APP-GW-001

| # | Требование (источник) | Класс | Фактическое состояние |
|---:|---|---|---|
| GW-01 | Ф1 меняет protected shell ровно 2 requires + 2 mounts (`APP-GW-001:15-17,609-610`). | IMPLEMENTED | Gateway/dev-token pairs: `src/server.js:41-42,99-100`. Phase 3's separate unauthorized mount is B-12. |
| GW-02 | Consent lives in `metadata.app_runtime`; malformed/missing never widens; writer creates parent before nested `jsonb_set` (`APP-GW-001:19-33`). | IMPLEMENTED | Fail-closed parser/intersection (`appRuntimeTokenService.js:80-91,188-200`; `appRuntimeExecutor.js:32-43`). Ф1–Ф3 не добавляют nested writer. |
| GW-03 | Catalog exactly three reads; no Contacts/Calls/Finance/Messages/transitions/generic/write/delivery/URL (`APP-GW-001:38-40`). | IMPLEMENTED | `appRuntimeToolCatalog.js:6-16,28-50`; `apps-runtime/src/config.js:10-14`. |
| GW-04 | Body — JSON object args itself; no query/outer wrapper; max 32 KiB (`APP-GW-001:41-42,155-157`). | IMPLEMENTED | `appRuntimeGateway.js:17,33-39,46-48,59-65`. |
| GW-05 | Reject normalized tenant aliases at any depth before sanitizer/dispatch; never strip (`APP-GW-001:43-46`). | IMPLEMENTED | `appRuntimeRequestValidator.js:6-15,31-53`; executor calls it first (`appRuntimeExecutor.js:70-74`). |
| GW-06 | Reuse strict registry descriptors/schema validator; do not call broad MCP executor/sanitizer (`APP-GW-001:47-54,116-119`). | IMPLEMENTED | Projection (`appRuntimeToolCatalog.js:28-50`), validator (`appRuntimeRequestValidator.js:55-63`), direct read dispatch (`appRuntimeExecutor.js:70-76`). |
| GW-07 | Dedicated HS256 secret ≥32 bytes, algorithm-pinned, no `iat`, exact 5 claims, TTL ≤300 s (`APP-GW-001:55-58`). | IMPLEMENTED | `appRuntimeTokenService.js:10-19,21-45,93-139,232-242`. |
| GW-08 | 256-bit nonce; store only SHA-256; reusable within one 5-call run (`APP-GW-001:59-61`). | IMPLEMENTED | Creation/storage (`appRuntimeTokenService.js:203-227`), constant-time binding (`:65-78,356-359`), atomic limit (`:380-443`). |
| GW-09 | Kill-state DB lookup on every call, cache 0/≤30 s; no cross-request auth/revocation cache (`APP-GW-001:62-64,595-596`). | PARTIAL | Fresh lookup на каждый HTTP request (`appRuntimeAuth.js:56-59`), но revocation after resolution cannot cancel in-flight dispatch (`appRuntimeGatewayService.js:51-72`). |
| GW-10 | Every token-resolved attempt is synchronously audited before response; audit failure gives sanitized 503/no data; invalid claims never attributed (`APP-GW-001:65-69,318-333`). | IMPLEMENTED | Outcome is captured then awaited audit, 503 on failure (`appRuntimeGatewayService.js:73-96`); unauthenticated path has no tenant audit (`appRuntimeAuth.js:19-39,42-62`). Content violation is separated as GW-25. |
| GW-11 | Every success uses live masking viewer/projector (`APP-GW-001:70-72`). | IMPLEMENTED | `appRuntimeGatewayService.js:58-72`; `pulseMaskingService.js:83-136`. |
| GW-12 | 5 attempts/run and 60 requests/installation/minute; run atomic, installation key shared across tokens (`APP-GW-001:73-76,484-493`). | IMPLEMENTED | Persisted atomic update (`appRuntimeTokenService.js:380-443`); installation-key window (`appRuntimeRateLimit.js:30-61`). |
| GW-13 | Shared rate store is prerequisite before horizontal scaling (`APP-GW-001:106-107,619-620`). | DEFERRED-BY-DESIGN | Current implementation explicitly process-local (`appRuntimeRateLimit.js:25-28`); CRM was single-instance in Phase 1. |
| GW-14 | Stable HTTP error/status contract including auth/inactive/consent/RBAC/schema/rate/audit (`APP-GW-001:159-175`). | IMPLEMENTED | Error constructors/routes map stable codes (`appRuntimeErrors.js:3-15`; `appRuntimeGateway.js:19-30`; token/executor/rate services cited above). |
| GW-15 | Errors sanitized and do not reveal foreign entity existence (`APP-GW-001:177-178`). | IMPLEMENTED | Generic inactive/not-found/error mapping (`appRuntimeTokenService.js:353-372`; `appRuntimeGatewayService.js:10-16`). Real-PG foreign Job asserts 404 (`appRuntimeTenancy.db.test.js:416-430`). |
| GW-16 | Principal provisioning takes no company, requires active exact chain, creates one safe agent, no membership/grant, conflicts 409 (`APP-GW-001:182-196`). | PARTIAL | Provisioning implements it (`appRuntimeIdentityService.js:31-69,72-151,154-230`), but membership FK `ON DELETE RESTRICT` means required installer/member deletion cannot occur cleanly (`220...sql:117-119`). |
| GW-17 | Disconnect/revoke revokes principal, disables agent, and live join denies even if cleanup fails (`APP-GW-001:198-200`). | IMPLEMENTED | Transactional revocation (`marketplaceService.js:1536-1545`; `appRuntimeIdentityService.js:233-273`); live status checks (`appRuntimeTokenService.js:256-274`). |
| GW-18 | Mint derives tenant, provisions principal, requires matching published version/consent/tool, creates run, signs after commit, never stores/logs raw token/nonce (`APP-GW-001:202-213`). | IMPLEMENTED | `appRuntimeTokenService.js:141-253`. |
| GW-19 | Per-call resolution binds run/install/version/nonce to all active same-company joins; company never from token/body/path/query/header/env (`APP-GW-001:215-242`). | IMPLEMENTED | `appRuntimeTokenService.js:277-378`; token claims omit company (`:13-19`). |
| GW-20 | Live delegator authz resolved on every call; no permission snapshot (`APP-GW-001:244-247`). | IMPLEMENTED | `appRuntimeExecutor.js:10-29`; invoked each execution (`appRuntimeGatewayService.js:57-60`). |
| GW-21 | Seven-factor catalog×descriptor×version tools×consent×active chain×permission×record scope intersection; no factor widens another (`APP-GW-001:249-266`). | IMPLEMENTED | Catalog/consent/permission (`appRuntimeExecutor.js:32-76`), live chain (`appRuntimeTokenService.js:256-378`), scoped read service (`chatgptMcpReadService.js:83-104,199-214`). |
| GW-22 | Fixed request pipeline: transport → crypto → live DB → RBAC → budgets → tenant reject → catalog/schema/dispatch → mask/audit/response (`APP-GW-001:268-281`). | IMPLEMENTED | Route/auth/gateway/executor ordering (`appRuntimeGateway.js:33-55`; `appRuntimeAuth.js:42-63`; `appRuntimeGatewayService.js:51-96`; `appRuntimeExecutor.js:70-76`). |
| GW-23 | Jobs/Tasks use human delegator for provider/content scope, never agent; foreign/unassigned Job is 404 (`APP-GW-001:283-293`). | IMPLEMENTED | `appRuntimeExecutor.js:53-67`; `chatgptMcpReadService.js:83-104,199-214`; real-PG matrix `appRuntimeTenancy.db.test.js:390-520`. |
| GW-24 | Masking recursively strips phone keys, failure redacts, no local fork/list (`APP-GW-001:295-309`). | IMPLEMENTED | Shared projector only (`appRuntimeGatewayService.js:7,71-72`; `pulseMaskingService.js:83-136`). |
| GW-25 | Audit target/details contain only safe fields and **no args/search/IDs/data/token/nonce/PII/secrets** (`APP-GW-001:318-329,478-482,572-574`). | CONTRADICTION | `details` safe, but arbitrary path `toolName` is copied into `audit_log.target_id` (`appRuntimeAuditService.js:21-35`) even for `TOOL_NOT_FOUND`; a valid-token caller can place a token/PII in the path and have up to 255 chars persisted. |
| GW-26 | Version schema includes hash/status/report; service validates source hash; artifact identity immutable after draft; explicit transitions, never in-place rewrite (`APP-GW-001:340-354`). | PARTIAL | Schema/mint hash check/trigger exist (`220...sql:6-52`; `appRuntimeTokenService.js:155-187`), but no transition machine/reviewer gate; draft can jump directly to published and change source/hash in that same update because trigger tests `OLD.status` (`220...sql:36-44`). |
| GW-27 | `app_version_tools` is sole authority/display cache cannot grant; immutable after draft; exact three names (`APP-GW-001:356-367`). | PARTIAL | Gateway treats it as authority (`appRuntimeExecutor.js:32-43`), fixed catalog narrows names, trigger blocks committed non-draft changes (`220...sql:64-97`). Publication/tool mutation is not serialized (`SELECT status` has no row lock), leaving an approval-time race. |
| GW-28 | Principal table has same-company composite identity and stores no permissions/scopes (`APP-GW-001:369-375`). | IMPLEMENTED | `220_app_runtime_gateway.sql:99-125`. |
| GW-29 | `app_runs` pins artifact/nonce/status/5-call budget and atomically consumes only live/unexpired/bound calls; no full bodies/measurements in Phase 1 (`APP-GW-001:377-386`). | IMPLEMENTED | `220...sql:127-167`; `appRuntimeTokenService.js:380-443`. |
| GW-30 | Matching idempotent rollback drops only owned runtime objects and preserves Marketplace/users/audit; forward→rollback→forward real-PG test (`APP-GW-001:388-394,415-424`). | IMPLEMENTED | Rollback `rollback_220...sql:1-22`; DB tests `appRuntimeIdentity.db.test.js:229-273`. |
| GW-31 | Per-tool T-own/T-foreign/T-blast and complete R/content-scope matrix; B snapshot byte-unchanged (`APP-GW-001:509-519,532-544`). | PARTIAL | Strong combined real-PG test exists (`appRuntimeTenancy.db.test.js:362-556`), but exact custom-role positive Tasks cell and missing-delegator cell are not exercised; most deny coverage uses overrides/provider. |
| GW-32 | Auth/revocation tests cover every listed status, including membership deleted and installer changed, and token tuple/claim matrix (`APP-GW-001:546-559`). | CONTRADICTION | Claims/nonce and ten live kill cases exist (`appRuntimeGateway.test.js:320-398`; `appRuntimeTenancy.db.test.js:558-674`), but membership deletion/installer changed are absent; deletion is structurally blocked by the FK in GW-16, so the required case cannot pass against the declared schema. |
| GW-33 | Run every §13 BREAK→red sabotage on real paths, restore exactly, then fresh independent attack review (`APP-GW-001:521-530,578-605,700-702`). | MISSING | SAB-named tests exist, but spec status itself remains “pending fresh attack-only review” (`APP-GW-001:3`), and no evidence records all 18 required BREAK→red runs. |
| GW-34 | Real-PG suites visibly fail, never green-skip, when DB unavailable (`APP-GW-001:511-519,694-695`). | IMPLEMENTED | Release-blocker sentinels throw and DB tests are skipped only alongside the red sentinel (`appRuntimeIdentity.db.test.js:46-52`; `appRuntimeTenancy.db.test.js:46-52`). |
| GW-35 | Dev mint route needs explicit env + platform super-admin, accepts no company, returns token/run/expiry only, no logging (`APP-GW-001:495-507`). | IMPLEMENTED | `appRuntimeDevTokens.js:14-42,44-53,67-87`; route tests `appRuntimeDevTokenRoute.test.js:64-152`. |
| GW-36 | Hand reference client knows only 3 tools, sends no tenant selector, and can target only configured gateway base (`APP-GW-001:93-95,495-507`). | IMPLEMENTED | `scripts/app-runtime-reference-client.js:3-38,41-70`. |
| GW-37 | Phase 1 must not seed/change any Marketplace catalog row (`APP-GW-001:77-78,421-424`). | IMPLEMENTED | Migration 220 contains no Marketplace INSERT/UPDATE and only adds a supporting index (`220_app_runtime_gateway.sql:3-4`); the matching test asserts no seed (`appRuntimeIdentity.db.test.js:118-130`). |
| GW-38 | Gateway exposes no HTTP tool discovery; reference client knows the approved names (`APP-GW-001:102-103`). | IMPLEMENTED | Router has only `POST /v1/tools/:toolName` (`appRuntimeGateway.js:45-57`); no discovery route exists; client hardcodes a three-name set (`app-runtime-reference-client.js:3`). |
| GW-39 | Phase 1 must not change ChatGPT-MCP behavior or migrate Avatars yet (`APP-GW-001:104-105`). | IMPLEMENTED | New gateway dispatches directly through its own executor (`appRuntimeExecutor.js:70-76`); no ChatGPT route/auth/grant path is mounted or rewritten by the Phase 1 files. Marketplace disconnect only adds app-runtime revocation (`marketplaceService.js:1529-1545`). |
| GW-40 | Normalized consent storage is reconsidered at Ф6 before writes/money tools (`APP-GW-001:29-33,700-702`). | DEFERRED-BY-DESIGN | Ф6 is later; current fail-closed JSON snapshot remains (`appRuntimeTokenService.js:80-91`). |
| GW-41 | Implementation must recheck migration max and choose fresh `N=max+1` with rollback (`APP-GW-001:128-131,337-338`). | IMPLEMENTED | Existing sequence is 219 VAPI isolation → 220 runtime gateway → 221 builder; both 220/221 have matching rollbacks (`backend/db/migrations/219_vapi_company_isolation.sql`; `rollback_220_app_runtime_gateway.sql`; `rollback_221_app_studio_builder.sql`). |
| GW-42 | Phase 1 gateway reads artifact identity/status only and never loads/executes `source_code` (`APP-GW-001:353-354`). | CONTRADICTION | Mint query selects `version.source_code` and hashes it in CRM memory (`appRuntimeTokenService.js:155-187`). This also exposes an internal spec tension with the immediately preceding service-hash-validation requirement (`APP-GW-001:348-349`). Source is not executed, but it is loaded. |

#### APP-RUN-001

| # | Требование (источник) | Класс | Фактическое состояние |
|---:|---|---|---|
| RUN-01 | Standalone package/image imports no CRM backend and talks to CRM only through Phase 1 gateway (`APP-RUN-001:13-14`). | IMPLEMENTED | Package boundary (`apps-runtime/package.json:1-20`; `apps-runtime/src/gatewayClient.js:82-94`); boundary test (`packageBoundary.test.js:14-29`). |
| RUN-02 | Fresh isolate/invocation, 32 MB, 100 ms app CPU, max 5 host calls (`APP-RUN-001:15-16,56-68`). | IMPLEMENTED | `config.js:3-8`; `runner.js:257,270-289,342-370,381-385`. |
| RUN-03 | One dependency-free ESM module exporting only `async function run(ctx)` (`APP-RUN-001:17-18,104-119`). | IMPLEMENTED | Compile/import rejection and namespace check (`runner.js:118-127,332-357`). |
| RUN-04 | Host-only token; copied bridge exposed as `albusto.callTool` and `ctx.callTool`; no host references/errors/token in isolate (`APP-RUN-001:19-20,48-51,78-98`). | IMPLEMENTED | Hardened copied closure (`runner.js:10-116,272-326`), token held by `GatewayClient` (`gatewayClient.js:45-61`). |
| RUN-05 | JSON input/output, ≤64 KiB output, manual CLI, hand reference app (`APP-RUN-001:21-22,115-130`). | IMPLEMENTED | Output inside isolate (`runner.js:152-164`), CLI (`cli.js:7-30`), reference app (`morning-digest/app.js:39-65`). |
| RUN-06 | Codegen/chat/storage/source hash lookup/triggers/sandbox/writes/egress/UI/server provisioning/deployment are later; Phase 2 accepts file/direct source + minted token (`APP-RUN-001:24-29,224-226`). | DEFERRED-BY-DESIGN | Implementation intentionally is library+CLI; this defer is also the source of production blockers AS-06/AS-18. |
| RUN-07 | CommonJS host, real ESM app, `isolated-vm@6.0.2` only here, Node 24, all entry points `--no-node-snapshot` (`APP-RUN-001:31-40`). | IMPLEMENTED | `apps-runtime/package.json:6-19`; `Dockerfile:1,20-31`; CLI scripts. |
| RUN-08 | Runner fixed to same 3 tools; CRM remains authoritative for version/consent/RBAC/tenancy/rate/mask/audit (`APP-RUN-001:41-44`). | IMPLEMENTED | Runner `config.js:10-14` + `gatewayClient.js:64-67`; CRM executor/gateway checks in GW-21. |
| RUN-09 | Reference `today` is company-local YYYY-MM-DD supplied by invoker; never server-local derivation (`APP-RUN-001:45-47`). | IMPLEMENTED | Reference app validates supplied input (`morning-digest/app.js:39-43`); no `Date()` in app. |
| RUN-10 | Gateway failures cross only copied sanitized data as sandbox-native `GatewayError` (`APP-RUN-001:48-51`). | IMPLEMENTED | Host envelope (`runner.js:303-322`) and sandbox reconstruction (`runner.js:58-81`). |
| RUN-11 | Serialize/size output inside isolate before host copy (`APP-RUN-001:52-54`). | IMPLEMENTED | `runner.js:135-164,359-372`. |
| RUN-12 | Dispose isolate on every result/failure; CPU/memory/sixth call dispose immediately and abort in-flight calls (`APP-RUN-001:56-62`). | IMPLEMENTED | `runner.js:263-268,273-289,373-385`. |
| RUN-13 | Gateway waiting is not charged as app CPU; baseline before instantiation/evaluation and checked at bridges/result (`APP-RUN-001:64-68`). | IMPLEMENTED | `runner.js:226-230,273-280,342-370`. There is no wall timeout, captured as P0-02 under broader resource ceiling. |
| RUN-14 | Fail closed `require/process/fetch/eval/Function/global constructor/WebAssembly/timers`; no Node/FS/loader/network/process/timer (`APP-RUN-001:70-76`). | IMPLEMENTED | `runner.js:22-56,91-116`; isolation tests `isolation.test.js:7-46`. |
| RUN-15 | App cannot select origin/path/headers; base URL credential-free HTTP(S); block token echo in source/input/response (`APP-RUN-001:94-98,130`). | IMPLEMENTED | `gatewayClient.js:8-29,64-123`; `runner.js:201-223,245-256`; tests `isolation.test.js:65-110`, `bridge.test.js:7-86`. |
| RUN-16 | Attempt 6 fails before fetch; local limit independent of CRM (`APP-RUN-001:100-102,157-165`). | IMPLEMENTED | `runner.js:282-289`; sabotage/limit test `limits.test.js:32-47`. |
| RUN-17 | Frozen `ctx`/input; output JSON-valid/not undefined/≤65536 bytes; no second entry/state reuse (`APP-RUN-001:115-119`). | IMPLEMENTED | `runner.js:129-164`; fresh-state test `isolation.test.js:113-128`; output test `limits.test.js:68-76`. |
| RUN-18 | Final image has prod deps only and unprivileged Node user (`APP-RUN-001:132-137`). | IMPLEMENTED | `apps-runtime/Dockerfile:17-31`. |
| RUN-19 | Deployment must add read-only rootfs/cap-drop/memory+swap/CPU/pids/no socket/gateway-only network (`APP-RUN-001:137-140,213-216`). | DEFERRED-BY-DESIGN | Deployment explicitly not Phase 2 (`APP-RUN-001:140`); no deployment manifest exists in these commits. |
| RUN-20 | Required isolation/format/resource/bridge/token/output/reference test matrix (`APP-RUN-001:142-153`). | IMPLEMENTED | `apps-runtime/test/{isolation,limits,bridge,morningDigest,packageBoundary}.test.js`. |
| RUN-21 | BREAK the local sixth-call guard, named test goes red, exact reverse restore/full green (`APP-RUN-001:155-167`). | IMPLEMENTED | Recorded sabotage and test (`APP-RUN-001:196-205`; `limits.test.js:32-47`). |
| RUN-22 | Runner process must never be colocated with CRM infrastructure (`APP-RUN-001:220-223`). | CONTRADICTION | Phase 3 CRM deliberately spawns the Node 24 isolate runner as a local child (`appBuilderDryRunService.js:60-71`; `APP-BUILD-001:21-32,218-223`). The later production-gap note does not narrow the earlier absolute “never”. |
| RUN-23 | Fresh attack-only review by a different session/person is required before release (`APP-RUN-001:230-231`). | MISSING | No independent review is recorded; this document is the implementer's self-audit. |
| RUN-24 | Phase 3 may generate only the exact Phase 2 artifact and must not add modules/npm/egress/writes/another entry point (`APP-RUN-001:231-233`). | IMPLEMENTED | Builder source policy and shared runner enforce the same ESM entry/import/tool/capability contract (`builderSourcePolicy.js:190-255`; `builderDryRun.js:53-61`). |
| RUN-25 | Any Node/V8/`isolated-vm` upgrade requires rebuilding and rerunning the attack suite (`APP-RUN-001:217-219`). | DEFERRED-BY-DESIGN | Current package/image remain pinned to Node 24 + `isolated-vm` 6.0.2 (`apps-runtime/package.json:8-17`; `Dockerfile:1,20`); no upgrade has occurred in scope. |

#### APP-BUILD-001

| # | Требование (источник) | Класс | Фактическое состояние |
|---:|---|---|---|
| B-01 | Ф3 adds backend/chat/codegen/static/mock dry run only; no UI/publication/moderation/prod run/synthetic sandbox/write/egress/trigger/dependency/install flow (`APP-BUILD-001:5-9`). | IMPLEMENTED | Added files are builder backend/migration/runtime validator; no such extra product surface except premature route mount addressed in B-12. |
| B-02 | For every user message persist only scrubbed text, reserve company/day generation, generate one ESM source+description, static-validate then dry-run, and transactionally persist draft/hash/exact tools/message/audit only after both gates (`APP-BUILD-001:11-19`). | PARTIAL | Public service ordering is correct (`appBuilderService.js:145-210`), but scrub is not PII-complete and exported repository bypasses both gates (`appBuilderRepository.js:301-315,383-457`). |
| B-03 | Fixed child protocol; no shell/user-selected path/args/inherited secrets/network gateway/raw token/duplicate isolate (`APP-BUILD-001:21-32`). | IMPLEMENTED | `spawn(..., shell:false)` with fixed CLI args and minimal env (`appBuilderDryRunService.js:60-71`); dry run calls shared runner with fixture fetch (`builderDryRun.js:53-61`). |
| B-04 | Generated source uses exact Phase 2 ESM; no CommonJS second format (`APP-BUILD-001:36-39`). | IMPLEMENTED | Source policy exact entry (`builderSourcePolicy.js:213-225`); runtime namespace check (`runner.js:118-127`). |
| B-05 | On non-Node-24 CRM, configured Node 24 executable required; misconfiguration fails before version storage (`APP-BUILD-001:40-43`). | IMPLEMENTED | `runnerExecutable` throws (`appBuilderDryRunService.js:28-36`) before child/service persistence; service catch returns no version (`appBuilderService.js:217-235`). Production availability remains B-29. |
| B-06 | First successful artifact creates one private/draft Marketplace app + ownership + `builder-1`; later successes create `builder-N` for same owned app (`APP-BUILD-001:44-51`). | IMPLEMENTED | `appBuilderRepository.js:315-382,383-457`; composite ownership migration `221...sql:3-26`. |
| B-07 | Public Marketplace apps are not writable through Studio (`APP-BUILD-001:48-51`). | IMPLEMENTED | Every write resolves `app_studio_apps(company_id,app_id)` (`appBuilderRepository.js:360-403`); create-chat ownership check (`:33-48`). |
| B-08 | New Marketplace profile includes complete `metadata.assistant` and no company/chat/prompt/source/token/secret metadata (`APP-BUILD-001:52-54`). | IMPLEMENTED | Projection (`appBuilderService.js:118-129`) is the only metadata supplied (`:204-208`; repository `:329-343`). |
| B-09 | UTC quota default 50, reservation before paid provider, failed validation still consumes attempt; exhaustion 429 before LLM (`APP-BUILD-001:55-61`). | IMPLEMENTED | `appBuilderService.js:23-28,145-168`; UTC counter (`appBuilderRepository.js:200-215`); quota sabotage test (`appBuilderService.test.js:166-188`). |
| B-10 | Provider/static/dry-run failures, including timeout/error branches, persist failed assistant message and create no version (`APP-BUILD-001:59-61,85-90`). | IMPLEMENTED | All errors thrown from provider/dry run are caught before persistence (`appBuilderService.js:167-183,217-235`); child timeout rejects (`appBuilderDryRunService.js:84-90`). Internal direct persistence bypass is separately B-28. |
| B-11 | Independent provider/model fallback chain (`APP-BUILD-001:62-64`). | IMPLEMENTED | `appBuilderProviderService.js:22-35`; tests `appBuilderProviderService.test.js:20-38`. |
| B-12 | Protected runtime shell is not modified until architect authorizes exact mount; mounted API must include authenticate + permission + company access (`APP-BUILD-001:67-69,128-140,213`). | CONTRADICTION | Commit changed protected shell (`src/server.js:43,101`) although spec still says pending. Worse, mount occurs before JSON/request-id/auth middleware (`src/server.js:99-108`) and supplies none; router starts at permission gate (`appStudio.js:46-49`). Tests inject body/auth/company themselves (`appStudioRoutes.test.js:31-47`), hiding the broken real mount. |
| B-13 | Static validation: ≤65536 bytes, exact sole async run, parse through isolated-vm, no static/dynamic import, banned identifiers (`APP-BUILD-001:71-80`). | IMPLEMENTED | `builderSourcePolicy.js:5-14,190-225`; `builderValidator.js:10-32`; tests `builderDryRun.test.js:7-43`. |
| B-14 | Only direct literal `ctx.callTool('<name>',args)` and every name in exact Phase 1 catalog (`APP-BUILD-001:81-83`). | CONTRADICTION | Lexer checks only occurrences of identifier token `callTool` (`builderSourcePolicy.js:227-248`). `Reflect.get(ctx,'callTool')('svc.list_tasks',{})` passes policy with `tools:[]` (confirmed by direct invocation); runtime dry run can execute it because `ctx` contains the function (`runner.js:152-155`). Gateway still fails closed unless tool separately declared. |
| B-15 | Dry run reuses fresh 32 MB/100 ms/5-call/64 KiB/frozen/hardened/disposed runner, deterministic read fixtures, fixed input, JSON output; violations reject (`APP-BUILD-001:85-90`). | IMPLEMENTED | Shared `runApplication` call/fixtures (`builderDryRun.js:6-67`); Phase 2 enforcement in `runner.js`; builder tests `builderDryRun.test.js:7-58`. |
| B-16 | Scanner is defense-in-depth; isolate and CRM gateway remain later execution boundaries (`APP-BUILD-001:92-93`). | PARTIAL | Runtime does enforce capabilities/tools, but no runtime source-hash boundary means scanner-approved bytes are not tied to later execution (AS-18). |
| B-17 | Before storage/model, scrub bearer/api-key/password/long base64 from user chat/title (`APP-BUILD-001:95-103`). | IMPLEMENTED | Scrubber (`appBuilderSecretScrubber.js:3-30`) is applied in `cleanTitle`/`cleanMessage` (`appBuilderService.js:30-48`) before append/prompt. This does not satisfy broader PII requirement AS-28. |
| B-18 | Raw user input never inserted/audited; generated secret-like source rejected, not rewritten (`APP-BUILD-001:104-105`). | IMPLEMENTED | Raw becomes scrubbed before repository (`appBuilderService.js:145-148`); source equality check rejects (`:168-175`); audits contain no text/source (`appBuilderRepository.js:218-252`). |
| B-19 | Messages retain scrubbed text/model/tokens/version/timestamps **with no retention deletion in Phase 3** (`APP-BUILD-001:106-107`). | CONTRADICTION | Schema indeed has no expiry/deletion (`221...sql:31-63`), directly conflicting with release-minimum retention window in `APP-STUDIO-001:98`. |
| B-20 | Every accepted attempt writes awaited safe `app_builder.generation` audit with outcome/model/tokens/app/version/safe code only (`APP-BUILD-001:109-112`). | PARTIAL | Success/failure transactions await safe audit (`appBuilderRepository.js:218-252,255-299,436-446`), but `getGenerationContext` is outside generation `try` (`appBuilderService.js:165-167`): a failure after quota reservation produces neither failure message nor generation audit. `insertAudit` also does not assert one row was inserted. |
| B-21 | Migration 221 creates ownership/chats/messages/quota and matching rollback drops only Phase 3 (`APP-BUILD-001:114-124`). | IMPLEMENTED | `221_app_studio_builder.sql:3-80`; `rollback_221...sql:1-6`; DB forward/rollback test `appBuilderTenancy.db.test.js:169-219`. |
| B-22 | Real parent API mount is `/api/app-studio` with `authenticate`, permission, `requireCompanyAccess`, router (`APP-BUILD-001:126-140`). | MISSING | Actual `src/server.js:99-108` mounts the router before and without these prerequisites. Router itself imports only `requirePermission` (`appStudio.js:3-6,46-47`). In a real request `req.authz` is absent and `requirePermission` returns 403 (`authorization.js:95-121`). |
| B-23 | Router additionally requires exact tenant_admin; company only from `companyFilter`, actor only CRM user; fixed five routes; unknown keys rejected; foreign IDs indistinguishable 404 (`APP-BUILD-001:138-151`). | IMPLEMENTED | Router checks/derives exactly this (`appStudio.js:10-29,46-130`); repository company-scopes every query (`appBuilderRepository.js:33-128,130-197,301-457`). |
| B-24 | Every Studio route and quota/audit obey tenancy/RBAC matrix; A operations leave B snapshot byte-unchanged (`APP-BUILD-001:153-165`). | IMPLEMENTED | Route role matrix (`appStudioRoutes.test.js:73-137`); real-PG ownership/T-blast (`appBuilderTenancy.db.test.js:221-404`). |
| B-25 | Required unit/DB/runtime gates and quota BREAK→red→restore (`APP-BUILD-001:167-194`). | IMPLEMENTED | Test files/commands and recorded observed gates exist; quota sabotage test is `appBuilderService.test.js:166-188`. This audit did not claim a fresh execution of those historical gates. |
| B-26 | Phase 4 must not expose source absent a separate product/security decision (`APP-BUILD-001:211-216`). | DEFERRED-BY-DESIGN | Ф4 later; current version API already excludes source (`appBuilderRepository.js:98-127`). |
| B-27 | Source policy may conservatively reject safe Unicode but must not widen runtime authority (`APP-BUILD-001:201-203`). | IMPLEMENTED | Non-ASCII identifier rejection (`builderSourcePolicy.js:120-131,169-171`); execution remains narrowed by runner+gateway even when scanner extraction misses indirect calls. |
| B-28 | There must be no version creation path before passing static validation + dry run (`APP-BUILD-001:13-19,43,59-61,227-228`). | PARTIAL | HTTP service path is ordered/fail-closed (`appBuilderService.js:167-183,217-235`), but exported `persistSuccess` accepts arbitrary source/hash/report/tools and inserts directly (`appBuilderRepository.js:301-315,383-413,460-470`). |
| B-29 | Production dry run must be remote app-server service; until then `/api/app-studio` must not reach live users (`APP-BUILD-001:218-230`). | DEFERRED-BY-DESIGN | Spec explicitly assigns remote service to Ф4/Ф5 (`:225-230`). Current local spawn (`appBuilderDryRunService.js:60-71`) is non-production. The premature/broken mount is the contradiction B-12. |
| B-30 | A new chat may be app-less; subsequent versions only attach to an owned app; version list never returns source (`APP-BUILD-001:44-51,142-150`). | IMPLEMENTED | Nullable composite ownership (`221...sql:14-26`), create/list/persist scope (`appBuilderRepository.js:33-48,98-128,315-403`). |

## P0

### P0-01 — Execution-time source-hash pinning отсутствует — FIXED

**Статус: FIXED (F1).** Commit pending architect; implementation files:
`apps-runtime/src/runner.js`, `apps-runtime/src/cli.js`,
`apps-runtime/test/gapFixes.test.js`. `expectedSourceSha256` обязателен, mismatch
даёт `APP_RUNTIME_SOURCE_MISMATCH` до `compileModule`; SAB byte-substitution
контроль записан именованным тестом.

Controls AS-18/§5(2) не выполнены. CRM проверяет `sha256(source_code)==source_sha256` при mint и копирует hash в `app_runs` (`appRuntimeTokenService.js:155-187,210-223`), но hash никогда не доходит до `runApplication`. CLI просто читает caller-selected file (`apps-runtime/src/cli.js:7-22`). Это разрешает arbitrary/draft source пользовать live authority чужой published version. Fixed tool allowlists ограничивают blast radius, но не исправляют artifact substitution.

### P0-02 — Нет mandatory per-installation spend/resource ceiling, auto-suspend и bounded run occupancy — FIXED

**Статус: FIXED (F2).** Commit pending architect; implementation files:
`backend/db/migrations/222_app_studio_gap_fixes.sql`,
`backend/src/services/appRuntimeTokenService.js`,
`backend/src/routes/appRuntimeGateway.js`, `apps-runtime/src/gatewayClient.js`,
`apps-runtime/src/runner.js`. Host gateway fetch имеет timeout/response-byte cap;
completion telemetry пишет wall/calls/result/error в `app_runs`; PostgreSQL daily
usage atomically auto-suspends installation control, blocking later mint/calls.

§5(5) требует aggregate ceiling + auto-suspend. Код имеет только 60 requests/minute в process-local `Map` (`appRuntimeRateLimit.js:25-40,55-61`) и 5 calls/run (`appRuntimeTokenService.js:380-443`). `app_runtime_usage` нет; `app_runs` не записывает CPU/memory/wall/output/error (`220_app_runtime_gateway.sql:127-160`). Более того, host `fetch` не имеет timeout/response-byte ceiling (`apps-runtime/src/gatewayClient.js:82-105`), а waiting не считается CPU; пять stalled calls могут занять runner бессрочно.

### P0-03 — Builder не выполняет PII scrub + retention minimum — FIXED

**Статус: FIXED (F3).** Commit pending architect; implementation files:
`backend/src/services/appBuilderSecretScrubber.js`,
`backend/src/services/appBuilderRetentionPolicy.js`,
`backend/src/services/appBuilderRepository.js`, migration 222. Email, E.164/local
phones и long digit sequences маскируются до storage и повторно перед model use;
retention configurable (`APP_BUILDER_MESSAGE_RETENTION_DAYS`, default 365), cleanup
company-scoped и сохраняет chat row.

Скраббер не удаляет phones, emails, names, addresses и other PII (`appBuilderSecretScrubber.js:10-30`). Эти данные персистятся (`appBuilderRepository.js:130-156`) и отправляются external model в history (`appBuilderService.js:59-103,165-169`; `appBuilderProviderService.js:87-110`). У таблицы нет expiry/deletion policy (`221_app_studio_builder.sql:31-63`). Это прямо нарушает release-minimum `APP-STUDIO-001:98`.

### P0-04 — Production runner/dry-run isolation boundary ещё не существует — FIXED

**Статус: FIXED (APP-SVC-001 / Ф4).** `apps-runtime/src/server.js` exposes the
authenticated, body-bounded, deadline-bounded `/v1/dry-run` and `/v1/run`
service on the application-server boundary. CRM `appBuilderDryRunService` now
uses only `APP_RUNNER_BASE_URL` + `APP_RUNNER_SERVICE_TOKEN`; the local Node
spawn/fallback is removed. The production-only 404 is removed, while the
explicit product flag remains and incomplete runner configuration returns 503.
`docs/specs/APP-SVC-001.md` records the service, deployment, UI, and test
contract.

Исходная находка до APP-SVC-001: не было app-server service, production token
delivery и remote builder dry-run endpoint. Specs откладывали seam
(`APP-RUN-001:224-226`; `APP-BUILD-001:218-230`) и запрещали live exposure до
него (`APP-BUILD-001:225-228`). Hardened multi-container deployment/network
policy остаётся обязательным deployment control, а не кодовым fallback.

Исходная находка также фиксировала native `isolated-vm` child внутри CRM
process/container boundary. APP-SVC-001 удалил этот spawn и не оставил локального
fallback; `isolated-vm` загружается только пакетом `apps-runtime`.

## P1

### P1-01 — Real `/api/app-studio` mount неработспособен и тесты скрывают разрыв — FIXED

**Статус: FIXED (архитектор).** Ранний mount перед `express.json`/`requestId`/`authenticate` убран; роутер теперь монтируется рядом с остальными защищёнными API: `app.use('/api/app-studio', authenticate, requireCompanyAccess, appStudioRouter)` (`src/server.js:168`). APP-SVC-001 сохранил `APP_STUDIO_ENABLED`, заменил временный production-404 на обязательную remote-runner configuration проверку и 503 при её отсутствии.

`src/server.js:101` монтирует router до `express.json`, request ID, `authenticate` и `requireCompanyAccess` (`src/server.js:103-108,133-135`). Router сразу вызывает `requirePermission` (`appStudio.js:46`), поэтому real request fail-closed на 403. Tests сами подкладывают body/user/authz/company (`appStudioRoutes.test.js:31-47`). Это блокирует Ф4 integration.

### P1-02 — Internal Ф3 persistence bypasses dry-run gate — FIXED

**Статус: FIXED (F4).** Commit pending architect; implementation file:
`backend/src/services/appBuilderRepository.js`; tests:
`tests/appBuilderRepositoryAttestation.test.js`,
`tests/appBuilderTenancy.db.test.js`. Persistence rejects missing `dry_run.ok=true`
or a source/SHA mismatch before opening a transaction.

`persistSuccess` exported и не валидирует source hash, scanner report, `dry_run.ok` и tool catalog (`appBuilderRepository.js:301-315,383-413,460-470`). Обычный HTTP path безопасен, но normative invariant “ни одной версии до двух gates” не защищён на persistence boundary.

### P1-03 — Revocation имеет TOCTOU и не отменяет in-flight reads — FIXED

**Статус: FIXED (F5).** Commit pending architect; implementation file:
`backend/src/services/appRuntimeTokenService.js`; test:
`tests/appRuntimeTenancy.db.test.js`. `consumeRunCall` atomically rechecks the live
run/principal/agent/version/installation/app/company/delegator/membership chain;
named SAB revocation-between-resolve-and-consume control is recorded.

Live chain/RBAC решаются до budget/dispatch (`appRuntimeGatewayService.js:51-70`). Отзыв после этой точки не отменяет read. `consumeRunCall` перепроверяет только run row, не principal/agent/version/install/app/company/delegator/member (`appRuntimeTokenService.js:380-443`). Existing tests отзывают state **до** `resolveRunContext`, поэтому race не покрыт (`appRuntimeTenancy.db.test.js:599-674`).

### P1-04 — Installer/member deletion, обещанное fail-closed, фактически блокируется FK — FIXED

**Статус: FIXED (F6).** Commit pending architect; migration 222 removes the
membership FK (the brief-approved alternative to `ON DELETE SET NULL`) while the
consume-time live membership join stays fail-closed. Real-PG test proves membership
deletion succeeds, preserves the principal, and the next call receives 403.

`app_installation_principals(delegated_by_user_id,company_id)` ссылается на membership `ON DELETE RESTRICT` (`220_app_runtime_gateway.sql:117-119`). Это не даёт удалить membership/installer, вместо того чтобы удаление на следующем request убило authority. Тест membership-deleted отсутствует.

### P1-05 — Artifact/tool immutability не закрывает approval-time races/transitions — FIXED

**Статус: FIXED (APP-MOD-001).** Migration 223 adds the exact database
transition guard, rejects artifact mutation in the same statement that leaves
draft, and locks the parent version for every tool mutation. All application
status writes now go through `appVersionTransitionService`, whose transaction
locks the version with `SELECT ... FOR UPDATE`, validates the fixed matrix, and
writes awaited transition audit. A real-PostgreSQL concurrent-approve test
proves exactly one success; its named sabotage becomes red when `FOR UPDATE` is
removed. The same phase adds the super-admin queue, rejection-message delivery,
rejected-version fork, publication pin advance, and live revoke path.

### P1-06 — Builder “direct literal call only” scanner bypass — FIXED

**Статус: FIXED (F8).** Commit pending architect; implementation file:
`apps-runtime/src/builderSourcePolicy.js`; tests:
`tests/appBuilderSourcePolicy.test.js`, `apps-runtime/test/builderDryRun.test.js`.
Reflective/computed capability extraction (`Reflect`, `Object` reflection and
literal `callTool` property lookup) is conservatively rejected.

`Reflect.get(ctx,'callTool')` не попадает в identifier-based extraction (`builderSourcePolicy.js:227-248`) и возвращает `tools:[]`, хотя dry run вызовет tool. Gateway version allowlist по-прежнему fail-closed, поэтому это не privilege escalation, а нарушение artifact manifest/scanner integrity и способ создать draft, который не сможет пройти mint.

### P1-07 — Audit target может сам стать secret/PII sink — FIXED

**Статус: FIXED (F7).** Commit pending architect; implementation file:
`backend/src/services/appRuntimeAuditService.js`; test:
`tests/appRuntimeAuditService.test.js`. Known tools retain catalog IDs; unknown
names persist only `unknown:<truncated sha256>` plus `details.unknown_tool=true`.

Unknown tool должен аудироваться, но raw path parameter пишется в `target_id` (`appRuntimeAuditService.js:21-35`). Direct valid-token caller может передать token, phone/email или search text как tool name. Это обходит safe `details`, которые сами по себе корректны.

### P1-08 — Fresh independent attack review и complete sabotage evidence — FIXED

**Статус: FIXED by the final Ф1–Ф6 closure above.**

`APP-GW-001:3` сам говорит “pending fresh attack-only review”; `APP-RUN-001:230-233` требует то же. В репо есть много SAB tests, но нет recorded BREAK→red для всех 18 gateway controls; самоаудит автора не заменяет independent review.

### P1-09 — Unauthenticated limiter доверяет raw `X-Forwarded-For`, stores never-expiring keys — FIXED

**Статус: FIXED.** `req.ip`/socket is the only key source and expired
entries are swept on consume; named spoof/cleanup tests are in the final closure.

`requestIp` берёт client-controlled header до `req.ip` (`appRuntimeRateLimit.js:48-52`), а `Map` entries никогда не удаляются (`:27-40`). Без жёсткой proxy normalization атакующий обходит IP budget и растит RAM.

### P1-10 — Builder token usage is measured but never charged to the wallet — DEFERRED Ф8

**Status: DEFERRED to the public/money phase.** The owner decision requires a
wallet debit but no tariff/charging contract exists; `APP-STUDIO-001:132-144`
places payment/commerce in Ф8 and says compute itself is not billed. This closure
does not invent money behavior.

Parent owner decision says LLM tokens are deducted from the wallet (`APP-STUDIO-001:143-144`). Builder records model token counts in message/audit and enforces a flat company/day quota (`appBuilderRepository.js:200-215,218-252`), but the generation path contains no wallet balance lookup/debit (`appBuilderService.js:145-235`). This is a billing/consent gap before enabling the paid provider for tenants.

## P2

### P2-01 — Builder audit completeness has outage edge cases

Quota is reserved, then `getGenerationContext` runs outside the `try` (`appBuilderService.js:149-167`). A DB error there produces no persisted failed assistant message and no `app_builder.generation` audit. `insertAudit` awaits the query but does not verify `rowCount===1` (`appBuilderRepository.js:218-253`). Это не создаёт версию и не расширяет authority, но делает accounting incomplete.

### P2-02 — Runtime has no explicit source/input/gateway-response host byte ceilings — FIXED

**Статус: FIXED by APP-SVC-001.** The runner caps the complete HTTP body
at 256 KiB, CRM caps runner responses at 256 KiB, and the host gateway client
caps CRM responses before JSON delivery.

Builder source is capped at 64 KiB, но generic Phase 2 `runApplication` accepts any source string (`runner.js:232-250`); host input serializes without size cap (`runner.js:201-223`); gateway parses response without byte ceiling (`gatewayClient.js:86-105`). Container cap was intended as outer boundary but is not deployed. Это следует рассматривать вместе с P0-02, но отдельно эти caps не были заданы Phase 2 spec.

### P2-03 — Exact R-matrix/revocation test plan не полностью табличный — FIXED

**Статус: FIXED by F5/F6 and the final closure.** The real-PostgreSQL
matrix now includes provider scope cells, live permission deny, every active
chain kill state, installer change, membership deletion, and tenant blast
snapshots; route units retain the custom-role deny cells.

Real-PG gateway coverage сильное, но не имеет exact custom-role positive Tasks cell, missing-delegator cell, membership-deleted и installed_by-changed cases (`tests/appRuntimeTenancy.db.test.js:390-520,599-674`). Это test-evidence gap; actual permission/scoping paths для большинства соседних случаев fail closed.

## DEFERRED-BY-DESIGN

1. **Production app server and container pool** — `APP-RUN-001:24-29,137-140,224-226`; требуется до exposure, хотя отложено из Ф2.
2. **Remote production builder dry-run service** — `APP-BUILD-001:218-230`, назначен на Ф4/Ф5.
3. **App Studio UI** — Ф4 (`APP-STUDIO-001:124-125`).
4. **Separate synthetic sandbox DB** — Ф5 (`APP-STUDIO-001:126-128`). Current fixed in-memory fixtures — dry run, не Ф5.
5. **Writes/bulk rollback** — Ф6 (`APP-STUDIO-001:129`).
6. **External egress proxy** — Ф7 (`APP-STUDIO-001:130-131`).
7. **Public marketplace/author statistics/KYC/2FA/payment** — Ф8 (`APP-STUDIO-001:132-133`); поэтому control §5(7) пока не имеет author-stats surface, но остаётся release requirement.
8. **Distributed rate limiter** — only before horizontal CRM scaling (`APP-GW-001:106-107,619-620`).
9. **Full run storage/usage metrics** — Phase 1 явно ограничил `app_runs` skeleton (`APP-GW-001:377-386`), а Phase 2 отложил app storage/server (`APP-RUN-001:24-29`). Однако до production это переходит в P0-02 из-за §5(5).

## CONTRADICTIONS

1. **Parent retention minimum vs Phase 3 “no retention deletion”.** `APP-STUDIO-001:98` требует retention window как минимум до release; `APP-BUILD-001:106-107` явно фиксирует отсутствие retention deletion в Ф3. Code следует младшей спеке и нарушает parent minimum (`221_app_studio_builder.sql:31-63`).
2. **Protected mount declared pending/not modified, but code modified it and mounted an incomplete chain.** `APP-BUILD-001:67-69,128-140,213` vs `src/server.js:43,99-108`. Это одновременно spec↔code contradiction и functional P1.
3. **Installer deletion must fail closed, but FK forbids deletion.** `APP-STUDIO-001:62-64` и `APP-GW-001:552-555,627-630` ожидают, что deletion убивает authority. `220_app_runtime_gateway.sql:117-119` ставит `ON DELETE RESTRICT`, блокируя само deletion.
4. **Audit promises no PII/token, but raw invalid tool path persists.** `APP-GW-001:326-329,478-482,572-574` vs `appRuntimeAuditService.js:21-35`.
5. **Builder promises only direct literal tool calls, but source policy accepts indirect Reflect access.** `APP-BUILD-001:81-83` vs `builderSourcePolicy.js:227-248`; direct policy invocation returned `{"sourceBytes":101,"tools":[],"entryPoint":"run"}` for `Reflect.get(ctx,'callTool')` source.
6. **Runner must never be colocated with CRM, but Phase 3 intentionally spawns it there.** `APP-RUN-001:220-223` is absolute; `APP-BUILD-001:21-32,218-223` and `appBuilderDryRunService.js:60-71` implement a local CRM child. The production-gap note explains intent but does not resolve the current spec conflict.
7. **Phase 1 says both “validate hash against source” and “never load source_code”; code chooses the first.** `APP-GW-001:348-354` is internally inconsistent. `appRuntimeTokenService.js:155-187` loads and hashes source during mint, so the absolute no-load statement is false even though source is not executed.
