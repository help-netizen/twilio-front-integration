# VAPI-AGENCY-001 — план реализации T1–T10

Статус: draft; оценки инженерные, без UI-дизайна
Дата: 2026-08-16
Головная спека: `docs/specs/VAPI-AGENCY-001.md`
Тест-кейсы: `docs/test-cases/VAPI-AGENCY-001.md`

## 1. Фазы и gate

| Фаза | Задачи | Ценность/exit criterion |
|---|---|---|
| Phase 1 — измерение истины | T1–T4 | У каждой новой ABC AI-ноги есть устойчивый Vapi id; EoC сохраняется provisional, supplier `GET` сходится в final или даёт `stale_pending` + alert; списаний ещё нет |
| Phase 2 — tenant safety | T5–T8 | Registry/resource/credentials fail-closed, outbound не использует global assistant env, provisioning проверяется readback, global + company admission атомарен |
| Phase 3 — деньги и контракт данных | T9 | Версионируемый cost-plus создаёт exact charges и один settlement debit существующего wallet; tenant видит только минуты/звонки/сумму |
| Phase 4 — эксплуатация и rollout | T10 | ABC backfill/audit/observability завершены; controlled rollout второго tenant возможен по runbook |

**Непроходимый gate:** до приёмки T1–T8 включительно runtime допускает только
каноническую компанию ABC. После этой приёмки platform operator лишь получает
право включить multi-tenant flag; это не включает tenant автоматически. Второй
tenant требует все десять runtime-проверок из §8 головной спеки, зелёные P0/P1 и
sabotage tests T1–T8, provider readback и успешное ABC observe-only окно.
Production-доступ также требует T9: активной immutable pricing policy и
существующих subscription/wallet связей.

## 2. Сводная оценка

| Task | Фаза | Размер | Оценка, инженеро-дни | Зависимости | Что раздувает |
|---|---:|---:|---:|---|---|
| T1 Provider contract fixtures | 1 | S | 1–2 | — | Неопределённость реальных webhook/readback payload и SIP режима |
| T2 Durable inbound identity | 1 | L | 5–8 | T1 | Два telephony lifecycle, token bind, multi-leg, DB tenant constraints |
| T3 Provisional usage ingest | 1 | M | 3–4 | T2 | Typed breakdown, webhook duplicates, quarantine/security |
| T4 Authoritative reconcile/finalize | 1 | L | 5–7 | T3 | Delayed analysis, scheduler/retry, two-snapshot proof, late repair |
| T5 Assistant isolation + surface retirement | 2 | L | 5–8 | T2, T4 | Все входы/overrides, frontend/API removal, env fallback removal |
| T6 Outbound registry cutover | 2 | M | 3–4 | T5 | Queue uncertainty, POST timeout, old attempts compatibility |
| T7 Agency provisioning + drift | 2 | L | 6–9 | T1, T5 | Provider create/update/readback, credentials/rotation, partial repair |
| T8 Atomic concurrency + gate | 2 | L | 5–8 | T2, T5–T7 | Cross-process race, global+tenant transaction, reaper/fallback |
| T9 Pricing, settlement, tenant contract | 3 | L | 5–8 | T4, T8 | Exact NUMERIC, period/carry, wallet idempotency, data redaction |
| T10 Backfill, audit, alerts, rollout | 4 | L | 4–7 | T1–T9 | Неоднозначная история, provider drift, operational soak/runbook |
| **Итого** | | | **42–65** | | Без внешнего ожидания Vapi/Twilio и без UI-дизайна |

Оценка предполагает одного инженера, существующий тестовый PostgreSQL и доступ к
непродуктивному Vapi/Twilio fixture environment. Время ожидания provider support,
покупки линий и ручного Twilio routing не включено.

## 3. Общие правила приёмки

- Для каждой company-scoped поверхности обязательны `T-own`, `T-foreign` (404 и
  byte-for-byte unchanged), `T-blast` и все deny cells `R-matrix` из головной
  Tenancy & Roles таблицы.
- Worker/cron не получает implicit tenant: `companyId` обязателен. Webhook scope
  выводится из machine credential/resource, не из body.
- Каждый инвариант имеет реальный BREAK → red sabotage run.
- Money/constraints/idempotency проверяются на реальном disposable PostgreSQL, не
  только моками SQL.
- Каждая миграционная группа проходит forward, schema/constraint assertions,
  rollback и повторный forward. Номера назначаются только при реализации.
- Ни одна задача не считается выполненной только по happy path или mock fixture.

Общая точная команда migration verification после появления групп:
`NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiAgencyMigrations.test.js --runInBand --forceExit`.

## 4. T1 — зафиксировать provider contracts

**Цель.** Превратить неизвестные детали Vapi callbacks/readback/SIP в versioned,
sanitized fixtures и явные адаптерные контракты до проектирования записей.

**Критерии приёмки.** Зафиксированы формы `POST /call`, status update,
assistant-request (если нужен), `end-of-call-report` и `GET /call/:id`; отмечены
точные пути `call.id`, `assistantId`, timestamps, ended reason, `cost`,
`costBreakdown`, provider update/version и `subscriptionLimits`. Подтверждено,
может ли фиксированный SIP resource не вызывать assistant-request. Fixtures не
содержат секретов/PII и валидируются contract tests; неизвестные поля терпимы,
отсутствие обязательных — fail/quarantine.

**Проверка.**
`NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiAgencyProviderContracts.test.js --runInBand --forceExit`

**Зависимости:** нет. **Размер/оценка:** S, 1–2 дня. Раздувает необходимость
непродуктивных probes и различия payload по типам звонка.

## 5. T2 — durable inbound identity и correlation

**Цель.** Создать session до SIP, надёжно привязать первый доверенный Vapi call id
и поддержать несколько AI-ног на один Twilio parent.

**Критерии приёмки.** Реализованы schema/constraints из migration group
`vapi_call_identity_and_usage`; flow runtime создаёт tenant-bound session/token;
status/assistant callback выполняет одноразовый credential+token+resource+
assistant bind; duplicate идемпотентен, конфликт quarantined; Twilio callback не
может подменить identity; `vapi_call_id` глобально уникален для единственной
платформенной организации и не зависит от tenant `provider_org_id`; EoC repair
только при единственном точном match. ABC
входящий happy path сохраняет Vapi id. Все T-own/T-foreign/T-blast/R-matrix и
multi-leg cases зелёные.

**Проверка.**
`NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiCallIdentity.test.js tests/vapiCallStatusWebhook.test.js tests/services/callFlowRuntime.vapi.test.js --runInBand --forceExit`

**Зависимости:** T1. **Размер/оценка:** L, 5–8 дней. Раздувают совместная
Twilio/Vapi гонка, durable token lifecycle, historical call creation и реальные
DB constraints.

## 6. T3 — provisional supplier usage ledger

**Цель.** Принимать EoC как неденежное append-only observation и поддерживать
типизированный current usage snapshot вне `calls`.

**Критерии приёмки.** EoC аутентифицирован отдельным status credential, найден по
company+session identity, идемпотентен при дубле/перестановке и сохраняет exact
NUMERIC supplier cost, typed breakdown/tokens/analysis evidence, times и reason.
Malformed/negative/mismatched payload quarantined. `calls.price` и
`duration_sec` не переиспользованы. Ни EoC, ни duplicate не создаёт charge/debit.

**Проверка.**
`unset NODE_USE_SYSTEM_CA; DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiUsageIngest.test.js tests/vapiUsageIngestMigration.test.js tests/vapiAgencyProviderContracts.test.js tests/vapiCallStatusWebhook.test.js tests/outboundLeadCallWebhook.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"`

**Зависимости:** T2. **Размер/оценка:** M, 3–4 дня. Раздувают schema evolution
breakdown и безопасная идемпотентность webhook без стабильного event id.

## 7. T4 — reconcile, finalization и repair

**Цель.** Досводить дозревающий analysis cost через авторитетный `GET /call/:id`,
не списывая неполные данные.

**Критерии приёмки.** Scheduler перечисляет due companies, worker требует
`companyId`; retry с jitter переживает 429/5xx/timeouts; разные snapshots сбрасывают
stability, два разнесённых совпадающих дают `final`; 24 часа дают
`stale_pending`+alert без charge; audit после final создаёт новую version/delta
input, не rewrite. Crash/retry и concurrent workers сохраняют ровно одно
observation/state transition. Есть lag/stale/quarantine metrics.

**Проверка.**
`NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiUsageReconcile.test.js tests/vapiUsageAuditRepair.test.js --runInBand --forceExit`

**Зависимости:** T3. **Размер/оценка:** L, 5–7 дней. Раздувают scheduler locking,
provider rate limits и корректировка после прежней финализации.

## 8. T5 — assistant boundary и удаление tenant-facing Vapi

**Статус:** реализовано в T5; production deployment/readback остаются
owner-controlled и в этой задаче не выполнялись.

**Цель.** Сделать registry/resource/credential единственным путём выбора
ассистента и удалить старую tenant-org/BYO-key поверхность.

**Критерии приёмки.** `(company,purpose,environment)` unique и fail-closed;
assistant/resource cross-company связь запрещена DB+service; все внешние
`assistantId`/`assistantOverrides`/model/voice/tools/server/destination поля
игнорируются с reject, не merge. Удалены org provisioner/script/test, tenant Vapi
settings/API/routes, provider connection client key и два global assistant env
fallback после ABC cutover. Deployment env используется только явным
company-scoped operational bootstrap CLI, не migration/runtime selection.
Защищённый route mount снимается
отдельным `src/server.js` patch; до него пустой router возвращает 404 без DB.
Tenant supplier/provider serialization ratchet зелёный.

**Проверка.**
Schema apply (data-neutral):
`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/db/migrations/275_vapi_assistant_registry.sql`

Owner-controlled operational step после schema apply (сначала dry-run):
`node backend/scripts/bootstrap-vapi-assistant-registry.js --company-id <uuid>`
`node backend/scripts/bootstrap-vapi-assistant-registry.js --company-id <uuid> --apply`

`NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiAssistantRegistry.test.js tests/routes/vapi-tools.test.js tests/routes/vapiTenantIsolation.test.js tests/services/callFlowRuntime.vapi.test.js --runInBand --forceExit`
`npm --prefix frontend run build`
`npm --prefix frontend test`
`grep -R -n -E 'vapiOrgProvisioningService|provision-vapi-tenant|VAPI_LEAD_CALL_ASSISTANT_ID|VAPI_OUTBOUND_ASSISTANT_ID' backend/src frontend/src --exclude-dir=node_modules` → ожидается отсутствие runtime hits; operational bootstrap/docs/tests могут называть deployment env.

**Зависимости:** T2, T4. **Размер/оценка:** L, 5–8 дней. Раздувают количество
старых путей и необходимость staged ABC cutover без сохранения опасного fallback.

## 9. T6 — outbound registry и неопределённый POST

**Цель.** Перевести оба outbound пути на company registry/session и не создавать
дубли при сетевой неопределённости.

**Критерии приёмки.** Session существует до `POST /call`; assistant выбирается
по company/purpose/env profile, caller — по company outbound resource; runtime
assistant/phone env и lead→parts fallback отсутствуют. Payload построен только
из registry/template; response id атомарно bind-ится к session и attempt. Gate/
limit оставляет queued без provider call/attempt increment. Timeout после send
переходит в repairable `provider_pending`, повторный POST заблокирован; audit
repair использует только server-owned call metadata session UUID + pinned
assistant. `subscriptionLimits` сохраняется как telemetry и не допускает call.
Cancellation
и callbacks сохраняют tenant predicates. Старые attempts читаются до завершения
backfill, но не становятся альтернативной identity.

**Проверка.**
`node backend/scripts/bootstrap-vapi-outbound-resource.js --company-id <uuid>`
`node backend/scripts/bootstrap-vapi-outbound-resource.js --company-id <uuid> --apply`
`unset NODE_USE_SYSTEM_CA; DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/outboundCallService.test.js tests/outboundCallWorker.test.js tests/outboundLeadCallWorker.test.js tests/outboundLeadCallWebhook.test.js tests/outboundCancelTenantIsolation.test.js tests/vapiAssistantRegistry.test.js tests/vapiOutboundBootstrap.test.js tests/vapiOutboundIdentity.test.js tests/vapiProviderClient.test.js tests/vapiUsageAuditRepair.test.js tests/vapiCallStatusWebhook.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"`

**Зависимости:** T5. **Размер/оценка:** M, 3–4 дня. Раздувают два outbound
семейства и отсутствие безопасного retry после ambiguous network timeout.

## 10. T7 — agency provisioning, credentials и drift

**Цель.** Идемпотентно создать assistant + per-company SIP resource + отдельные
machine credentials из server-owned template и доказать provider readback.

**Критерии приёмки.** Реализован dry-run-by-default
`provision-vapi-agency-company.js` с обязательным `--company-id`: он создаёт три
assistant из versioned server templates, три разные company-bound hash-at-rest
credentials и один dynamic SIP resource. После create выполняются PATCH + GET и
canonical secret-free readback; write-only assistant server secret проверяется
только флагом, tool secrets — значением без логирования. Durable state сохраняет
частичный provider id до registry upsert, повтор находит объект по operation
metadata/SIP URI и не дублирует. Tenant input ограничен greeting; company name
берётся из БД, prompt/model/URLs/ids запрещены. Финальный registry/resource
upsert и credential rotation атомарны локально; состояние становится `ready`,
но не `enabled`. `/org` отсутствует.

**Проверка.**
`unset NODE_USE_SYSTEM_CA; DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiAgencyProvisioning.test.js tests/vapiAgencyProviderClient.test.js tests/vapiAssistantRegistry.test.js tests/vapiAssistantRegistryBootstrap.test.js tests/machineCredentialService.test.js tests/routes/vapi-tools.test.js tests/vapiCallStatusWebhook.test.js tests/vapiAssistantRequest.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"`

Migration transport: `/usr/local/Cellar/postgresql@15/15.15_1/bin/psql postgresql://localhost/albusto_test -v ON_ERROR_STOP=1 -f backend/db/migrations/278_vapi_agency_provisioning_state.sql` ×2.

Результат: T7 targeted 2 suites / 13 tests, acceptance 8 suites / 156 tests,
функциональная регрессия T1–T7 24 suites / 355 tests; migration transport ×2 PASS.

Sabotage: разрешить неизвестную tenant variable → `SAB-T7-ALLOWLIST` RED;
отключить discovery по operation metadata → `SAB-T7-IDEMPOTENCE` и
lost-response repair RED. После восстановления targeted suites green.

**Зависимости:** T1, T5. **Размер/оценка:** L, 6–9 дней. Раздувают provider API
семантика, rollback частичных объектов и ротация нескольких webhook credentials.

## 11. T8 — atomic leases и реальный Phase 2 gate

**Цель.** Не дать одному tenant съесть общий пул и физически закрыть второго
tenant до завершения Phase 2.

**Критерии приёмки.** Одна DB admission operation под параллельной нагрузкой не
превышает global/company cap; lease создаётся до provider, активируется/binds,
освобождается идемпотентно, reaper не освобождает живой call и очищает orphan.
`subscriptionLimits` лишь telemetry. Inbound deny идёт ровно в configured
fallback, outbound остаётся queued без POST. Общая gate function проверяет все 10
условий §8 на каждом пути. Без multi-tenant flag или любого readiness evidence
non-ABC закрыт. Sabotage доказывает, что gate/admission не декоративны.

**Проверка.**
`NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiConcurrencyLeases.test.js tests/vapiAgencyGate.test.js tests/services/callFlowRuntime.vapi.test.js tests/outboundCallWorker.test.js tests/outboundLeadCallWorker.test.js --runInBand --forceExit`

**Зависимости:** T2, T5, T6, T7. **Размер/оценка:** L, 5–8 дней. Раздувают
cross-process races, global+tenant atomicity и безопасная классификация orphan.

## 12. T9 — cost-plus pricing, settlement и data contracts

**Цель.** Из final supplier snapshot получить immutable exact charge, один debit
существующего wallet и минимальную tenant projection.

**Критерии приёмки.** Pricing versions immutable/effective-dated; multiplier
фиксируется в charge; все money calculations в DB NUMERIC/string boundary;
failed/voicemail/no-answer с cost биллятся; per-call rounding отсутствует;
subscription-period settlement округляет один раз и переносит carry. Duplicate/
crash даёт один wallet debit; поздняя correction создаёт adjustment/reversal.
Auto-recharge переиспользован, Connect untouched. Tenant endpoint показывает
только calls/minutes/amount; recursive forbidden-key test исключает
provider/supplier fields. MCP вызывает тот же aggregate service.

**Проверка.**
`NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiUsagePricing.test.js tests/vapiUsageSettlement.test.js tests/vapiVoiceUsageRoutes.test.js tests/billingPaygSubscribe.test.js tests/vapiFinanceContextRoute.test.js --runInBand --forceExit`

**Зависимости:** T4, T8. **Размер/оценка:** L, 5–8 дней. Раздувают денежная
exactly-once граница, carry/period edge cases и существующие wallet semantics.

## 13. T10 — backfill, audit, alerts и controlled rollout

**Цель.** Перевести ABC, доказать полноту учёта и подготовить безопасный второй
tenant без догадок по неоднозначной истории.

**Критерии приёмки.** ABC assistant/resource/credentials readback зелёные;
однозначные outbound Vapi ids backfilled, неоднозначные вынесены в exception
report без charge. Сверены Vapi calls ↔ sessions ↔ final usage ↔ charges ↔
settlements/wallet; настроены alerts §14; runbook покрывает enable/suspend,
credential rotation, drift, stale pending, lease leak, provider outage,
reconcile repair и line purchase. Observe-only окно не имеет unexplained calls.
Второй tenant проходит весь checklist и canary rollback.

**Проверка.**
`NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiAgencyBackfill.test.js tests/vapiAgencyAudit.test.js tests/vapiAgencyGate.test.js --runInBand --forceExit`
`NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --forceExit`

Provider readback/soak выполняются только по отдельному rollout change ticket, не
из CI и не на проде в разработческом турне.

**Зависимости:** T1–T9. **Размер/оценка:** L, 4–7 дней. Раздувают качество
исторической корреляции, полнота provider exports и длительность observe-only.

## 14. Планируемые миграционные группы (имена без номеров)

Миграции в этом турне не создаются и номера не резервируются. При реализации у
каждой forward migration должен быть matching rollback.

### `vapi_call_identity_and_usage`

Содержит `vapi_call_sessions`, `vapi_call_usage_observations`,
`vapi_call_usage`; FK/unique/check constraints; company-qualified indexes;
correlation token hash/TTL; exact NUMERIC costs; reconcile/finality fields;
безопасный однозначный backfill известных outbound ids. Rollback удаляет новые
projections после preflight отсутствия непроецированных денежных данных и не
трогает legacy `calls`/attempt rows.

### `vapi_provisional_usage_ingest`

Добавляет к observation company-bound status credential, provider call/assistant
shape и allowlisted sanitized payload; к current usage — ссылку на append-only
provisional observation. Не создаёт charge/settlement/wallet таблиц и блокирует
rollback после появления evidence.

### `vapi_provider_message_quarantine`

Содержит company/credential-scoped allowlisted evidence и delivery counter для
аутентифицированных provider messages, отвергнутых до появления session-bound
observation; расширяет platform-only alert kinds. Не хранит transcript,
recording, customer/name/phone, secret или tenant-visible payload и блокирует
rollback после появления quarantine evidence.

### `vapi_assistant_registry`

Содержит только schema: `vapi_tenant_voice_configs`; расширяет
`vapi_assistant_profiles` и `vapi_tenant_resources`
template/readback/resource/credential полями; добавляет same-company ownership
constraints и active tuple uniqueness. Не читает env/provider data, не требует
connection/resource/credentials и не пишет ни одной строки. ABC наполняется
отдельным dry-run-by-default `bootstrap-vapi-assistant-registry.js`; CLI связывает
ровно один active credential каждой surface либо оставляет nullable binding +
readiness false, очищает legacy provider data и идемпотентно upsert-ит registry.

### `retire_tenant_vapi_marketplace_app`

После всех replayed Marketplace seeds переводит legacy provider app в
`disabled` и обновляет обязательный `metadata.assistant`. Tenant catalog и
installation lookup больше не открывают эту поверхность. Matching rollback
републикует только catalog row и не восстанавливает удалённые
routes/UI/credentials.

### `vapi_outbound_registry_sessions`

Расширяет platform-only resources типами registered Vapi caller и transient
Twilio caller, добавляет global active caller uniqueness и same-company
session→profile/resource FK. В session сохраняет только diagnostic
`subscriptionLimits`/placement clock, в audit run — число восстановленных
outbound identities. Миграция data-neutral: caller resources создаются только
dry-run-by-default `bootstrap-vapi-outbound-resource.js` с обязательным
`--company-id`.

### `vapi_agency_provisioning_state`

Добавляет только durable provisioning state machine и secret-free resource
readback columns. Не создаёт companies/connections/profiles/resources/credentials,
не читает env и не обращается к provider. Операционные данные создаёт отдельный
dry-run-by-default `provision-vapi-agency-company.js`; matching rollback удаляет
только новую таблицу и три readback columns.

### `vapi_concurrency_leases`

Содержит `vapi_concurrency_leases`, positive company/global policy constraints,
company/session indexes, уникальный live lease и поля reaper/telemetry. Database
admission function/locking contract входит в ту же группу, чтобы нельзя было
развернуть таблицу без атомарной операции.

### `vapi_usage_charges`

Содержит immutable `vapi_pricing_policies`, `vapi_usage_charges`,
`vapi_settlements`; NUMERIC checks, non-overlapping/effective policy rules,
snapshot/version/idempotency uniqueness, subscription-period keys, rounding
carry, добавляет `vapi_tenant_voice_configs.pricing_policy_id` + FK и FK к
существующим subscription/wallet ledger entries. Не создаёт новый
balance и не меняет Stripe Connect semantics.

## 15. Delivery checkpoints

- После T4: ABC measurement-only demo — inbound/outbound provider id, EoC,
  reconcile/final/stale; никаких начислений.
- После T8: security/capacity review — gate checklist, tenant matrix, sabotage,
  2× parallel-cap stress, provisioning/readback. Это обязательный второй-tenant
  technical gate.
- После T9: money review — golden NUMERIC vectors, failed-call matrix,
  period/carry, crash/retry wallet debit и tenant forbidden-field contract.
- После T10: owner-controlled rollout ticket; enable не является автоматическим
  следствием deploy.
