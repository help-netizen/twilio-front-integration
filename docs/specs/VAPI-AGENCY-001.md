# VAPI-AGENCY-001 — Albusto как агентство Vapi

Статус: draft для реализации
Дата: 2026-08-16
Связанные документы: `docs/specs/VAPI-AGENCY-001-TASKS.md`,
`docs/test-cases/VAPI-AGENCY-001.md`,
`docs/specs/TENANCY-RBAC-CANON.md`

## 1. Цель

Albusto использует один платформенный аккаунт и одну организацию Vapi как
недоверенную execution plane. Тенанты не получают аккаунт, ключ, org id или
прямой доступ к Vapi. Albusto создаёт и закрепляет ассистентов и SIP-ресурсы за
компаниями, измеряет фактическую стоимость каждой AI-ноги, применяет
версионируемую наценку и списывает результат через существующие prepaid wallet и
auto-recharge.

Изоляция, авторизация, корреляция, лимиты, денежный учёт и биллинг находятся в
Albusto. `assistantId`, SIP URI, входные заголовки или поля webhook не считаются
границей доверия сами по себе.

## 2. Границы

В объёме:

- входящие и исходящие Vapi-звонки, включая неуспешные и несколько AI-ног на
  один Twilio-звонок;
- реестр ассистентов `(company, purpose, environment)` и закреплённые SIP-ресурсы;
- устойчивая идентичность AI-ноги, типизированный usage ledger, reconcile и
  финализация supplier cost;
- атомарные глобальные и покомпанейские concurrency leases;
- cost-plus pricing, settlement и проекция в существующий кошелёк;
- provisioning, drift detection, эксплуатационные алерты и безопасный rollout;
- tenant aggregate API и platform-only audit API без UI-дизайна;
- удаление прежней модели «Vapi-организация/ключ на тенанта».

Вне объёма:

- дизайн tenant/platform экранов;
- новый расчётный контур, новый кошелёк или использование Stripe Connect для
  оплаты Vapi usage;
- выдача тенанту Vapi credentials либо provider diagnostics;
- изменения TENANT-ISO-002;
- покупка телефонных номеров у Vapi: Twilio остаётся владельцем номера, Vapi SIP
  используется как AI-назначение;
- миграции и код в рамках данного документного турна.

## 2.1 Current-state baseline до T2 (принятая разведка)

Этот раздел фиксирует исходную точку реализации; он не переоткрывает
TENANT-ISO-002 и не предлагает сохранять legacy-пути.

### Входящий AI-звонок сегодня

| Точка | Текущий путь | Какие id доступны / пробел |
|---|---|---|
| Twilio ingress и tenant | `backend/src/webhooks/twilioWebhooks.js:498-590` получает компанию только через `AccountSid`, пишет `call.inbound` в inbox и запускает company flow | Twilio parent `CallSid`, `AccountSid`, `company_id`; Vapi id ещё нет |
| CRM call rows | `backend/src/services/inboxWorker.js:397-436` вызывает `backend/src/db/callsQueries.js:20-68`; conflict key уже `(company_id, call_sid)`. Реальный входящий AI-маршрут создаёт отдельные parent и SIP-child строки | У двух строк разные Twilio SID, child хранит `parent_call_sid`; это только группировка. В `calls` нет `vapi_call_id` и supplier cost; `price` — нормализованная Twilio цена |
| Vapi flow node | `backend/src/services/callFlowRuntime.js:392-476` ищет active SIP resource по company/environment, но допускает `node.config.sip_uri`, не закрепляет assistant и передаёт `x-blanc-company-id`/`x-blanc-call-sid` как SIP query | Company, flow context, Twilio parent SID, SIP URI; durable AI-leg/session и Vapi id отсутствуют |
| Assistant request prototype | `voice-agent/services/blanc-call-runtime/src/handlers/vapiAssistantRequest.ts:40-91` впервые видит `message.call.id`, но только логирует; `.../lib/resolveAssistantForCall.ts:39-68` выбирает assistant из глобальной in-memory map без company, а unknown profile возвращает transient assistant (`:70-115`) | Здесь Vapi id уже есть, но не сохраняется и не bind-ится к tenant session. Этот prototype не является доказанным main-server runtime contract; T1 обязан зафиксировать фактический deployed callback |
| Twilio child reconciliation | `backend/src/services/inboxWorker.js:705-799` распознаёт Vapi SIP target и ставит parent `answered_by='ai'` | Twilio parent/child SID и company; Vapi id всё ещё отсутствует. `answered_by` — display classification, не billing identity |
| Vapi tool endpoint | `backend/src/routes/vapi-tools.js:120-145` обрабатывает только `tool-calls`; echoed `assistantOverrides.variableValues` читаются в `:95-115`, ownership ремонтируется transport/company context | Для outbound может найти attempt через `backend/src/services/vapiCallContextService.js:14-50`; inbound call id нигде не сохраняется. Non-tool EoC сюда не попадает |
| Vapi status/EoC | `backend/src/routes/vapiCallStatus.js:158-248` доверяет `message.call.id`, но коррелирует только с `outbound_call_attempts.vapi_call_id`; unknown inbound id — 200 no-op | Vapi id есть в webhook, но inbound row/session для него нет; cost/costBreakdown не сохраняются |

Итоговый пробел: входящий Vapi id рождается в доверенном provider callback, но
сегодня нет заранее созданной локальной AI-session и нет persistence bind. Поэтому
основной входящий объём нельзя ни полно доказуемо досвести, ни биллить.

### Исходящий AI-звонок сегодня

`backend/src/services/outboundCallService.js:73-133` выбирает assistant из общих
`VAPI_LEAD_CALL_ASSISTANT_ID`/`VAPI_OUTBOUND_ASSISTANT_ID`, формирует
`assistantOverrides.variableValues` и вызывает платформенный Vapi. Worker
`backend/src/services/outboundCallWorker.js:287-305` после успешного ответа
сохраняет Vapi id только в `outbound_call_attempts`; status/EoC затем находят
attempt по этому id. `backend/src/services/vapiCallTimelineService.js:264-365` и
`:390-464` зеркалирует звонок в `calls` и ставит `answered_by='ai'`, но supplier
cost не хранит. В живом outbound readback через транзитный Twilio caller-ID поле
`twilioCallSid` отсутствовало: связь существует только потому, что Albusto сам
сохраняет `vapi_call_id` из ответа `POST /call`, а не благодаря provider SID.

Текущая привязка неполна: tenant-scoped `vapi_assistant_profiles` и
`vapi_tenant_resources` существуют, но flow выбирает только SIP resource, outbound
использует global env assistant ids, а assistant-request prototype игнорирует
company при выборе. Tenant API `backend/src/routes/vapi.js:153-207` принимает и
сохраняет клиентский Vapi API key; `:271-379` позволяет tenant CRUD ресурсов и
профилей. Эти поверхности подлежат удалению в T5.

## 2.2 Реализованный delta T1/T2/T3/T4/T5

- Flow runtime создаёт durable session/reservation и одноразовый opaque token до
  `<Dial><Sip>`; SIP получает только token, прямые SIP/resource/assistant overrides
  больше не выбирают destination.
- Единственный смонтированный selector —
  `POST /api/vapi/call-status/assistant-request`. Company берётся из отдельного
  machine credential, а сохранённый assistant возвращается только после exact bind
  token + company + credential + resource tuple + `message.call.id`.
- Legacy prototype больше не строит transient assistant; tenant CRUD/API/UI,
  org provisioner и CLI удалены в T5. Защищённый mount пустого tombstone-router
  снимается отдельным shell patch из `src/server.js`.
- На production до T5 был один legacy SIP resource и не было строк registry
  profile. Migration 275 создаёт только registry schema и не читает env/provider
  state, не проверяет connection/resource/credentials и не пишет строки.
  Отдельный platform-only `bootstrap-vapi-assistant-registry.js` с обязательным
  `--company-id` читает три assistant id из deployment environment, валидирует
  локальные connection/resource/ownership данные и идемпотентно наполняет ABC;
  по умолчанию это dry-run. Machine credentials остаются независимым
  операционным слоем: ровно одна активная строка surface связывается, 0 или >1
  оставляют nullable binding и `readiness_evidence.complete=false`. Runtime при
  отсутствующем/неполном registry остаётся fail-closed, а incident fallback
  продолжает отвечать на входящий без ложной identity.
- T3 требует exact raw body до JSON parsing для денег, но денежный ingest не
  является предусловием outbound FSM/timeline: attempt коррелируется отдельно по
  company credential + локальной строке. До T5 outbound usage создаётся из
  `outbound_call_attempts` без обязательного registry profile; после T5 registry
  drift даёт operational warning, не потерю supplier cost уже совершённого
  звонка. Коррелированный EoC
  записывается как append-only observation и обновляет единую provisional
  projection. Identity/correlation rejection сохраняется в отдельном
  company-scoped quarantine с allowlisted sanitized evidence и alert; неизвестные
  provider enum не исчезают в silent 200. Живое тело EoC ещё не захвачено, поэтому
  fixture остаётся `live:false`, а неподтверждённое placement стоимости
  quarantined fail-closed.
- T4 опрашивает `GET /call/:id` с exact raw body по расписанию
  1m/5m/30m/2h/24h с jitter, требует два одинаковых нормализованных snapshot с
  интервалом не меньше пяти минут и оставляет provider failures вне stability
  evidence. Final supplier snapshots неизменяемы; поздняя correction создаёт
  новую версию и signed `pending_pricing` adjustment, не charge/debit.
- Ночной platform audit отдельно листает provider calls по `createdAt` для
  identity completeness и по `updatedAt` для corrections старых звонков,
  oldest-first догоняет пропущенные дни в конфигурируемом bounded lookback,
  сохраняет orphan/missing/stuck counters и ставит repair в company-scoped
  очередь. Через 24 часа без стабильности создаётся idempotent platform alert и
  состояние `stale_pending`; молчаливой финализации нет.
- Runtime-выбор нового исходящего assistant идёт только через exact
  `(company,purpose,prod)` active registry tuple; global assistant env fallback
  удалён. Inbound reservation использует тот же registry, company-owned resource
  и три typed credentials. Узкий production-инцидентный fallback сохранён только
  для platform-owned `legacy_canary`: он может набрать закреплённый company SIP
  без token, но не принимает tenant SIP/purpose/environment/profile и не
  доступен обычному или второму tenant rollout.
- Legacy Marketplace row переведён в `disabled` replay-safe seed: старые seeds не
  могут снова опубликовать его при старте. Tenant API больше не выдаёт скрытые
  installations, Vapi settings route/UI отсутствуют, а client key,
  `base_config_json` и plaintext resource secret запрещены DB constraints.

## 3. Закрытые решения — дословно

### 3.1 Решения владельца

1. **Тариф: себестоимость × наценка.** Реальный supplier cost хранится всегда. Наценка —
   конфигурируемая, версионируемая (смена наценки не переписывает прошлые начисления).
2. **Второй тенант — только после фазы 2.** Это ГЕЙТ, а не пожелание: пока нет жёсткой привязки
   ассистента, отдельных вебхук-секретов, устойчивой идентичности звонка и атомарных лимитов —
   голос доступен только ABC. Заложи feature gate, который это физически не даёт обойти, и опиши
   в спеке, какие ровно проверки его снимают.
3. **Поведение на лимите:** входящие уходят на запасную ветку flow (обычная маршрутизация/
   голосовая почта), исходящие остаются в очереди без вызова `POST /call`.

### 3.2 Решения тимлида

- Твои инженерные пункты 1–4 принимаю целиком: отдельный типизированный ledger (не в `calls`);
  EoC = provisional, `GET /call/:id` = авторитет, финализация по двум совпавшим замерам,
  через 24 ч — `stale_pending` + алерт, НЕ тихое списание; SIP-ресурс на компанию с закреплённым
  ассистентом и своим server credential; `provider_connections` больше не хранит клиентский ключ
  Vapi, платформенный ключ живёт только в секрет-хранилище.
- **Вчерашние `vapiOrgProvisioningService` + `provision-vapi-tenant.js` выводятся из эксплуатации.**
  В спеке отдельным разделом: что удаляется, что мигрирует, почему (архитектура изменилась после
  того, как выяснилось, что `/org` нашему ключу закрыт). Не оставляй их «на всякий случай».
- **Что видит тенант:** минуты, звонки и итоговая сумма к оплате. Vapi, org id, supplier cost и
  разбивка — только платформенные, тенанту не показываем и в API ему не отдаём.
- **Неуспешные звонки:** биллим фактический supplier cost (модель cost-plus), правило записать в
  спеке явно, с матрицей по ended reason. Голосовая почта и недозвон тоже стоят денег.
- Кошелёк: переиспользуем существующий prepaid + auto-recharge. Второй расчётный контур не заводим.
- Деньги: `NUMERIC`, никаких float. Округление до центов — на уровне settlement, не по звонку.
- Реестр ассистентов по ключу `(company, purpose, environment)`.

## 4. Архитектурные инварианты

1. Любая AI-нога имеет один локальный `vapi_call_session`; в единственной
   платформенной организации `vapi_call_id` глобально уникален независимо от
   company-scoped `provider_connections`. Twilio CallSid не уникален для AI-ног.
2. Любое чтение/изменение tenant-данных использует явный `company_id`; webhook
   получает компанию только из серверного credential/resource/session, не из body.
3. Ассистент, SIP-ресурс и credential одной сессии принадлежат одной компании,
   purpose и environment. Несовпадение закрывает вызов.
4. Внешний caller не может задавать `assistantId`, `assistantOverrides`, model,
   voice, tools, destinations, server URL/credential или provider metadata.
5. EoC — только наблюдение. Только два одинаковых авторитетных `GET /call/:id`
   переводят стоимость в `final`.
6. Денежные значения — PostgreSQL `NUMERIC`; supplier cost не перезаписывается,
   pricing policy фиксируется в начислении, округление выполняется один раз на
   settlement.
7. Атомарный admission резервирует одновременно глобальную и tenant capacity до
   provider call. Ошибка/timeout освобождает lease идемпотентно.
8. Vapi usage списывается только существующим wallet ledger; Connect/application
   fee остаются отдельным контуром tenant-to-customer payments.
9. До снятия Phase 2 gate голос доступен только канонической компании ABC.
10. Tenant API никогда не сериализует provider/supplier поля, даже для admin.

## 4.1 Untrusted Vapi input inventory

T5 закрыл либо сделал evidence-only каждый внешний путь, способный влиять на
provider call:

| Вход | Опасные поля/поведение | Требуемый контракт |
|---|---|---|
| Call Flow Vapi node config | прямой `sip_uri`, `vapi_resource_id`, `provider_connection_id`, profile/assistant id, purpose, environment | Runtime игнорирует эти поля и разрешает только server-owned `inbound_call/prod` registry tuple той же company; legacy-canary fallback также читает только exact company resource |
| Tenant Vapi routes/UI | `api_key`, `base_config_json`, `vapi_assistant_id`, SIP/server URL | Поверхность удаляется; только platform provisioning из template |
| SIP query/custom headers | `company-id`, profile, group/flow/node, caller data | Никакой header не авторизует tenant/assistant; только opaque one-time session token, credential и stored resource binding |
| `assistant-request` body | `call.id`, assistant profile/overrides, customer, destination | `call.id` — evidence для exact bind; assistant/resource уже server-selected. Unknown/mismatch fail closed, transient assistant запрещён |
| `/api/vapi-tools` public body | tool args, `message.call.assistantOverrides.variableValues`, claimed company/subject | Company только из surface credential; session repairs subject; args allowlisted per tool; ownership claims не доверяются |
| Outbound HTTP/job data | scenario, purpose, first message, arbitrary variables/assistant overrides | Worker разрешает server-owned scenario→purpose mapping и typed template variables; caller не передаёт provider config |
| Status/EoC body | company/org/assistant/resource ids, Twilio SID, timestamps, cost/breakdown | Company из credential; call/session exact bind. Lifecycle/cost — validated evidence, не authorization |
| Provider readback/create response | ids, server URL, tools/model/voice/destination | Canonical allowlist/hash; unexpected privileged fields либо drift закрывают readiness |

Даже если поле совпадает с БД, оно не становится authority: authority —
company-bound credential плюс server-created session/resource relation.

## 5. Модель данных (логическая, без номеров миграций)

Все денежные поля ниже — `NUMERIC(18,8)` или более строгий согласованный
`NUMERIC`; JavaScript не преобразует их через `Number`. Внешние идентификаторы
всегда используются вместе с `company_id`, кроме отдельного глобального
уникального ограничения provider account + provider call id.

### 5.1 Конфигурация и реестр

#### `vapi_tenant_voice_configs` (новая, platform-owned)

| Поле | Назначение |
|---|---|
| `id`, `company_id`, `environment` | tenant/environment scope; unique `(company_id, environment)` |
| `rollout_state` | `legacy_canary`, `provisioning`, `ready`, `enabled`, `suspended` |
| `company_concurrency_limit` | положительный локальный предел |
| `fallback_flow_node_id` | серверная входящая ветка при deny/limit |
| `pricing_policy_id` | активная политика для новых сессий |
| `readiness_evidence`, `verified_at` | platform-only результаты проверок; не источник истины |
| `enabled_at`, `enabled_by`, `suspended_at`, `suspend_reason` | platform audit |
| `created_at`, `updated_at` | аудит |

Tenant route записи отсутствует. Runtime повторно проверяет связанные записи, а
не доверяет одному `rollout_state`. `pricing_policy_id` и его FK добавляются
группой `vapi_usage_charges` в T9; до этого поле логически unset, поэтому non-ABC
production gate остаётся закрыт.

#### `vapi_assistant_profiles` (существующая, становится authoritative registry)

| Поле | Назначение |
|---|---|
| `company_id`, `purpose`, `environment` | unique business key |
| `vapi_assistant_id`, `provider_account_key` | provider identity; platform-only |
| `template_version`, `template_hash` | версия server-owned шаблона |
| `tools_credential_id`, `call_status_credential_id` | разные company-bound `api_integrations` credentials/surfaces |
| `status` | `provisioning`, `active`, `drifted`, `disabled`, `deleting` |
| `provider_generation`, `provider_updated_at`, `last_verified_at` | readback/drift evidence |
| `created_at`, `updated_at` | аудит |

Существует ровно одно пространство имён платформенного аккаунта: business key
`(company_id, purpose, environment)` уникален, а непустой `vapi_assistant_id`
глобально уникален независимо от любых per-company `provider_org_id`. Константный
`provider_account_key='vapi:platform'` дополнительно закрыт CHECK constraint.

#### `vapi_tenant_resources` (существующая, расширяется)

| Поле | Назначение |
|---|---|
| `company_id`, `purpose`, `environment`, `assistant_profile_id` | закрепление ресурса за тем же tenant tuple |
| `resource_type` | `sip_destination`, `vapi_phone_number` либо `transient_twilio` |
| `vapi_phone_number_id`, `twilio_phone_number`, `sip_uri` | platform-only provider/caller data; runtime не выбирает их из env |
| `server_credential_id` | собственный company-bound credential ресурса; для assistant-request/resource server, не plaintext secret |
| `status`, `config_hash`, `provider_updated_at`, `last_verified_at` | readiness/drift |
| `created_at`, `updated_at` | аудит |

База и сервис запрещают ссылку ресурса компании A на профиль/credential компании
B. `tools`, `call_status` и resource `assistant_request` используют разные
`api_integrations.machine_surface`; их secret hashes не совпадают. Migration 264
даёт подложку, identity schema разрешает `vapi_call_status` и
`vapi_assistant_request`, а registry migration требует и связывает раздельные
active credentials через same-company constraints.

Outbound использует один generic resource `(company_id, outbound_call, prod)`,
который может ссылаться либо на зарегистрированный Vapi phone id, либо на
tenant-bound transient Twilio caller number. Twilio account token/SID остаются
платформенными секретами. Значение caller resource переносится из deployment
env только отдельным dry-run-by-default operational CLI; runtime env не является
источником номера.

#### `vapi_tenant_provisioning_runs` (platform-owned)

| Поле | Назначение |
|---|---|
| `id`, `company_id`, `environment`, `operation_key` | один durable provisioning workflow на company/environment; provider marker не является tenant authority |
| `template_bundle_version`, `input_hash`, `template_variables` | версия server-owned bundle, secret-free hash и только allowlisted `{companyName,greeting}` |
| `state`, `current_step`, `attempt_count` | `planning → credentials_ready → assistants_pending/ready → resource_pending/ready → ready`; `failed` сохраняет точку ремонта |
| `provider_assistant_ids`, `provider_resource_id`, `sip_uri` | частичные provider identities, сохраняемые сразу после каждого успешного create/discovery |
| `assistant_readback_evidence`, `resource_readback_hash` | secret-free canonical hashes, provider timestamps и template versions |
| `*_credential_id` | company-composite FK на три разные machine surfaces; plaintext отсутствует |
| `last_error_code`, `last_error_step`, timestamps | безопасная операционная диагностика без provider body/секретов |

Таблица не имеет tenant route. Migration 278 создаёт только эту структуру и
readback-поля ресурса; ни company, ни credentials, ни provider objects она не
создаёт. Потерянный ответ после provider create восстанавливается через
`operation_key` в server-owned metadata ассистента либо детерминированный SIP URI.

### 5.2 Идентичность и supplier usage

#### `vapi_call_sessions` (новая)

Одна запись — одна AI-нога, в том числе до появления Vapi call id.

| Поле | Назначение |
|---|---|
| `id`, `company_id`, `direction`, `purpose`, `environment` | локальный canonical root |
| `assistant_profile_id`, `tenant_resource_id`, `provider_account_key` | server-selected execution tuple; account key — platform-only audit label, не per-company namespace |
| `vapi_call_id` | nullable до bind; глобально уникален в единственной платформенной организации |
| `twilio_parent_call_sid`, `twilio_child_call_sid` | evidence/correlation, не identity AI-ноги |
| `outbound_call_attempt_id`, `flow_execution_id`, `flow_node_id` | nullable local origins |
| `correlation_token_hash`, `correlation_expires_at`, `bound_at` | одноразовое inbound bind-доказательство |
| `state` | `created`, `admitted`, `provider_pending`, `active`, `ended`, `cost_pending`, `closed`, `quarantined` |
| `started_at`, `ended_at`, `provider_ended_reason` | provider lifecycle evidence |
| `provider_subscription_limits`, `provider_placement_observed_at` | диагностический POST response snapshot/time; не admission authority |
| `created_at`, `updated_at` | аудит |

Все lookups по Twilio SID дополнительно фильтруются `company_id`; несколько
сессий с одним parent SID допустимы.

#### `vapi_call_usage_observations` (новая, append-only)

| Поле | Назначение |
|---|---|
| `id`, `company_id`, `vapi_call_session_id` | tenant-bound observation |
| `source` | `end_of_call_report`, `get_call`, `audit_repair` |
| `provider_event_id`, `payload_hash` | идемпотентность; raw payload не обязан храниться |
| `supplier_cost`, `breakdown_total` | авторитетный `cost` и заявленный `costBreakdown.total`, exact NUMERIC |
| `transport_cost`, `stt_cost`, `llm_cost`, `tts_cost`, `vapi_cost`, `chat_cost`, `analysis_cost` | nullable NUMERIC компоненты; evidence, не повторное начисление |
| `prompt_tokens`, `completion_tokens`, `total_tokens` | nullable BIGINT; дополнительные token counters добавляются по T1 contract |
| `breakdown_schema_version`, `cost_breakdown_evidence` | версия нормализатора + platform-only JSONB исходной разбивки, включая `analysisCostBreakdown` |
| `provider_updated_at`, `observed_at` | provider и receive clocks |
| `started_at`, `ended_at`, `ended_reason` | нормализованное evidence |
| `validation_state`, `validation_error` | accepted/quarantined reason |

`breakdown_total` сверяется с `supplier_cost`, но transport/STT/LLM/TTS/Vapi/
chat/analysis компоненты никогда не суммируются поверх `total`. Неизвестные
provider keys остаются evidence JSON и не входят в деньги до versioned parser
change; T1 фиксирует точные token/analysis поля.

#### `vapi_call_usage` (новая, текущий снимок)

| Поле | Назначение |
|---|---|
| `company_id`, `vapi_call_session_id` | exactly one current row per session |
| `state` | `provisional`, `reconciling`, `stable_once`, `final`, `stale_pending`, `quarantined` |
| `supplier_cost`, `normalized_breakdown`, `ended_reason` | current authoritative typed snapshot; components NUMERIC/tokens BIGINT по той же schema version |
| `duration_seconds` | provider `startedAt`→`endedAt` duration как non-negative NUMERIC; не Twilio parent duration |
| `snapshot_hash`, `stable_count`, `last_authoritative_at` | convergence evidence |
| `reconcile_attempts`, `next_reconcile_at`, `first_pending_at`, `last_error` | retry schedule |
| `final_snapshot_version`, `finalized_at` | immutable pricing input version |
| `created_at`, `updated_at` | аудит |

#### `vapi_fallback_rate_policies` и `vapi_call_cost_input_events`

`vapi_fallback_rate_policies` хранит версии резервной ставки
`rate_per_started_minute`, их `effective_from`/`effective_to` и источник. Стартовая
версия — `$0.25` за начатую минуту. Runtime-настройка
`VAPI_FALLBACK_RATE_PER_MINUTE` создаёт новую временную версию; сессия выбирает
версию по `admitted_at`, поэтому последующая смена ставки не переписывает прошлое.

`vapi_call_cost_input_events` — immutable append-only вход будущего pricing, а не
второй кошелёк:

| Поле | Назначение |
|---|---|
| `company_id`, `vapi_call_session_id`, `input_version` | tenant/session scope и монотонная версия |
| `event_kind` | `fallback_estimate` либо `supplier_actual_correction` |
| `fallback_rate_policy_id`, `rate_per_started_minute` | pinned версия и exact ставка |
| `duration_seconds`, `billed_started_minutes` | известная длительность и `GREATEST(1, CEIL(seconds / 60))` |
| `supplier_snapshot_version` | nullable у оценки, обязательная ссылка на immutable supplier snapshot у коррекции |
| `amount_delta`, `effective_supplier_cost`, `is_estimate` | signed delta, текущая exact база и явный признак оценки |
| `state`, `created_at` | `pending_pricing`; списания здесь нет |

На сессию допускается только одна первоначальная оценка. Первый настоящий
supplier snapshot добавляет correction `actual - estimate`; последующие supplier
snapshot versions добавляют свои дельты. Оценка не обновляется и не удаляется.
Если supplier snapshot существовал до оценки, оценка вообще не создаётся.

#### `vapi_usage_alerts` и доставка

`vapi_usage_alerts` — текущие platform-only причины денежного риска. Поддерживаются
ровно `provider_orphan`, `stale_pending`, `local_missing`, `quarantined`,
`late_correction_stale`, `assistant_mismatch`, `attempt_mismatch` и
`provider_call_collision`. Кроме scope/типа строка хранит только безопасные
идентификаторы, известный exact `supplier_cost_at_risk` либо `NULL`, признак базы
`supplier`/`fallback_estimate`/`unknown`, change clock и отметку последней доставки.

`vapi_usage_alert_delivery_runs` и `vapi_usage_alert_delivery_items` сохраняют
content fingerprint сводки, причину `digest`/`threshold`, денежные totals,
получателя, send claim/status и состав строк. Успешная сводка отмечает входившие
alerts; неизменившийся fingerprint повторно не отправляется.

### 5.3 Capacity, pricing и списание

#### `vapi_concurrency_leases` (новая)

| Поле | Назначение |
|---|---|
| `id`, `company_id`, `vapi_call_session_id`, `direction` | owner и session |
| `state` | `reserved`, `active`, `released`, `expired` |
| `reserved_at`, `activated_at`, `heartbeat_at`, `expires_at`, `released_at` | lifecycle |
| `release_reason` | end/error/timeout/reaper evidence |
| `provider_subscription_limits` | диагностический снимок ответа Vapi, не admission source |

Одна транзакция/блокировка резервирует глобальную и tenant capacity. Provider
`subscriptionLimits` приходит после `POST /call` и используется только для
телеметрии и сверки общего пула.

#### `vapi_pricing_policies` (новая, immutable versions)

| Поле | Назначение |
|---|---|
| `id`, `version`, `markup_multiplier` | exact cost-plus multiplier, например `1.25000000` |
| `effective_from`, `effective_to`, `status` | выбор политики по времени сессии |
| `created_by`, `created_at`, `reason` | platform audit |

Опубликованная версия не обновляется; изменение создаёт новую версию.

#### `vapi_usage_charges` (новая, immutable ledger)

| Поле | Назначение |
|---|---|
| `id`, `company_id`, `vapi_call_session_id` | charge owner/source |
| `usage_snapshot_version`, `pricing_policy_id` | frozen inputs |
| `supplier_cost`, `markup_multiplier`, `retail_amount_unrounded` | exact NUMERIC audit |
| `kind` | `usage`, `adjustment`, `reversal` |
| `state` | `priced`, `settlement_pending`, `settled`, `voided` |
| `settlement_id`, `wallet_ledger_entry_id` | existing billing projection |
| `idempotency_key`, `created_at`, `settled_at` | exactly-once boundary |

#### `vapi_settlements` (новая)

| Поле | Назначение |
|---|---|
| `id`, `company_id`, `subscription_id`, `period_start`, `period_end` | billing-period identity |
| `exact_amount`, `rounding_carry_in`, `wallet_amount_usd`, `rounding_carry_out` | exact NUMERIC; `wallet_amount_usd` имеет scale 2 после единственного rounding |
| `state`, `idempotency_key`, `wallet_ledger_entry_id` | durable write protocol |
| `created_at`, `posted_at`, `last_error` | retry/audit |

Период определяется существующей подпиской компании, а не календарным днём.
Остаток точности переносится в следующий settlement. Существующий wallet ledger
остаётся единственным балансом; `vapi_usage_charges` — его audit/source detail,
а не второй кошелёк.

## 6. Контракт корреляции и идентичность звонка

### 6.1 Каноническая идентичность

- В Albusto первичный идентификатор AI-ноги — `vapi_call_sessions.id`.
- Во внешней execution plane — глобальный `vapi_call_id` единственной
  платформенной организации; `provider_account_key` не выводится из tenant
  connection и не фрагментирует пространство идентификаторов.
- `twilio_parent_call_sid` обозначает исходный звонок и может иметь несколько
  последовательных или параллельных AI-ног.
- `twilio_child_call_sid`, `outbound_call_attempt_id` и flow execution/node —
  корреляционные доказательства, но не замена Vapi call id.
- Все входящие события сначала устанавливают компанию по аутентифицированному
  server credential, затем ищут session с тем же `company_id`. Body/header claims
  не могут выбрать компанию.
- Ни inbound, ни outbound не полагаются на `twilioCallSid` из Vapi. У outbound с
  транзитным Twilio caller-ID это поле отсутствует; canonical bind выполняется из
  `POST /call` response. Parent SID связывает локальные телеком-ноги только как
  tenant-scoped grouping evidence.

### 6.2 Входящий звонок

1. До перевода на SIP runtime, уже знающий `company_id`, flow node, purpose и
   environment, выбирает только активные registry/resource records.
2. В одной транзакции создаются session/reservation и одноразовый correlation
   token. В SIP destination уходит только opaque token; tenant/company id,
   provider secret и свободный `assistantId` не передаются. Атомарный capacity
   lease добавляется в T8 до снятия multi-tenant gate.
3. Закреплённый SIP-resource имеет один server-owned assistant profile и отдельный
   assistant-request credential. Единственный поддерживаемый assistant-request
   handler возвращает только сохранённый `assistantId`; transient assistant и
   provider/body selection запрещены.
4. Аутентифицированный `assistant-request`, содержащий `message.call.id` и opaque
   token, атомарно bind-ит `vapi_call_id` к session до ответа Vapi.
5. Первичный bind проходит только если credential company, token/session, resource и
   assistant совпали. Token одноразовый и имеет TTL. Повтор с тем же call id
   идемпотентен до drift-проверок и не меняет уже связанную session; другой call id
   или другая company переводит событие в quarantine. Повторный вход flow в тот же
   node не заменяет действующую unbound reservation: он fail closed до её bind/TTL,
   а истёкшую reservation можно карантинить и заменить.
6. Twilio child status может отметить телеком-ногу, но не создаёт и не подменяет
   Vapi identity. `answered_by='ai'` остаётся CRM-классификацией, не денежным ключом.
7. Если штатный assistant-request не выполнил bind, дальнейший callback не ищет
   session по Twilio SID, company/body или assistant эвристически. T3 не создаёт
   observation/usage для unknown/unbound call id; только после exact
   credential + session/attempt correlation он сохраняет allowlisted sanitized
   EoC evidence. Assistant/company mismatch — отказ без денежной строки.

Следствие: Vapi id впервые доступен в доверенном `assistant-request` как
`message.call.id`; к этому моменту локальная session уже существует, а bind
завершается до возврата сохранённого assistant id. EoC не является первым
моментом идентичности.

### 6.3 Исходящий звонок

1. Worker передаёт только локальные `company_id` и `outbound_call_attempt.id`.
   Purpose выводится из локальной строки attempt; profile выбирается по
   `(company,purpose,prod)`, caller — по `(company,outbound_call,prod)`. Env id,
   request assistant/phone/purpose и lead→parts fallback не участвуют.
2. Worker проходит gate и атомарно резервирует lease, затем создаёт session в
   `provider_pending` до сетевого вызова. `POST /call` строится только из
   pinned registry tuple/server template и несёт server-owned
   `metadata.albustoCallSessionId`.
3. Ответный Vapi call id одной PostgreSQL-транзакцией записывается и в session,
   и в существующий company-scoped outbound attempt; lead slot и диагностический
   `subscriptionLimits` входят в тот же переход. Отдельного worker UPDATE нет.
4. Timeout/no-id либо ошибка bind после отправки оставляет `provider_pending`, а
   не немедленный повтор. Ночной provider list допускает repair только по exact
   server-generated session UUID из call metadata + совпавшему pinned assistant;
   company выводится из local session. До repair повторный `POST /call` запрещён.
   Provider API документирует call `metadata` в Create/List Call contract:
   https://docs.vapi.ai/api-reference/calls/create и
   https://docs.vapi.ai/api-reference/calls/list.
5. Gate/limit deny оставляет задачу в очереди, не создаёт provider attempt и не
   вызывает `POST /call`.

## 7. Жизненный цикл стоимости

```text
EoC observation
  -> provisional
  -> reconciling
  -> GET #1 stable_once
  -> GET #2 (same authoritative snapshot, separated in time) final
  -> priced (immutable policy version)
  -> settlement_pending
  -> settled (existing wallet ledger)
```

### 7.1 Приём наблюдений

- `end-of-call-report` записывается append-only и идемпотентно по provider event
  identity либо детерминированному payload hash. Он обновляет provisional evidence,
  но никогда не финализирует и не списывает.
- Status/EoC допускается только company-bound `vapi_call_status` credential; его
  company должна совпасть с T2 session либо outbound attempt. Assistant id
  сравнивается с pinned registry identity. Unknown/foreign id не создаёт session,
  observation или usage.
- EoC хранит только allowlisted sanitized provider payload: identity, lifecycle и
  cost lexemes. JSON numbers сохраняются decimal-строками; transcript, messages,
  recordings, phone/customer data, names, assistant snapshots/overrides и server
  config отбрасываются до persistence. До живого захвата поддерживается только
  документационное `message.call.cost`; иное размещение quarantined fail-closed.
- `GET /call/:id` — авторитетный источник. Snapshot hash включает exact `cost`,
  нормализованный `costBreakdown`, `endedAt`, `endedReason` и provider
  `updatedAt`/эквивалентную версию.
- Два совпавших авторитетных snapshot, полученных разными успешными reconcile
  попытками с минимальным интервалом, дают `final`. Два чтения в одном цикле не
  считаются двумя замерами.
- Рекомендуемый retry schedule: около 1 мин, 5 мин, 30 мин, 2 ч и 24 ч с jitter.
  Конкретные интервалы конфигурируемы; семантика состояний неизменна.
- Через 24 часа без двух совпадений состояние становится `stale_pending`, создаётся
  алерт. Repair продолжает редкие попытки. Если известны сама AI-нога и её
  длительность, отдельный явно помеченный fallback input резервирует стоимость по
  §7.3; если длительность неизвестна, остаётся только денежный алерт. Тихая нулевая
  финализация запрещена.
- Negative, non-numeric, malformed или несогласованный cost переводит observation
  в `quarantined`. `costBreakdown.total` не прибавляется к `cost` и компонентам.

### 7.2 Финал, поздняя коррекция и идемпотентность

- `final_snapshot_version` монотонна. Из final создаётся не более одного `usage`
  charge для `(session, snapshot version)`.
- Если последующий authoritative audit меняет уже финальный supplier snapshot,
  прошлые usage/settlement/wallet записи не переписываются. Создаётся следующая
  snapshot version и точный `adjustment` либо `reversal` на дельту с новой
  идемпотентностью.
- Retry после crash между settlement и wallet write находит ту же idempotency key
  и тот же wallet entry. Не существует окна для двойного дебета.
- Worker/cron принимает `companyId` явно и выбирает строки с tenant predicate;
  глобальный dispatcher лишь перечисляет компании, не выполняет unscoped money SQL.

### 7.3 Резервная стоимость при отсутствии supplier cost

Авторитетный `GET /call/:id` и его final snapshots всегда имеют приоритет. Резервная
оценка создаётся только для `stale_pending`/`quarantined` сессии без supplier
snapshot и без provisional `usage.supplier_cost`, когда локально известна
длительность AI-ноги. Любое настоящее supplier cost имеет приоритет независимо
от состояния стабилизации. Полностью невидимый звонок
или provider orphan без длительности не оценивается: он остаётся алертом с
`cost=unknown`.

Формула — `started_minutes = GREATEST(1, CEIL(duration_seconds / 60))`,
`estimated_supplier_cost = started_minutes × pinned_rate`. Все операнды и результат
— PostgreSQL `NUMERIC`; JavaScript float и округление до центов отсутствуют.
Десять секунд равны одной начатой минуте. Дефолтная ставка — `$0.25/мин`.

Когда настоящий supplier snapshot появляется после оценки, создаётся отдельный
immutable `supplier_actual_correction` на `actual - estimate`; первоначальная
оценка не переписывается. Pricing обязан выбрать actual при его наличии и не
суммировать полную оценку с полной actual стоимостью дважды.

Контрольный production-замер владельца на 93 обезличенных звонках: actual `$45.34`,
оценка по `$0.25` с округлением минут вверх `$48.00`, покрытие `106%`; оценка ниже
actual на 32 звонках и выше на 61. Ставка безубыточности для этой выборки около
`$0.24/мин`; владелец выбрал `$0.25`, чтобы совокупно оставаться выше себестоимости.
**Плоская ставка всё равно недобирает на отдельных длинных звонках** — разброс
себестоимости по звонку двенадцатикратный, и единая цена минуты покрывает сумму,
а не каждый звонок. Это evidence для выбора значения, не обещание будущего покрытия.

### 7.4 Pricing и settlement

`retail_amount_unrounded = supplier_cost × markup_multiplier`, где multiplier
выбирается по времени вызова/зафиксированному policy id до settlement. Оба операнда
и результат остаются `NUMERIC`. На звонке нет округления до центов.

Settlement суммирует exact unrounded charges внутри периода существующей
подписки, прибавляет carry-in, один раз округляет к целым центам по утверждённому
правилу PostgreSQL и сохраняет carry-out. Только после этого выполняется один
идемпотентный debit существующего prepaid wallet. Недостаток баланса обрабатывается
существующим auto-recharge; отдельный Vapi balance не создаётся.

### 7.5 Матрица ended reason

Главное правило: если авторитетный final supplier cost положителен, фактический
cost биллится независимо от коммерческого результата звонка.

| Нормализованная группа | Примеры provider reason | Supplier cost | Действие |
|---|---|---:|---|
| Нормальное завершение | customer/assistant ended, completed | `> 0` | cost-plus charge |
| Перевод/разрыв после соединения | transfer, customer hangup, assistant hangup | `> 0` | cost-plus charge |
| Нет ответа/занято | no-answer, busy, timeout | `> 0` | cost-plus charge |
| Голосовая почта | voicemail/answering-machine | `> 0` | cost-plus charge |
| Provider/start/tool error | provider-error, assistant-error, failed | `> 0` | cost-plus charge + operational metric |
| Любая известная группа | любое | `= 0` | zero usage record, без debit |
| Отмена до provider identity | queued/cancelled before `POST /call` | отсутствует | без usage charge |
| Неизвестная причина | новый/unknown reason | `> 0` | cost-plus charge + alert для классификатора |
| Invalid/missing final cost | любое | неизвестен | `stale_pending`/`quarantined`, без debit |

Ended reason влияет на аналитику и алерты, но не отменяет подтверждённый supplier
cost. Несколько AI-ног одного Twilio parent тарифицируются каждая по своему
финальному Vapi call id.

## 8. Gate второго тенанта

Gate выполняется через единую серверную функцию допуска, вызываемую как входящим
flow runtime до выдачи SIP destination, так и outbound worker до lease/`POST
/call`. UI-флаг, readiness JSON и наличие assistant id сами по себе gate не
снимают.

До завершения Phase 2 допускается только канонический immutable id компании ABC,
проверяемый на сервере. Для любой другой компании функция обязана одновременно
подтвердить:

1. глобальный VAPI agency runtime включён;
2. отдельный multi-tenant rollout flag включён platform operator;
3. компания активна, а `(company, environment)` имеет `rollout_state='enabled'`;
4. существует ровно один active assistant registry row для требуемых company,
   purpose и environment;
5. существует ровно один active SIP resource той же компании, закреплённый за
   этим assistant;
6. provider readback совпадает с template/resource hashes и не помечен drifted;
7. существуют активные, неистёкшие и разные server credentials для
   `vapi_tools`, `vapi_call_status` и credential закреплённого SIP resource;
   endpoint `vapi_assistant_request` вызывается только если явно включён
   dynamic-resource path;
8. inbound durable session/token bind contract включён и прошёл health/readback;
9. положительный company concurrency limit и global policy обслуживаются
   атомарным admission/lease механизмом;
10. есть активная pricing policy и разрешимая существующая subscription/wallet
    связь компании.

Переход `ready -> enabled` доступен только platform manage и транзакционно заново
вычисляет условия. На каждом звонке runtime повторяет критические relational
проверки, поэтому устаревший readiness snapshot не открывает доступ.

ABC-only Phase 2 flag становится доступен для изменения только после приёмки
T1–T8, прохождения всех их P0/P1 и sabotage тестов, provider readback и периода
наблюдения ABC без необъяснимых/некоррелированных AI-ног. Это не включает tenant
автоматически: runtime всё равно проверяет пункты 1–10. Поэтому production voice
второго tenant дополнительно ждёт T9 и действующие pricing/subscription/wallet
связи. При любом deny:

- входящий flow продолжает заранее настроенную обычную/voicemail fallback ветку,
  не выдавая Vapi SIP и не удерживая lease;
- исходящий job остаётся queued с retry reason, не вызывает `POST /call`, не
  увеличивает provider attempt count и не списывает деньги.

Отключение multi-tenant flag снова закрывает все компании, кроме отдельно
контролируемого ABC canary; `suspended` закрывает и конкретный tenant.

## 9. Provisioning и drift

Полностью автоматизируется:

1. создание `provisioning` tenant config;
2. выпуск отдельных machine credentials на базе механизма migration 264 —
   `vapi_tools`, `vapi_call_status` и свой credential SIP resource, с
   company-bound scopes, hash-at-rest, ротацией и отзывом;
3. рендер server-owned assistant template без tenant/provider overrides;
4. create/update assistant в общей Vapi organization;
5. настройка tools/server URLs на соответствующие credential endpoints;
6. создание/обновление SIP resource компании с фиксированным assistant;
7. `GET` readback, canonical hashing, сохранение provider generation и перевод в
   `ready` только при полном совпадении;
8. идемпотентный повтор, repair частично созданных ресурсов, drift scan и
   безопасное disable/rotate.

Человеку остаётся:

- владение/настройка Twilio number и его маршрутизация на конкретный выданный SIP
  destination, если используемый Twilio/provider contract не позволяет безопасную
  полную автоматизацию;
- одобрение pricing policy, concurrency cap и platform transition в `enabled`;
- проверка тестового звонка/readback и разбор drift/quarantine/stale alerts;
- увеличение общего лимита Vapi линий в панели поставщика.

Legacy direct SIP и новый per-company Vapi resource могут различаться деталями
provider API, но обязаны реализовать один registry/session/credential контракт.
T1 фиксирует живые provider fixtures до выбора адаптера.

### Реализованный T7-контракт

`backend/scripts/provision-vapi-agency-company.js` требует `--company-id`, по
умолчанию выполняет только plan и делает записи лишь с `--apply`. Одна операция:

1. создаёт/ремонтирует локальные connection, voice config и durable run;
2. через migration-264 substrate создаёт три разные hash-at-rest credentials
   `vapi_tools`, `vapi_call_status`, `vapi_assistant_request`; plaintext берётся
   только из per-company deployment secret variables и не логируется;
3. рендерит три versioned source-controlled template: `inbound_call`,
   `outbound_lead_call`, `outbound_parts_call`; tenant/provider JSON merge нет;
4. находит объект по сохранённому id или server-owned provisioning metadata,
   иначе делает `POST /assistant`, затем всегда `PATCH` и `GET` readback;
5. создаёт/ремонтирует детерминированный Vapi SIP resource с
   `assistantId=null` и единственным assistant-request URL, затем делает PATCH/GET;
6. только после полного readback одной транзакцией активирует registry/resource,
   отзывает superseded credentials и переводит voice config в `ready` (но не
   `enabled`).

Assistant `server.secret` проверяется только по
`isServerUrlSecretSet=true`: Vapi не возвращает его значение. Для
`model.tools[].server.secret` readback обязан совпасть с переданным секретом, но
ни readback, ни payload не сохраняются и не логируются. Дополнительные provider
поля терпимы, обязательная форма, число/порядок tools и все отправленные
security-relevant поля проверяются fail-closed. Ни один путь T7 не вызывает
`/org`.

Provider create и локальная БД не образуют общую ACID-транзакцию. Поэтому
частичный успех не маскируется rollback-ом: provider id/evidence сохраняются по
шагам, `failed/current_step/last_error_code` видимы, а повторный `--apply`
находит созданное и дочиняет его без дубля. T7 снимает gate на безопасное
провижининговое подключение второго tenant; перевод реальных звонков в
`enabled` остаётся отдельным runtime/admission и money gate.

## 10. Что удаляется и что мигрирует

### Удалено в T5

- `backend/src/services/vapiOrgProvisioningService.js`;
- `backend/scripts/provision-vapi-tenant.js`;
- `tests/vapiOrgProvisioningService.test.js` как тест отменённой архитектуры; вместо
  него появляются registry/resource provisioning и drift tests;
- tenant-facing `frontend/src/pages/VapiSettingsPage.tsx` и
  `frontend/src/services/vapiApi.ts`, а также tenant routes из
  `backend/src/routes/vapi.js`, которые позволяют вводить Vapi API key, создавать
  org/assistant/phone resources или видеть provider metadata;
- runtime environment-driven assistant selection. Deployment значения
  `VAPI_INBOUND_ASSISTANT_ID`, `VAPI_LEAD_CALL_ASSISTANT_ID` и
  `VAPI_OUTBOUND_ASSISTANT_ID` читаются только platform-only operational bootstrap
  CLI для доказуемого company-scoped backfill; ни migration, ни outbound
  placement, ни usage ingestion не выбирают по ним assistant;
- клиентский Vapi API key в `provider_connections` и любой API, который его
  принимает/возвращает. Платформенный ключ существует только в deployment secret
  store и никогда не сохраняется в tenant DB.

Org provisioner, tenant provisioning CLI, CRUD и global assistant fallback не
оставлены «на всякий случай»: их наличие создавало бы второй путь в обход
registry, gate и platform-key ownership. Новый bootstrap CLI не создаёт Vapi org
или provider resources и не является runtime fallback: он пишет только
company-scoped локальное соответствие после явной операторской проверки.
Сохранённый incident fallback ограничен `legacy_canary`, exact
company/purpose/prod resource и не возвращает assistant без token.

Migration 275 выполняется обычным `psql -v ON_ERROR_STOP=1 -f`, не требует
`PGOPTIONS`/session settings и всегда остаётся data-neutral. Она добавляет только
таблицу, nullable registry/readiness columns, constraints и indexes; legacy rows
не очищает и не backfill-ит. Операционный порядок после DDL:

1. dry-run:
   `node backend/scripts/bootstrap-vapi-assistant-registry.js --company-id <uuid>`;
2. при необходимости read-only provider check: добавить `--verify-provider`;
3. после проверки плана: повторить с `--apply`.

CLI требует все три assistant env ids и однозначные active connection/SIP
resource, отказывается при conflict/foreign ownership и выполняет data cleanup +
profile/resource/config upsert в одной транзакции. Отсутствующие/неоднозначные
operational credentials не мешают registry data bootstrap, но оставляют nullable
bindings, readiness evidence и runtime fail-closed.

### Мигрирует

- существующие ABC `vapi_assistant_profiles` и `vapi_tenant_resources` в новый
  tuple registry с environment/purpose/template evidence;
- текущий SIP `sip:blanc-ai-dev@sip.vapi.ai` — в resource ABC после provider
  readback, без предположения, что это купленный номер;
- известные `outbound_call_attempts.vapi_call_id` — в session/usage identity при
  однозначном company-bound соответствии;
- существующие machine credentials — в отдельные surfaces и ротацию; секреты не
  копируются в документы/логи;
- tenant billing link — на существующие subscription, prepaid wallet и
  auto-recharge, без миграции Stripe Connect в usage billing;
- исторические `calls.price` не становятся Vapi cost: это поле сохраняет текущую
  Twilio-семантику.

Неоднозначные исторические звонки не получают вычисленный supplier cost. Они
попадают в backfill exception report и не списываются автоматически.

Почему: `/org`, `/org/:id` и `/org/limits` закрыты платформенному private key,
отдельного agency tariff нет. Архитектура «организация и ключ Vapi на тенанта» не
реализуема и противоречит принятой модели единого supplier contract.

## 11. API-контракты без UI-дизайна

### Контракт данных будущей настройки AI-ассистента

T5 не создаёт замену удалённому экрану и не определяет route/layout. Будущему
provider-neutral экрану backend должен дать только product identity/purpose,
пользовательское имя, product-level readiness/availability, revision для
optimistic concurrency и allowlisted business settings/capabilities, которые
будут отдельно утверждены продуктом. Он не должен получать или принимать Vapi,
org/account id, assistant/profile/resource id, SIP URI, environment, template,
server URL/credential, supplier cost, provider status/readback либо
`assistantOverrides`. Любое изменение бизнес-настроек проходит server-owned
template/provisioning contract, а не merge provider JSON.

T7 фиксирует минимальный write-контракт template variables: company name берётся
из canonical `companies.name`, а единственный прямой tenant-editable параметр
операции — однострочное `greeting` длиной до 240 символов. Неизвестные поля,
фигурные скобки, URL и переносы строки отвергаются. Будущий экран может читать
product-level purpose/readiness/revision и редактировать greeting, но не получает
provider ids, template/prompt/model, webhook/tool URLs или credential evidence.

### Tenant projection

`GET /api/billing/voice-usage?period_start=&period_end=` использует
`authenticate, requireCompanyAccess`, получает компанию только из
`req.companyFilter?.company_id` и требует `tenant.company.manage`.

Минимальный ответ для активного периода:

```json
{
  "period": { "start": "...", "end": "...", "currency": "usd" },
  "totals": {
    "calls": 0,
    "minutes": "0.00",
    "period_closed": false,
    "amount_accrued_to_date": "0.00000000"
  },
  "daily": [
    { "date": "YYYY-MM-DD", "calls": 0, "minutes": "0.00", "amount_accrued": "0.00000000" }
  ]
}
```

После settlement ответ того же периода меняет только денежный discriminator и
итоговое поле:

```json
{
  "period": { "start": "...", "end": "...", "currency": "usd" },
  "totals": {
    "calls": 0,
    "minutes": "0.00",
    "period_closed": true,
    "amount_due": "0.00"
  },
  "daily": [
    { "date": "YYYY-MM-DD", "calls": 0, "minutes": "0.00", "amount_accrued": "0.00000000" }
  ]
}
```

`calls` считает финализированные тарифицируемые Vapi AI-ноги, а не уникальные
Twilio parent calls. Unique Twilio conversations остаются внутренней группировкой
и в tenant projection не выдаются. `minutes` — сумма provider duration этих же
ног, делённая на 60.

Для незакрытого периода `period_closed=false` и
`amount_accrued_to_date` содержит exact unrounded NUMERIC-сумму уже
финализированных и оценённых retail charges на текущий момент. Это промежуточное
накопление: оно может увеличиваться по мере финализации звонков и не называется
суммой к оплате. Поле `amount_due` до settlement отсутствует. После settlement
`period_closed=true`, промежуточное поле отсутствует, а `amount_due` содержит
единственную округлённую до центов итоговую сумму с учётом rounding carry.
`daily.amount_accrued` всегда остаётся exact consumption attribution и не
объявляется суммой к оплате.

Provisional/stale calls не входят в calls/minutes/amount до финализации.
Длительность и деньги передаются decimal strings. Семантический `amount` из MCP
parity проецируется в одно из двух явно названных полей выше; сырого поля
`amount` tenant API не сериализует. Tenant contract не содержит
`vapi`, `orgId`, assistant/provider ids, supplier cost, markup multiplier,
costBreakdown, tokens, credentials, raw ended reason или platform alerts.
Границы периода совпадают с существующим subscription period, а звонок относится
к периоду по `session.started_at`.

### Platform projection

Platform-only read (`platform.companies.view`) может возвращать session identity,
provider ids, supplier snapshots/breakdown, pricing policy, leases, reconcile и
settlement state. Provision/enable/rotate/reconcile repair требуют
`platform.companies.manage`. Формат UI в этой задаче не определяется.

## 12. Tenancy & Roles

Канон: `docs/specs/TENANCY-RBAC-CANON.md`. Для tenant HTTP foreign entity
возвращается 404; platform cross-company доступ возможен только через отдельную
platform route/permission и всегда требует явного target company. Webhook body не
является источником scope.

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| retired tenant `/api/vapi/*` management | route absent; no scope/query occurs | none | none | все tenant/platform roles ✗ (404) | оставленный CRUD принял бы чужой assistant/SIP/key |
| tenant Marketplace catalog/installations | authenticated tenant company | published app + company installation | existing marketplace read/manage permissions | обычные marketplace роли; retired provider app ✗ | старый seed мог снова раскрыть provider branding/install action |
| `GET /api/billing/voice-usage` | `req.companyFilter?.company_id` | company + subscription period | `tenant.company.manage` | tenant admin/custom-with-permission ✓; manager/dispatcher/provider/custom-without ✗ | unscoped aggregate reveals other tenants' calls/money |
| platform usage read | authenticated platform actor + explicit target company | target company + session/period | `platform.companies.view` | platform super_admin ✓; tenant/unscoped roles ✗ | provider ids and supplier economics leak |
| platform provision/enable/rotate/repair | authenticated platform actor + explicit target company | company + purpose + environment | `platform.companies.manage` | platform super_admin ✓; tenant/unscoped roles ✗ | wrong assistant/secret can receive another tenant's calls |
| inbound flow Vapi-node runtime | existing flow execution company | company + flow execution/node + registry tuple | internal worker contract; originating flow already tenant-scoped | runtime service ✓; direct user input ✗ | unscoped assistant lookup routes a call across companies |
| outbound call worker | job/attempt `company_id` passed explicitly | company + attempt + registry tuple | internal worker contract | worker ✓; HTTP caller ✗ | global env assistant sends call under wrong tenant |
| Vapi tool webhook | server credential resolved to company | credential + company + session + tool call id | machine surface `vapi_tools` | matching active credential ✓; tenant JWT/body company/other credential ✗ | shared secret/body scope invokes tools cross-tenant |
| Vapi call-status/EoC webhook | server credential resolved to company | credential + company + provider call id/session | machine surface `vapi_call_status` | matching active credential ✓; tenant JWT/body company/other credential ✗ | forged event binds/costs another tenant's call |
| Vapi assistant-request webhook (only if enabled) | dedicated resource credential + pending token | credential + company + resource + token/session | machine surface `vapi_assistant_request` | exact active credential/resource ✓; all others ✗ | override/assistant injection defeats hard binding |
| reconcile dispatcher | platform enumeration only | due company ids | internal scheduler | scheduler ✓; users ✗ | one unbounded query silently skips tenant predicate |
| reconcile company worker | explicit `companyId` argument | company + session + provider call id | internal worker contract | worker for dispatched company ✓; absent/mismatched company ✗ | provider read updates foreign usage |
| atomic admission/lease/reaper | explicit `companyId`, session and global policy | company + session/lease | internal worker contract | runtime/worker ✓; user/webhook body ✗ | race exceeds tenant/global cap or frees foreign lease |
| pricing/settlement worker | explicit `companyId` + subscription period | company + final snapshot + immutable policy | internal billing worker | billing worker ✓; tenant/provider caller ✗ | cross-tenant debit or policy rewrite |
| wallet projection | existing billing company scope | company + settlement idempotency key | existing billing service contract | billing worker ✓; Connect webhook ✗ | double debit or Connect/usage ledger mixing |
| tenant usage SSE/cache (если добавится) | authenticated subscription company | company + aggregate version | `tenant.company.manage` | same as tenant read ✓/✗ | shared cache/channel leaks amounts; v1 may use no SSE |
| MCP voice-usage tool/resource | authenticated company context | company + same aggregate service | `tenant.company.manage` | same as tenant read ✓/✗ | MCP-specific SQL/drift exposes supplier fields |

Обязательная матрица тестов для каждой company-scoped строки:

- `T-own`: собственная запись/агрегат доступна и меняется только в своей компании;
- `T-foreign`: foreign id даёт 404 и byte-for-byte unchanged rows/ledger/wallet;
- `T-blast`: одинаковые provider/natural keys в A и B не смешивают результат;
- `R-matrix`: проверяется каждая deny-клетка таблицы, включая custom role без
  разрешения;
- worker/webhook эквиваленты используют explicit-company, wrong-company и
  missing-company cases, даже если HTTP 404 неприменим.

## 13. Verification

Результаты проставляются по мере реализации; ещё не начатые фазы остаются
`PENDING`.

### 13.1 Автоматические наборы

| Область | Планируемые suites | Точная команда | Результат |
|---|---|---|---|
| T1 provider contracts + T2 inbound identity | `tests/vapiAgencyProviderContracts.test.js`, `tests/vapiCallIdentity.test.js`, `tests/vapiAssistantRequest.test.js`, `tests/vapiCallIdentityAlerts.test.js`, `tests/services/callFlowRuntime.vapi.test.js`, `tests/vapiCallStatusWebhook.test.js` | `unset NODE_USE_SYSTEM_CA; DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiAgencyProviderContracts.test.js tests/vapiCallIdentity.test.js tests/vapiAssistantRequest.test.js tests/vapiCallIdentityAlerts.test.js tests/services/callFlowRuntime.vapi.test.js tests/vapiCallStatusWebhook.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"` | PASS; финальный combined run с migration/machine/sibling suites: 10 suites / 137 tests |
| Phase 2 gate | `tests/vapiAgencyGate.test.js` | команда определяется в T8 | PENDING |
| T3 provisional usage ingest | `tests/vapiUsageIngest.test.js`, `tests/vapiUsageIngestMigration.test.js`, provider/route sibling suites | `unset NODE_USE_SYSTEM_CA; DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiUsageIngest.test.js tests/vapiUsageIngestMigration.test.js tests/vapiAgencyProviderContracts.test.js tests/vapiCallStatusWebhook.test.js tests/outboundLeadCallWebhook.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"` | PASS; 5 suites / 97 tests. T2 identity/assistant-request/machine siblings: 5 suites / 48 tests. Tenant SQL rules PASS; public-route rule PASS after registering the credential-protected assistant-request subrouter. |
| T4 reconcile/audit | reconcile, audit, provider client, scheduler, migration + затронутые T3/provider/rules siblings | `unset NODE_USE_SYSTEM_CA; DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiUsageReconcile.test.js tests/vapiUsageAuditRepair.test.js tests/vapiProviderClient.test.js tests/vapiUsageReconcileScheduler.test.js tests/vapiUsageReconcileMigration.test.js tests/vapiUsageIngest.test.js tests/vapiUsageIngestMigration.test.js tests/vapiAgencyProviderContracts.test.js tests/vapiCallStatusWebhook.test.js tests/outboundLeadCallWebhook.test.js tests/outboundLeadCallSmsCancel.test.js tests/repairAdvisorEvents.test.js tests/rulesEngine.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"` | PASS; 13 suites / 160 tests. Включает missing-EoC repair, createdAt+updatedAt audit, exact decimals, leases, T-foreign, no-wallet и scheduler registration. Targeted `tenantSafetyLint` R-natural-key: PASS. |
| Phase-1 adversarial fixes | независимый FSM, registry-less outbound ingest, identity quarantine, cached tokens, missed-day audit | команда T3/T4 с `tests/vapiProviderMessageQuarantineMigration.test.js` и webhook/provider siblings | PASS; целевой combined run 11 suites / 147 tests; targeted tenant safety 1/1; migration 270 forward×2/rollback/restore через real `psql` PASS |
| Loss protection: digest + fallback cost | `tests/vapiUsageAlertDelivery.test.js`, `tests/vapiFallbackRating.test.js`, `tests/vapiLossProtectionMigration.test.js`, scheduler/provider/T3/T4 regressions | `unset NODE_USE_SYSTEM_CA; DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiUsageAlertDelivery.test.js tests/vapiFallbackRating.test.js tests/vapiLossProtectionMigration.test.js tests/vapiUsageReconcileScheduler.test.js tests/vapiProviderClient.test.js tests/vapiUsageIngest.test.js tests/vapiUsageAuditRepair.test.js tests/vapiUsageReconcile.test.js tests/vapiCallStatusWebhook.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"` | PASS; combined 9 suites / 96 tests, включая 12 новых digest/fallback/migration кейсов; targeted tenant SQL sanitizer — 0 нарушений |
| T5 registry/surface retirement | registry/migration/bootstrap/identity/routes/tools + inbound/outbound/usage regressions | `unset NODE_USE_SYSTEM_CA; DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiAssistantRegistryBootstrap.test.js tests/vapiAssistantRegistry.test.js tests/vapiAssistantRegistryMigration.test.js tests/vapiCallIdentity.test.js tests/vapiAssistantRequest.test.js tests/outboundCallService.test.js tests/services/callFlowRuntime.vapi.test.js tests/routes/vapiTenantIsolation.test.js tests/vapiUsageIngest.test.js tests/machineCredentialService.test.js tests/vapiCallStatusWebhook.test.js tests/outboundCallWorker.test.js tests/outboundLeadCallWorker.test.js tests/routes/vapi-tools.test.js tests/outboundLeadCallWebhook.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"` | PASS; 15 suites / 306 tests. Real autocommit migration 275 `psql -v ON_ERROR_STOP=1 -f` ×2: empty без Vapi rows/settings PASS (`0 connections / 0 resources / 0 profiles / 0 configs`), prod-like PASS и legacy data byte-unchanged. Реальный CLI: dry-run writes 0; apply ×2 даёт `3 profiles / 3 credential-bound / 1 resource / readiness=true` |
| T6 outbound registry/session cutover | outbound placement/workers, registry/bootstrap, identity, provider audit/client, webhook regressions | `unset NODE_USE_SYSTEM_CA; DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/outboundCallService.test.js tests/outboundCallWorker.test.js tests/outboundLeadCallWorker.test.js tests/outboundLeadCallWebhook.test.js tests/outboundCancelTenantIsolation.test.js tests/vapiAssistantRegistry.test.js tests/vapiOutboundBootstrap.test.js tests/vapiOutboundIdentity.test.js tests/vapiProviderClient.test.js tests/vapiUsageAuditRepair.test.js tests/vapiCallStatusWebhook.test.js tests/vapiCallIdentity.test.js tests/services/callFlowRuntime.vapi.test.js tests/vapiUsageIngest.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"` | PASS; 14 suites / 243 tests. Migration 277 повторно применена в real PostgreSQL suite; caller bootstrap apply ×2 idempotent; inbound hotfix, usage/FSM independence и оба outbound семейства green. |
| T7 provisioning/readback | provisioning state/CLI/provider contracts + registry/machine/webhook regressions | `unset NODE_USE_SYSTEM_CA; DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiAgencyProvisioning.test.js tests/vapiAgencyProviderClient.test.js tests/vapiAssistantRegistry.test.js tests/vapiAssistantRegistryBootstrap.test.js tests/machineCredentialService.test.js tests/routes/vapi-tools.test.js tests/vapiCallStatusWebhook.test.js tests/vapiAssistantRequest.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"` | PASS; T7 targeted 2 suites / 13 tests, acceptance 8 suites / 156 tests, функциональная регрессия T1–T7 без старых rollback-suites 24 suites / 355 tests. Migration 278 real `psql -v ON_ERROR_STOP=1 -f` autocommit ×2 PASS. |
| Outbound/concurrency | new admission suites + current worker regressions | `NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiConcurrencyLeases.test.js tests/outboundCallWorker.test.js tests/outboundLeadCallWorker.test.js --runInBand --forceExit` | PENDING |
| Pricing/settlement/API | new money suites + current billing regressions | `NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiUsagePricing.test.js tests/vapiUsageSettlement.test.js tests/vapiVoiceUsageRoutes.test.js tests/billingPaygSubscribe.test.js --runInBand --forceExit` | PENDING |
| Forward/rollback migrations | real disposable PostgreSQL migration suites | `unset NODE_USE_SYSTEM_CA; DATABASE_URL=postgresql://localhost/albusto_test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/vapiAgencyMigrations.test.js tests/vapiUsageIngestMigration.test.js tests/vapiUsageReconcileMigration.test.js --runInBand --forceExit --testPathIgnorePatterns "/node_modules/"` | PASS; migration 269 repeat/rollback suite green и реальный autocommit `psql -v ON_ERROR_STOP=1 -f` forward 266→267→269 / rollback 269→267→266 green |
| Tenant settings removal | frontend build/tests | `unset NODE_USE_SYSTEM_CA; npm --prefix frontend run build` then `unset NODE_USE_SYSTEM_CA; npm --prefix frontend test -- --run` | build PASS. Full Vitest: 86 files / 510 tests PASS; 6 files / 7 pre-existing non-T5 ratchet failures (Integrations legacy browser contract, type scale, schedule header, settings analytics/nav, company-time ledger) |
| Full backend regression | all Jest suites | `NODE_ENV=test node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --forceExit` | PENDING |

Database integration suites используют disposable PostgreSQL и реальный migration
runner; mock-only SQL tests не закрывают денежные/tenant инварианты. Точные
forward/rollback migration filenames добавляются в ledger после назначения
номеров, не резервируемых этой спецификацией.

### 13.2 Sabotage ledger

Каждая строка означает реальную временную поломку implementation seam; тест обязан
стать красным, после возврата кода — зелёным.

| ID | Что временно сломать | Какой тест обязан покраснеть | Результат |
|---|---|---|---|
| `SAB-VAPI-GATE` | убрать ABC/multi-tenant gate перед inbound и outbound | `vapiAgencyGate` non-ABC deny/no-provider-call | PENDING |
| `SAB-VAPI-IDENTITY-TENANT` | убрать `company_id` из session lookup | `vapiCallIdentity` T-blast/T-foreign unchanged | RED как требуется: T-foreign resolved foreign row вместо 404; после восстановления suite green |
| `SAB-VAPI-IDENTITY-CREDENTIAL` | отключить сравнение callback credential с credential session/resource | `vapiCallIdentity` wrong same-company credential quarantine | RED как требуется: foreign credential получил `ok:true`; после восстановления suite green |
| `SAB-VAPI-CALL-ID-GLOBAL` | вернуть unique `(provider_account_key,vapi_call_id)` | `vapiCallIdentity` DB rejects one id across fragmented account labels | RED как требуется: duplicate row с другим account label вставился; после восстановления suite green |
| `SAB-VAPI-BIND-RETRY` | отключить ранний same-call idempotent return | `vapiCallIdentity` duplicate-after-profile-drift | RED как требуется: retry карантинил связанную session; после восстановления suite green |
| `SAB-VAPI-REGISTRY-COMPANY` | убрать `company_id=$1` из запроса registry profile | `vapiAssistantRegistry` T-own query/company predicate | RED как требуется: exact company predicate исчез; после восстановления suite green |
| `SAB-VAPI-REGISTRY-FALLBACK` | при missing/foreign profile вернуть global assistant и продолжить `POST /call` | `outboundCallService` missing/foreign mapping no-provider-call | RED как требуется: оба deny case сделали provider POST и вернули success; после восстановления suite green |
| `SAB-VAPI-NODE-SIP` | предпочесть tenant `node.config.sip_uri` company resource | `callFlowRuntime.vapi` malicious node config + no-resource fallback | RED как требуется: foreign SIP попал в TwiML и bypass-нул fallback; после восстановления suite green |
| `SAB-VAPI-SCHEMA-DATA-ABORT` | вернуть в migration 275 любой `RAISE EXCEPTION`/data prerequisite | `vapiAssistantRegistryMigration` schema-only empty environment | RED как требуется: временный `provider_connections` prerequisite отверг empty apply с `SABOTAGE_OPERATIONAL_DATA_REQUIRED`; после восстановления 15 suites / 306 tests green |
| `SAB-VAPI-WEBHOOK-CREDENTIAL` | доверять `companyId` body вместо credential | `vapiCallStatusWebhook` wrong-company credential | PENDING |
| `SAB-VAPI-EOC-COMPANY` | ослабить сверку company status credential перед session lookup | `vapiUsageIngest` credential B + local session A | RED как требуется: ожидаемый semantic 403 исчез, запрос дошёл до same-company FK и упал 23503; после восстановления тест green |
| `SAB-VAPI-EOC-IDEMPOTENCY` | добавить random nonce в deterministic sanitized-payload hash | concurrent + sequential duplicate EoC test | RED как требуется: обе concurrent delivery вернули `observationCreated:true`; после восстановления тест green |
| `SAB-VAPI-FSM-INDEPENDENCE` | вернуть ранний 200 при `ingest.correlated=false` | `vapiCallStatusWebhook` usage rejection cannot strand FSM/timeline | RED как требуется: timeline не финализирован и retry не создан; после восстановления targeted тест green |
| `SAB-VAPI-OUTBOUND-REGISTRY-FALLBACK` | снова потребовать active registry profile перед outbound session | `vapiUsageIngest` empty assistant registry outbound EoC | RED как требуется: `correlated:false`, observation/usage потеряны; после восстановления targeted тест green |
| `SAB-VAPI-OUTBOUND-ENV-SOURCE` | вернуть runtime assistant/phone id из env и подменить ими pinned reservation | `outboundCallService` `SAB-T6-ENV` | RED как требуется: foreign env assistant попал в POST; после восстановления targeted test green |
| `SAB-VAPI-OUTBOUND-ATOMIC-BIND` | вернуть отдельный worker UPDATE attempt после provider POST либо retry при bind failure | `outboundCallService` `SAB-T6-ATOMIC` + оба worker `provider_pending` tests | RED как требуется: bind failure потерял `providerPending`; после восстановления targeted test green |
| `SAB-VAPI-PROVISIONING-ALLOWLIST` | разрешить CLI/template variables `prompt`, `model`, webhook/assistant/SIP id | `vapiAgencyProvisioning` `SAB-T7-ALLOWLIST` | RED как требуется: временно разрешённый `model` прошёл normalize вместо fail-closed; после восстановления targeted suite green |
| `SAB-VAPI-PROVISIONING-IDEMPOTENCE` | не искать assistant по durable operation metadata и всегда выполнять create | `vapiAgencyProvisioning` `SAB-T7-IDEMPOTENCE` + lost-response repair | RED как требуется: второй apply создал 6 assistants вместо 3; после восстановления targeted suite green |
| `SAB-VAPI-OVERRIDE` | прокинуть `assistantOverrides` из request/body | provider-contract override rejection test | PENDING |
| `SAB-VAPI-COST-IDEMPOTENCY` | убрать observation/charge unique key | duplicate EoC/poll money test | PENDING |
| `SAB-VAPI-LATE-COST` | считать немедленный одинаковый повтор вторым разнесённым замером | `vapiUsageReconcile` identical immediate poll | RED как требуется: повтор через 30 секунд дал `final` вместо `stable_once`; после восстановления тест green |
| `SAB-VAPI-PROVIDER-ERROR-STABILITY` | увеличивать `stable_count` при provider API failure | `vapiUsageReconcile` provider failure is neither zero nor stability evidence | RED как требуется: outage поднял `stable_count` с 1 до 2; после восстановления тест green |
| `SAB-VAPI-ALERT-DIGEST` | удалить стабильный content fingerprint/unchanged suppression | `vapiUsageAlertDelivery` one due digest covers many alerts and unchanged state never spams again | RED как требуется: неизменная сводка отправилась второй раз; после восстановления suite green |
| `SAB-VAPI-ALERT-THRESHOLD` | заменить немедленную threshold ветку только обычным digest interval | `vapiUsageAlertDelivery` cost above threshold sends before digest window | RED как требуется: `$10.000000000001` вернул `digest_not_due`; после восстановления suite green |
| `SAB-VAPI-FALLBACK-ACTUAL` | разрешить estimate при существующем supplier snapshot либо обновить estimate настоящей ценой | `vapiFallbackRating` supplier-final precedence + append-only correction tests | RED как требуется: при готовом supplier snapshot создалась fallback estimate; после восстановления suite green |
| `SAB-VAPI-FINALITY` | перезаписать settled usage вместо adjustment | post-final provider correction test | PENDING |
| `SAB-VAPI-MONEY-MATH` | преобразовать NUMERIC в JS `Number`/round per call | precision + aggregate rounding test | PENDING |
| `SAB-VAPI-SETTLEMENT-DUP` | изменить wallet idempotency key на retry | crash/retry exactly-once debit test | PENDING |
| `SAB-VAPI-CONCURRENCY` | разделить check и lease insert | parallel tenant/global cap test | PENDING |
| `SAB-VAPI-LEASE-RECOVERY` | не освобождать provider timeout lease | reaper/no-capacity-leak test | PENDING |
| `SAB-VAPI-PROVIDER-HIDDEN` | сериализовать internal usage row tenant API | response allowlist/forbidden-key recursive test | PENDING |
| `SAB-VAPI-CONNECT-SEPARATION` | направить usage charge в Connect ledger | wallet-vs-Connect separation test | PENDING |
| `SAB-VAPI-MCP-PARITY` | сделать MCP отдельный unscoped aggregate | MCP/HTTP parity + T-blast test | PENDING |

Полная ручная/автоматическая матрица: `docs/test-cases/VAPI-AGENCY-001.md`.

## 14. Наблюдаемость и алерты

Минимальные platform-only метрики/алерты:

- unbound provider calls и bind conflicts;
- invalid/quarantined cost, `stale_pending > 24h`, provider cost changed after
  final, reconcile error rate/lag;
- active/reserved leases против company/global caps, expired/reaped leases и
  provider `subscriptionLimits` divergence;
- assistant/resource/template drift, credential expiry/rotation failures;
- settlement retry, wallet idempotency conflict, exact charges versus cents/carry
  reconciliation;
- tenant aggregate totals versus immutable charge/settlement totals.

Доставка использует существующий callback `vapi-usage-reconcile` в
`schedulerRegistry`; отдельного планировщика и изменения `src/server.js` нет.
Каждую минуту он сначала создаёт доступные fallback/correction inputs, затем
проверяет delivery. Обычная сводка настраивается
`VAPI_USAGE_ALERT_DIGEST_INTERVAL_MINUTES` (default `60`). Если текущая известная
неотнесённая/невыставляемая себестоимость строго больше
`VAPI_USAGE_ALERT_THRESHOLD_USD` (default `$10`), изменившаяся сводка отправляется
на ближайшем минутном tick, не ожидая digest window. Получатель задаётся
`VAPI_USAGE_ALERT_RECIPIENT`, default совпадает с `FEEDBACK_INBOX_EMAIL`; sender
company — `VAPI_USAGE_ALERT_SENDER_COMPANY_ID`, default совпадает с feedback.

Первая строка text/HTML письма — exact сумма денежного риска, отдельно её
fallback-estimated часть и число звонков с пока неизвестной стоимостью. Ниже идут разбивка по восьми
типам и ограниченный список provider call/session identifiers. Transcript,
recording, номер телефона, имя, credentials и сырой payload не читаются в email
projection. Одно письмо содержит все изменившиеся unresolved alerts; одинаковая
сводка не отправляется повторно даже после следующего digest interval. Изменение
содержимого или переход выше порога создаёт новый delivery fingerprint.

Логи не содержат credentials, correlation token, full transcript или tenant API
supplier breakdown. Provider ids допустимы только в platform-restricted logs.

## 15. MCP parity

MCP использует тот же company-scoped tenant aggregate service, permission
`tenant.company.manage` и тот же allowlist `{minutes, calls, amount}`; отдельного
SQL/бизнес-правил нет, Vapi/org/provider/supplier поля не выдаются.

## 16. Закрытые решения второго круга

Эти решения окончательны и дополняют §3; вариантов для выбора перед реализацией
не осталось.

### Продуктовые

1. Tenant-метрика `calls` — количество тарифицируемых Vapi AI-ног. Unique Twilio
   conversations тенанту не показываются: это внутренняя группировка Albusto и не
   единица supplier cost или начисления.
2. Звонок относится к subscription period по `session.started_at`. Поздняя
   финализация не переносит consumption в другой период; provider correction после
   закрытия периода становится корректировкой в следующем settlement.
3. Для активного незакрытого периода tenant API возвращает явно промежуточную
   `amount_accrued_to_date` рядом с `period_closed=false`, а не `null` и не поле,
   похожее на сумму к оплате. Пустая текущая сумма читается пользователем как
   неисправность и создаёт предсказуемое обращение в поддержку. Итоговое поле
   `amount_due` появляется только после settlement рядом с `period_closed=true`;
   одновременно два денежных поля не возвращаются.

### Инженерные/финансовые

1. Округление до центов использует одно правило decimal half-away-from-zero,
   включая отрицательные корректировки. Оно одинаково реализуется в PostgreSQL и
   settlement audit и проверяется на большом наборе положительных, отрицательных и
   tie-case значений.
2. Версия pricing policy фиксируется на `admitted_at`. Поздняя provider correction
   использует ту же исходную policy, а не текущую: смена наценки не переписывает
   прошлые начисления.
3. Стартовый минимальный интервал между двумя совпавшими авторитетными замерами —
   5 минут. Стартовое observe-only окно ABC — 48 часов. Оба значения
   конфигурируются без изменения машины состояний.

## 17. Risk register

| Риск | Последствие | Контроль | Тест/сигнал |
|---|---|---|---|
| Общая Vapi org не даёт provider-side hard isolation | Provider/operator error затрагивает несколько tenants | Vapi считается untrusted plane; server-owned registry/resource/credential bindings, per-call gate, least provider access | T-blast registry/webhooks; drift/unbound-call alert |
| Inbound callback потерян или пришёл не по ожидаемому endpoint | AI-нога без identity/cost | Session до SIP, one-time bind, audit provider calls против local sessions | ID-01..ID-11, unbound provider metric |
| Provider schema/ended taxonomy изменились | Cost quarantined либо неверная аналитика | Sanitized contracts, tolerant unknown fields, required-field validation, unknown reason bills positive final cost + alerts | T1 fixtures, MONEY-20/26 |
| Analysis cost дозревает после EoC | Недобиллинг | EoC provisional, two authoritative GET snapshots, 24h stale without debit | MONEY-01/16/25 |
| Duplicate/reordered callbacks и concurrent workers | Двойное observation/charge/debit | Unique identities, append-only observations, state locks, stable idempotency keys | MONEY-02/03/09 |
| JS float либо per-call rounding | Систематическая денежная дельта | NUMERIC/string boundaries, round once, exact carry | MONEY-06..08 |
| Позднее изменение уже settled cost | История переписана либо correction потеряна | Versioned snapshot + immutable adjustment/reversal | MONEY-14/15 |
| Один Twilio parent содержит несколько AI-ног | Нога потеряна при дедупликации по CallSid | Session/Vapi id — billing grain; Twilio SID только correlation | ID-08, MONEY-10/11 |
| Звонок попал на границу billing period | Двойное/пропущенное settlement | Одно утверждённое call-time rule и unique charge/period keys | MONEY-12 |
| POST timeout приводит к повторному вызову | Двойной supplier cost и звонок клиенту | `provider_pending`, repair before retry, provider idempotency contract from T1 | ID-13 |
| Check-then-call race превышает общий/tenant cap | Один tenant выедает линии | Atomic DB admission, leases, heartbeat/reaper | CAP-01..CAP-07 |
| Lease reaper освобождает живой звонок либо оставляет orphan | Oversubscription/вечная блокировка | Provider/session evidence, conservative TTL, idempotent release | CAP-06/07 + lease metrics |
| Supplier fields попадают в tenant HTTP/MCP/log | Раскрытие поставщика и маржи | Separate DTO allowlist, shared aggregate service, restricted logs | API-06, MCP-01..03, OBS-02 |
| Usage попадает в Stripe Connect | Неверный merchant/payment ledger | Единственная wallet projection boundary | MONEY-23/24 |
| История до identity ledger неоднозначна | Придуманные начисления | Backfill только exact unique matches; exception report, no auto-charge | MIG-03/04 |
