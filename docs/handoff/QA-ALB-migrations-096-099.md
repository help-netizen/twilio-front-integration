# QA Handoff — миграции 096–099 (Albusto / ALB-100, ALB-107)

> Инструкция для стороннего QA-агента. **Только тестирование и отчёт.**
> Разработка, фиксы, рефакторинг, изменения файлов репозитория — ЗАПРЕЩЕНЫ.

```yaml
qa_handoff:
  id: QA-ALB-MIG-096-099
  date: 2026-06-13
  requester: Albusto platform team
  mode: read-only-audit          # агент НЕ меняет код и НЕ чинит найденное

  repo:
    path_hint: "ветка claude/distracted-pascal-b65258 (или выданный архив)"
    runtime: "Node 20+, PostgreSQL 17 (docker: postgres:17)"

  scope:
    migrations_under_test:
      - backend/db/migrations/096_pf007_provider_scope_hardening.sql
      - backend/db/migrations/097_alb101_signup_otp_trusted_devices.sql
      - backend/db/migrations/098_alb107_company_telephony.sql
      - backend/db/migrations/099_alb107_phase2_softphone_a2p.sql
    related_consumers:            # читать для контекста, НЕ менять
      - backend/src/db/membershipQueries.js          # resolveProviderUserIds (096)
      - backend/src/services/jobsService.js          # assigned_provider_user_ids mirror (096)
      - backend/src/services/otpService.js           # phone_otp, trusted_devices (097)
      - backend/src/services/platformCompanyService.js  # companies geo bootstrap (097)
      - backend/src/services/telephonyTenantService.js  # company_telephony (098/099)
      - backend/src/services/a2pService.js           # company_a2p_registrations (099)
    out_of_scope:
      - продовая БД и любые удалённые хосты (доступа нет и не запрашивать)
      - миграции 001–095 (кроме как baseline)
      - frontend, деплой, Twilio/Keycloak live-вызовы

  baseline:
    schema_snapshot: backend/db/test-fixtures/schema_pre_096.sql
    note: >
      Снапшот = точное состояние прод-схемы ПЕРЕД 096 (schema-only, без данных
      и секретов). Это основной baseline. Дополнительный путь — полная цепочка
      001→095 через apply_migrations.js (известная особенность: раннер глотает
      ошибки — оценить отдельно, см. чек-лист).

  environment_setup: |
    docker run -d --name qa-mig -e POSTGRES_PASSWORD=qa -e POSTGRES_DB=qa -p 55432:5432 postgres:17
    psql postgresql://postgres:qa@localhost:55432/qa -v ON_ERROR_STOP=1 -f backend/db/test-fixtures/schema_pre_096.sql
    # затем по очереди 096 → 097 → 098 → 099 (каждую дважды — идемпотентность)

  deliverable:
    file: QA-REPORT-ALB-MIG-096-099.md   # единственный артефакт; код не трогать
    finding_schema:                       # каждая находка в YAML-блоке отчёта
      id: "MIG-NNN"
      severity: blocker | major | minor | info
      type: bug | data-risk | perf | idempotency | security | improvement | question
      migration: "096|097|098|099|runner|baseline"
      location: "файл:строка или имя объекта БД"
      repro: "точные SQL/команды для воспроизведения"
      expected: "..."
      actual: "..."
      suggestion: "опционально — как улучшить (НЕ применять самому)"
    summary_required:
      - вердикт по каждой миграции: safe-to-deploy / deploy-with-notes / blocked
      - таблица: миграция × (fresh-run, re-run, downgrade-замечания)
      - открытые вопросы команде

  hard_rules:
    - НЕ редактировать ни один файл репозитория; единственный output — отчёт
    - НЕ выполнять INSERT/UPDATE в чём-либо кроме своей одноразовой docker-БД
    - НЕ запускать сетевые вызовы к Twilio/Keycloak/Google (env не выдаются)
    - найденные баги НЕ чинить — только задокументировать с repro
    - при сомнении в безопасности команды — записать как question, не выполнять
```

---

## Методика тестирования (обязательная программа)

### 1. Чистое применение и идемпотентность (на каждую из 4)
1. Применить на baseline → `ON_ERROR_STOP=1`, зафиксировать вывод.
2. Применить **повторно** — должна пройти без ошибок (допустимы NOTICE
   "already exists"). Любая ошибка второго прогона = `idempotency`-находка.
3. `\d` затронутых таблиц до/после: колонки, типы, дефолты, NULL-ность,
   индексы, констрейнты, комментарии — сверить с текстом миграции.

### 2. Семантика данных (фикстуры готовить самостоятельно)
- **096 (backfill зеркала):** создать 2 компании; джобы с `assigned_techs`
  где id техника (a) замаплен в той же компании, (b) замаплен в ЧУЖОЙ
  компании, (c) не замаплен, (d) `assigned_techs` = `null` / не-массив /
  `[{}]` без id. Прогнать backfill-UPDATE из миграции. Ожидание: только (a)
  попадает в `assigned_provider_user_ids`; кросс-компания НИКОГДА.
- **096:** membership со status='inactive' не должен давать видимость.
- **097:** `phone_otp` CHECK на purpose; `trusted_devices` UNIQUE по
  device_id_hash — проверить конфликт; FK CASCADE при удалении crm_users.
- **098:** `company_telephony` CHECK по status; UNIQUE subaccount_sid;
  поведение `phone_number_settings` при повторной вставке того же номера.
- **099:** все значения CHECK-списка статусов A2P вставляются; недопустимый —
  отклоняется.

### 3. Целостность цепочки
- Полный прогон `apply_migrations.js` на ПУСТОЙ БД (v3_schema → 001→099):
  завершилось ли 096–099 успешно; что молча проглотил раннер (это
  `data-risk`-находки против runner).
- Порядок: 097 без 096, 099 без 098 — падают ли осмысленно?

### 4. Производительность и блокировки
- На baseline-схеме оценить классы блокировок каждой DDL (ACCESS EXCLUSIVE
  и т.п.) и риск для живого прода (backfill 096 — UPDATE по всей jobs:
  оценить план на 100k синтетических строк, длительность, lock-окно).
- Индексы: не дублируют ли существующие; GIN на jsonb — оценить полезность
  для `@>`-запросов из консьюмеров.

### 5. Безопасность/схема
- Нет ли случайных GRANT/owner-изменений из снапшота.
- Колонки с секретами (`*_enc`, `code_hash`) — отсутствие plaintext-дефолтов.
- Комментарии к колонкам соответствуют фактическому поведению консьюмеров
  (читать перечисленные сервисы, расхождение = `bug` или `question`).

### 6. Что НЕ делать
Не чинить, не оптимизировать, не переписывать SQL, не коммитить, не трогать
файлы вне своего отчёта, не подключаться к чему-либо кроме своей docker-БД.

## Формат сдачи
Один файл `QA-REPORT-ALB-MIG-096-099.md`: сводная таблица вердиктов сверху,
далее находки по `finding_schema` (каждая — отдельный YAML-блок + прозой
контекст), в конце — улучшения и вопросы. Пустых разделов не оставлять:
если находок нет — явно написать «не обнаружено» с описанием выполненных
проверок.
