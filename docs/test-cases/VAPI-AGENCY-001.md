# VAPI-AGENCY-001 — test cases

Статус: draft test plan; результаты PENDING
Дата: 2026-08-16
Спека: `docs/specs/VAPI-AGENCY-001.md`
Delivery plan: `docs/specs/VAPI-AGENCY-001-TASKS.md`

## 1. Приоритеты и обозначения

| Приоритет | Смысл |
|---|---|
| P0 | Может смешать tenants, неверно списать деньги, обойти gate/cap или потерять identity |
| P1 | Может потерять supplier cost, вызвать provider duplicate, сломать provisioning/recovery |
| P2 | Нарушает tenant contract, audit/observability/backfill или operational control |
| P3 | Совместимость, diagnostics, масштаб/ручной provider сценарий |

Обозначения:

- A — каноническая компания ABC; B — второй tenant; F — foreign company;
- один и тот же natural/provider-looking key намеренно может существовать в A и B;
- `unchanged` означает byte-for-byte сравнение целевых строк, charge, settlement и
  wallet balance до/после запроса;
- money assertions сравнивают decimal strings/PostgreSQL NUMERIC, не binary float;
- каждый DB case выполняется на disposable PostgreSQL с forward migrations.

## 2. Identity, tenancy и webhook security

| ID | P | Предусловие/действие | Ожидаемый результат | Автотест / sabotage |
|---|---:|---|---|---|
| ID-01 | P0 | Inbound A flow входит в Vapi node | Session/reservation и token созданы до SIP; company/purpose/env/resource зафиксированы; `vapi_call_id` пока null. Capacity lease добавляется в T8 | `vapiCallIdentity`: inbound create |
| ID-02 | P0 | `assistant-request` имеет credential A, valid token и `message.call.id=C1` | Session A атомарно bind к C1 до ответа `{assistantId}`; token больше не переиспользуем | `vapiCallIdentity` + `vapiAssistantRequest`: bind |
| ID-03 | P0 | После bind C1 деактивировать/изменить profile и повторить точный callback C1 | 2xx/idempotent до drift-проверок; session byte-unchanged; новых rows/lease нет | duplicate-after-drift bind sabotage |
| ID-04 | P0 | После bind C1 прислать C2 с тем же token | Reject/quarantine+alert; C1 не изменён | `SAB-VAPI-IDENTITY-TENANT` suite |
| ID-05 | P0 | Credential B + token/session A, body утверждает company B/A | Reject; A и B unchanged | wrong credential T-foreign |
| ID-06 | P0 | Resource A, assistant B либо наоборот | Reject до routing/bind; provider call/tenant rows unchanged | registry cross-owner constraint |
| ID-07 | P0 | A и B имеют одинаковые Twilio parent/child-like keys | Lookup с явным company выбирает только свою строку | T-blast natural key |
| ID-08 | P0 | Один Twilio parent A проходит две AI-ноги C1/C2 | Две sessions, два provider ids, общий parent; ни одна не перезаписана | multi-leg identity |
| ID-09 | P0 | Twilio child status приходит раньше/после Vapi callback | `answered_by='ai'` может обновиться, но Vapi id не создаётся из Twilio evidence | timeline permutation |
| ID-10 | P0 | EoC приходит до успешного `assistant-request` bind | Никакого поиска по Twilio SID/company/body/assistant; T3 сохраняет raw evidence только после подтверждения живой формы и применяет тот же exact token/session contract | EoC raw-capture case T3 |
| ID-11 | P0 | `assistant-request` без token либо с двумя различными token values | Reject; handler не возвращает assistant; эвристического bind нет | assistant-request token fail-closed |
| ID-12 | P0 | Outbound worker A создаёт call | Session/lease существуют до POST; response id атомарно в session и attempt | outbound identity |
| ID-13 | P1 | POST мог уйти, ответ timeout | Session `provider_pending`; job не делает второй POST до repair | ambiguous POST test |
| ID-14 | P0 | В request/tool/public payload переданы `assistantId`, `assistantOverrides`, model, voice, tools, destination, server URL/credential | Поля rejected; provider payload содержит только server-owned template | `SAB-VAPI-OVERRIDE` |
| ID-15 | P0 | Tool webhook A пытается обратиться к entity F | 404; A/F entities and audit unchanged | tools T-foreign/R-matrix |
| ID-16 | P0 | Tenant JWT используется на machine webhook либо status credential на tools surface | Deny; surface credentials не взаимозаменяемы | `SAB-VAPI-WEBHOOK-CREDENTIAL` |
| ID-17 | P0 | Reconcile worker вызван без company либо с company B для session A | Fail closed; usage A unchanged; no provider read attributed to B | worker explicit-company |
| ID-18 | P0 | A имеет пустой `provider_org_id`, B заполненный; обе пытаются bind одного `vapi_call_id` | Вторая bind quarantined; DB global unique не допускает второй row при любом `provider_account_key` | global provider-call identity sabotage |
| ID-19 | P1 | Flow повторно входит в тот же node, пока первая unbound reservation/token ещё действуют | Fail closed без новой reservation; исходная session/token byte-unchanged; после TTL возможна замена | reservation-in-flight retry |
| ID-20 | P1 | Retention удаляет `call_flow_executions` после создания session | Session переживает удаление; `flow_execution_id` становится null, provider identity сохраняется | flow-execution `ON DELETE SET NULL` |

## 3. Gate, assistant registry, provisioning и лимиты

| ID | P | Предусловие/действие | Ожидаемый результат | Автотест / sabotage |
|---|---:|---|---|---|
| GATE-01 | P0 | До T1–T8/multi-tenant flag B входит в inbound Vapi node | Vapi SIP не выдаётся; configured ordinary/voicemail fallback; lease нет | `SAB-VAPI-GATE` |
| GATE-02 | P0 | В том же состоянии outbound B queued | Нет POST, provider attempt increment и lease; job queued с retry reason | `SAB-VAPI-GATE` |
| GATE-03 | P0 | B `enabled`, но отсутствует любое одно из 10 evidence conditions | Каждый вариант отдельно fail closed на inbound/outbound | readiness mutation matrix |
| GATE-04 | P0 | B удовлетворяет условиям, T1–T8 accepted, flag on | Вход/выход допускается только для B registry tuple | positive gate |
| GATE-05 | P0 | После допуска выключить flag или поставить `suspended` | Новые B calls закрыты; активная session корректно завершается по policy | kill switch |
| REG-01 | P0 | Попытка двух active profiles на `(A,purpose,env)` | DB unique violation/transaction rollback | registry constraint |
| REG-02 | P0 | Profile/resource company mismatch через service и прямой DB fixture | Service deny; DB constraint/FK deny | assistant tenant sabotage |
| REG-03 | P1 | Provision apply дважды после успеха | Один provider assistant/resource set; один active registry tuple | provisioning idempotency |
| REG-04 | P1 | Crash после assistant create до resource/readback, затем retry | Repair reuses/reconciles assistant; no duplicate; state не enabled до readback | partial provisioning |
| REG-05 | P0 | Provider readback assistant/tools/SIP отличается hash | `drifted`, gate deny, alert; tenant не может override | drift test |
| REG-06 | P0 | Tools и call-status credentials одинаковы/expired/revoked | Readiness deny; callbacks deny according to credential state | credential separation |
| REG-07 | P2 | Provision/dry-run logging | Ни platform key, ни webhook secret/token не встречается в output/log | secret ratchet |
| REG-08 | P0 | Operational bootstrap CLI получает `--company-id`, existing connection/resource и три assistant env ids | Dry-run не пишет; apply создаёт ровно три active `(company,purpose,prod)` profile и связывает inbound resource; повтор no-op. Отсутствующий/невалидный/conflicting input отклоняет CLI, не schema migration | `vapiAssistantRegistryBootstrap`, `vapiAssistantRegistryMigration` |
| REG-09 | P0 | Assistant id A повторно вставляется для B при разных/пустых `provider_org_id` | Global unique violation; provider namespace нельзя фрагментировать per-company полем | registry migration collision |
| REG-10 | P0 | Tenant node передаёт foreign `sip_uri`, profile/resource/assistant id, purpose/env и overrides | Reservation получает hardcoded product purpose/env; wire SIP только из exact company registry. Legacy-canary fallback также читает только company/inbound/prod resource | `SAB-VAPI-NODE-SIP` |
| CAP-01 | P0 | N параллельных admissions A при cap K | Ровно K leases admitted, остальные fallback/queued; никогда K+1 | `SAB-VAPI-CONCURRENCY` |
| CAP-02 | P0 | A и B одновременно упираются в global cap G | Всего admitted ≤ G и каждый ≤ tenant cap; нет starvation bypass | global+tenant stress |
| CAP-03 | P0 | Outbound denied by cap | Остаётся queued; POST spy = 0; attempt count unchanged | outbound cap behavior |
| CAP-04 | P0 | Inbound denied by cap | Ровно fallback branch; SIP destination не сгенерирован | inbound cap behavior |
| CAP-05 | P1 | Provider create error/known no-call | Lease освобождён один раз; повтор release idempotent | lease error path |
| CAP-06 | P1 | Worker dies с reserved lease; TTL истёк, provider call отсутствует | Reaper помечает expired и восстанавливает capacity | `SAB-VAPI-LEASE-RECOVERY` |
| CAP-07 | P0 | Lease выглядит истёкшим, но provider/session heartbeat подтверждает active | Reaper не освобождает; cap не превышается новым admission | live-call reaper race |
| CAP-08 | P2 | Vapi response `subscriptionLimits` расходится с local count | Local admission не меняется; platform metric/alert фиксирует divergence | telemetry-only test |

## 4. Денежные P0/P1 кейсы

Эта секция является обязательной risk-to-test матрицей. Во всех кейсах Connect
ledger и tenant/customer application fees проверяются как unchanged.

| ID | P | Риск/сценарий | Шаги | Ожидаемый денежный результат | Sabotage |
|---|---:|---|---|---|---|
| MONEY-01 | P0 | Поздний analysis cost | EoC cost 0.10; GET#1 0.12; GET#2 0.15; GET#3/4 0.15 | Не final до #4; один usage charge от 0.15 × pinned markup | `SAB-VAPI-LATE-COST` |
| MONEY-02 | P0 | Дубли EoC | Один payload отправить 2× последовательно и конкурентно | Одно accepted observation/effective provisional; charge/debit 0 | `SAB-VAPI-COST-IDEMPOTENCY` |
| MONEY-03 | P0 | Дубли authoritative poll/workers | Два worker одновременно сохраняют тот же GET | Не считаются двумя временно разнесёнными measurements; один state transition | idempotency sabotage |
| MONEY-04 | P0 | Breakdown double count | `cost=0.10`, `costBreakdown.total=0.10`, components sum=0.10 | Supplier basis 0.10, не 0.20/0.30 | money fixture |
| MONEY-05 | P0 | Несогласованный breakdown | `cost=0.10`, total=0.11 за согласованным tolerance | Quarantine/alert; charge и wallet debit отсутствуют | validation sabotage |
| MONEY-06 | P0 | NUMERIC против float | Golden decimals `0.1`, `0.2`, high precision multiplier, много строк | DB exact expected string; нет IEEE drift | `SAB-VAPI-MONEY-MATH` |
| MONEY-07 | P0 | Округление по звонку | Три calls по exact retail `0.004` | Сумма `0.012` округляется settlement до 1 cent (с carry policy), не 0/3 cents | per-call-round sabotage |
| MONEY-08 | P0 | Остаток округления | Два последовательных settlement с дробным cent carry | `carry_out(n)=carry_in(n+1)`; cumulative wallet cents + carry = exact total | settlement carry |
| MONEY-09 | P0 | Duplicate settlement/crash | Crash после wallet entry до settlement posted, затем retry | Один wallet debit с тем же idempotency key; один linked settlement | `SAB-VAPI-SETTLEMENT-DUP` |
| MONEY-10 | P0 | Несколько AI-ног на Twilio call | Parent P имеет sessions C1 cost .10 и C2 cost .20 | Два charges, supplier .30; tenant call-count contract использует явно утверждённое определение AI-ног/звонков | multi-leg money |
| MONEY-11 | P0 | Twilio price перепутан с Vapi | `calls.price=9.99`, final Vapi cost=.10 | Vapi charge только .10×markup; Twilio field unchanged | source separation |
| MONEY-12 | P0 | Граница периода | Session началась до period end, закончилась/финализировалась после; соседняя наоборот | Charge закрепляется по утверждённому call-time rule; settlement ровно одного subscription period; повтор не переносит | period boundary |
| MONEY-13 | P0 | Смена markup | Call C1 под v1, затем publish v2, call C2 | C1 charge сохраняет v1; C2 использует v2; historical rows unchanged | immutable policy |
| MONEY-14 | P0 | Final изменился после settlement | Audit меняет cost .10→.12 | Старые usage/charge/wallet immutable; adjustment exact +.02×pinned/applicable correction policy, следующий settlement | `SAB-VAPI-FINALITY` |
| MONEY-15 | P0 | Cost уменьшился после settlement | Audit меняет .12→.10 | Immutable negative adjustment/reversal; идемпотентный credit в settlement | finality sabotage |
| MONEY-16 | P0 | 24h без двух совпадений | EoC/GET меняются или provider недоступен до deadline | `stale_pending`+alert; charge/settlement/wallet отсутствуют | stale-no-charge |
| MONEY-17 | P0 | Failed/voicemail/no-answer | Для каждой ended group final positive cost | Каждая биллится cost-plus; reason metric сохраняется | ended matrix parameterized |
| MONEY-18 | P0 | Zero cost | Каждая ended group final exact zero | Usage/audit есть, wallet debit нет | zero matrix |
| MONEY-19 | P0 | Cancel до POST/identity | Outbound снят из очереди до provider call | Ни usage, ни charge; queue/attempt semantics корректны | pre-provider cancel |
| MONEY-20 | P0 | Unknown ended reason + positive cost | Provider вводит новый reason, final стабилен | Cost-plus charge + classifier alert, не бесплатный звонок | unknown reason |
| MONEY-21 | P0 | Tenant collision | A/B имеют одинаковые period/provider-like keys и settlements одновременно | Каждый wallet получает только свои charges; foreign balances unchanged | T-blast money |
| MONEY-22 | P0 | Pricing worker без company | Вызвать job с missing/mismatched scope | Fail closed; все charges/wallet unchanged | explicit-company sabotage |
| MONEY-23 | P0 | Connect смешан с usage | Создать tenant customer payment параллельно settlement | Usage идёт только prepaid wallet; Connect/app fee rows unchanged и наоборот | `SAB-VAPI-CONNECT-SEPARATION` |
| MONEY-24 | P1 | Auto-recharge | Wallet недостаточен при settlement | Используется существующий auto-recharge protocol; после success один debit; failure остаётся retryable без duplicate | wallet integration |
| MONEY-25 | P1 | Provider API outage/recovery | GET даёт 429/5xx/timeouts, затем два stable snapshots | Backoff; no guessed charge; после recovery ровно один final/charge | reconcile resilience |
| MONEY-26 | P0 | Malformed/negative/NaN-like cost | По одному invalid fixture | Quarantine; никакого numeric coercion, final или debit | validation matrix |

Для `MONEY-10` продуктовый API считает `calls` как количество тарифицируемых
AI-ног, потому что это единица supplier cost; UI может позже переименовать метрику.
Если тимлид выберет unique Twilio conversations, API обязан отдать обе метрики
явно, не молча дедуплицировать денежные строки.

## 5. Reconcile, lifecycle и observability

| ID | P | Действие | Ожидаемый результат |
|---|---:|---|---|
| REC-01 | P1 | EoC отсутствует, но ended session имеет Vapi id | Reconcile GET всё равно создаёт observations и может финализировать |
| REC-02 | P1 | EoC приходит после final | Duplicate/same evidence без rewrite; changed evidence запускает audit version path |
| REC-03 | P1 | Два одинаковых GET в одном invocation | `stable_count` не достигает 2 |
| REC-04 | P1 | Два одинаковых GET с минимальным интервалом | `stable_once -> final`, timestamps/version заполнены |
| REC-05 | P1 | Между совпадениями изменился provider `updatedAt` без cost | Hash contract применён последовательно; stability сбрасывается, если snapshot material changed |
| REC-06 | P1 | 100 due rows A/B, один provider failure | Company jobs изолированы; один failure не откатывает успешные tenants; no unscoped update |
| INGEST-01 | P0 | Один EoC доставлен дважды последовательно/конкурентно | Один append-only observation и один provisional usage; wallet unchanged | `SAB-VAPI-EOC-IDEMPOTENCY` |
| INGEST-02 | P0 | Status credential B присылает call id строки A либо unknown id | Ни session, ни observation, ни usage не создаются; A/B/wallet unchanged | `SAB-VAPI-EOC-COMPANY` |
| INGEST-03 | P0 | EoC несёт transcript/recording/customer/name/phone и документированный cost | Persisted sanitized payload содержит только identity/lifecycle/cost decimal strings | sanitized-evidence ratchet |
| INGEST-04 | P0 | Cost находится не в подтверждённом `message.call` | Quarantined observation сохраняет безопасную форму placement; provisional supplier cost отсутствует | fail-closed placement fixture |
| INGEST-05 | P0 | Outbound EoC при пустом assistant registry до T5 | Attempt из credential-scoped local row создаёт session/observation/usage; assistant env drift только structured warning; wallet unchanged | `SAB-VAPI-OUTBOUND-REGISTRY-FALLBACK` |
| INGEST-06 | P0 | Identity contract отвергает новое `call.type`/`status` | Одна idempotent quarantine row с sanitized payload + alert; никаких usage/wallet rows | provider-enum quarantine matrix |
| INGEST-07 | P0 | Usage ingest отвергает EoC связанной outbound attempt | Timeline/FSM независимо финализируют attempt и планируют retry; денежный отказ остаётся отдельным alert | `SAB-VAPI-FSM-INDEPENDENCE` |
| INGEST-08 | P1 | Analysis prompt и cached prompt tokens ненулевые | Cached subset не прибавляется к prompt/total повторно | cached-token fixture |
| REC-07 | P1 | Планировщик отсутствовал один или несколько UTC-дней | Oldest missing day внутри bounded lookback claim-ится первым; вчера отмечается complete только после catch-up | missed-day audit fixture |
| OBS-01 | P2 | Создать unbound call, stale usage, drift, lease divergence и settlement retry | Каждому соответствует named metric/alert с company/session refs platform-only |
| OBS-02 | P0 | Просканировать tenant response/log fixture | Нет secret/token/transcript/provider/supplier fields в tenant-visible output |
| OBS-03 | P2 | Сверить provider export и local audit | Missing/extra/changed calls перечислены; repair требует exact identity, не auto-charge ambiguity |

## 6. Tenant API, roles и MCP parity

| ID | P | Действие | Ожидаемый результат |
|---|---:|---|---|
| API-01 | P0 | Tenant admin A читает свой settled период | 200; только period, calls, minutes, amount и daily decimal strings |
| API-02 | P0 | A передаёт company B в query/body/path | Игнор/deny по contract; scope только `req.companyFilter.company_id`; B данные отсутствуют |
| API-03 | P0 | Foreign entity/id используется в деталях, если они появятся | 404; rows/ledger/wallet unchanged |
| API-04 | P0 | manager/dispatcher/provider/custom без permission обращаются к usage | Каждая R-matrix deny cell получает 403; no data |
| API-05 | P0 | custom role с `tenant.company.manage` | Разрешён только собственный aggregate |
| API-06 | P0 | Recursive scan tenant JSON для forbidden keys/values | Нет Vapi/org/assistant/provider/supplier/markup/breakdown/token identifiers |
| API-07 | P1 | Есть provisional/stale calls | Они не входят в finalized calls/minutes/amount и не раскрываются отдельными supplier полями |
| API-08 | P1 | Period timezone/boundary fixtures | Ровно subscription boundaries, стабильные daily totals |
| MCP-01 | P0 | HTTP и MCP вызываются для A на одном fixture | Семантически одинаковые allowlisted totals и permission |
| MCP-02 | P0 | MCP A пытается запросить B/provider detail | Deny/no field; B unchanged |
| MCP-03 | P0 | Временно заменить MCP на отдельный unscoped query | MCP parity/T-blast test краснеет (`SAB-VAPI-MCP-PARITY`) |

## 7. Backfill, retirement и совместимость

| ID | P | Действие | Ожидаемый результат |
|---|---:|---|---|
| MIG-01 | P1 | Forward каждой migration group на pre-feature fixture | Constraints/indexes/backfill совпадают spec; existing calls/billing preserved |
| MIG-02 | P1 | Rollback и повторный forward | Schema/data contract восстановим согласно approved rollout stage; без silent money loss |
| MIG-03 | P0 | Два legacy attempts дают неоднозначный Vapi/company match | Exception report; ни session bind, ни charge не выдуман |
| MIG-04 | P1 | Однозначный ABC outbound attempt | Session/provider identity backfilled ровно один раз |
| MIG-05 | P0 | Fresh environment без Vapi rows и без session settings | Schema-only migration 275 в настоящем autocommit проходит дважды и создаёт 0 data rows; runtime selector закрыт |
| MIG-06 | P0 | Prod-like legacy connection/resource/credentials | Migration 275 проходит дважды и не меняет данные; CLI dry-run byte-unchanged, apply связывает profiles/resource/credentials, повтор idempotent; inbound reservation доступна |
| RET-01 | P0 | Source/import/route scan после T5 | Нет org provisioner/script, tenant key API/settings и runtime global assistant env fallback; env ids допустимы только в operational bootstrap/docs/tests |
| RET-02 | P0 | Попытка вызвать старый tenant `/api/vapi` route | 404/410 по rollout contract; provider state unchanged; ключ не принимается |
| RET-03 | P1 | Existing ABC call после cutover | Идёт только registry path; legacy fallback spy не вызывается |
| RET-04 | P1 | ABC `legacy_canary` reservation временно недоступна | Сохранённый incident fallback набирает только exact company/inbound/prod SIP без token; для обычного/non-ABC rollout тот же путь закрыт | `callFlowRuntime.vapi` hotfix regression |
| RET-05 | P0 | Старый Marketplace seed проигрывается при boot | Финальный retirement seed снова ставит legacy provider app `disabled`; tenant catalog/installations/direct management его не выдают | registry migration + marketplace query tests |
| ROLL-01 | P0 | Checklist второго tenant имеет один failed item | Enable transaction abort; tenant остаётся ready/provisioning, runtime closed |
| ROLL-02 | P1 | Полный checklist + canary, затем suspend | Сначала controlled calls; после suspend новые закрыты/fallback, audit actor/time сохранены |

## 8. P3/manual provider cases

| ID | Действие | Ожидаемый результат |
|---|---|---|
| MAN-01 | Непродуктивный inbound звонок через реальный Twilio→SIP→Vapi | Provider id появляется в первом ожидаемом callback; EoC и GET fixtures соответствуют T1 contract |
| MAN-02 | Непродуктивный voicemail/no-answer/failed набор | Positive provider cost проходит ту же finalization; ended classification верна |
| MAN-03 | Изменить assistant в provider console | Drift scan обнаруживает hash mismatch и закрывает новый admission |
| MAN-04 | Ротация tools/status credential по runbook | Overlap/activation/revoke не теряет valid callbacks и не принимает revoked secret |
| MAN-05 | Исчерпать тестовый company/global cap конкурентными calls | Фактический provider POST/SIP count не превышает cap; fallback/queue соответствуют контракту |
| MAN-06 | Provider увеличил общий line limit | Локальная policy меняется отдельно; readback/telemetry отражают новое значение без auto-expansion tenant cap |

Ручные кейсы выполняются только в согласованном non-production environment. Эта
спецификация не разрешает probes на production.

## 9. Команды запуска

До появления файлов результаты остаются `PENDING`; команды становятся acceptance
ledger без изменения формы:

```bash
NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiAgencyProviderContracts.test.js tests/vapiCallIdentity.test.js tests/vapiAgencyGate.test.js --runInBand --forceExit
NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiUsageIngest.test.js tests/vapiUsageReconcile.test.js tests/vapiUsageAuditRepair.test.js --runInBand --forceExit
NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiAssistantRegistry.test.js tests/vapiAgencyProvisioning.test.js tests/vapiConcurrencyLeases.test.js --runInBand --forceExit
NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiUsagePricing.test.js tests/vapiUsageSettlement.test.js tests/vapiVoiceUsageRoutes.test.js --runInBand --forceExit
NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiAgencyMigrations.test.js --runInBand --forceExit
npm --prefix frontend run build
npm --prefix frontend test
NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --forceExit
```

Каждый sabotage запускается той же точной командой соответствующего suite дважды:
с временной поломкой (обязательный FAIL конкретного теста) и после возврата
(обязательный PASS). Удаление/ослабление assertion не считается sabotage.
