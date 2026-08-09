# STAGING-ENV-001 — staging-стенд на Mac mini

**Статус:** LIVE (2026-08-09). **Хост:** Mac mini `kurai@100.78.119.41` (Tailscale, ssh-алиас `mini`).
**Назначение:** предпрод-среда — master копится и проверяется здесь (в т.ч. будущими Selenium-тестами), в прод уходит только после проверки.

## Новый деплой-флоу

```
commit → push origin master
              │
              ▼  (авто, ≤10 мин, LaunchAgent на mini)
        STAGING на mini  ←──  здесь смотрим/тестируем
              │
              ▼  (ТОЛЬКО по явному «Деплой» владельца)
        PROD (Vultr, runbook в prod-deploy-procedure)
```

Прод-процедура не изменилась. Изменилось одно: **перед прод-деплоем проверяй `state/status` стейджа** — если RED, в прод не выкатывать.

## URL-ы (Tailscale, только внутри тейлнета)

| Что | URL |
|---|---|
| Приложение (app+api, same-origin) | https://kurais-mac-mini.taile2152e.ts.net |
| Keycloak | https://kurais-mac-mini.taile2152e.ts.net:8443 |
| MinIO S3 (presigned) | https://kurais-mac-mini.taile2152e.ts.net:9443 |

TLS терминирует `tailscale serve` (сертификаты ts.net) и проксирует на локальные порты: 443→3200 (app), 8443→8091 (KC), 9443→9100 (MinIO). **Требование:** в админке Tailscale включён HTTPS Certificates (login.tailscale.com/admin/dns). Если mappings слетели: `~/albusto-staging/bin/enable-serve.sh`.

Логины/пароли — **те же, что на проде**: Keycloak приезжает вместе с дампом БД (KC живёт в той же базе `albusto`), сабы юзеров сохраняются, RBAC-связки работают.

## Устройство

```
~/albusto-staging/
├── docker-compose.yml      # стек: postgres(5433) app(3200) keycloak(8091) slot-engine minio(9100/9101)
├── .env                    # САНИРОВАННАЯ копия прод-.env (см. ниже)
├── .env.prod-copy          # исходник (chmod 600), для повторной санации
├── app/                    # git-чекаут master (auto-reset — руками не править!)
├── bin/
│   ├── staging-deploy.sh   # автодеплой (LaunchAgent каждые 10 мин)
│   ├── sanitize-env.sh     # .env.prod-copy → .env
│   └── enable-serve.sh     # восстановить tailscale serve mappings
└── state/
    ├── sha                 # задеплоенный SHA
    ├── status              # "GREEN <sha> <ts>" | "RED <причина>"
    ├── migration-floor     # применённые миграции ≤ этого номера (init: 243)
    └── deploy.log          # журнал автодеплоев
```

Docker = colima (VM 4cpu/4GiB/15GiB, автостарт `brew services start colima`). Compose-проект `albusto-staging`.

## Что ОБЕЗВРЕЖЕНО (staging не трогает внешний мир)

- **Пустые креды:** Twilio (все), VAPI, Stripe (secret+webhooks; publishable в билде пустой → карточные флоу выключены), Zenbooker, Gmail push, Google Ads, eLocal, Front, Workiz, AssemblyAI, Gemini, VAPID (web-push), Rely, app-runner.
- **Ротированы ключи шифрования** `EMAIL_TOKEN_ENCRYPTION_KEY`, `GOOGLE_ADS_TOKEN_ENCRYPTION_KEY` → OAuth-токены из прод-копии БД **нерасшифруемы** (почтовый синк и Ads падают безопасно).
- **Выключены флаги:** `FEATURE_ZENBOOKER_SYNC`, `FEATURE_AGENT_WORKER`, `FEATURE_OUTBOUND_CALL_WORKER`, `FEATURE_REALTIME_TRANSCRIPTION`, `FEATURE_SMS_2FA` (иначе логин упрётся в неотправляемый код), `APP_STUDIO_ENABLED`, `YELP_*`; `EMAIL_SYNC_INTERVAL_MS=86400000`.
- **Хосты переписаны**: `app/api/auth/storage.albusto.com` → тейлнет-URL-ы (включая `KEYCLOAK_REALM_URL`, `GOOGLE_REDIRECT_URI`, `PUBLIC_APP_URL`).
- **Хранилище** — свой MinIO-контейнер, бакет `albusto-staging` (прод-файлы недоступны; вложения из прод-БД будут 404 — ок).

⚠️ Новые опасные env-переменные в проде = **добавить правило в `bin/sanitize-env.sh`** и пересанировать.

## Автодеплой (staging-deploy.sh)

Каждые 10 минут: `fetch origin/master` → новый SHA? → `reset --hard` → **авто-применение новых миграций** (номер > `migration-floor`, по одной, `ON_ERROR_STOP`; упавшая миграция = RED и стоп — ловим ДО прода) → `compose build app slot-engine` → `up -d` → health-poll :3200 → `state/sha`+`GREEN`, иначе `RED`.

Проверить статус: `ssh mini cat albusto-staging/state/status`
Журнал: `ssh mini tail -20 albusto-staging/state/deploy.log`
Форс-прогон: `ssh mini albusto-staging/bin/staging-deploy.sh`

**Каверза renumber-а:** если миграцию переименовали в номер ≤ floor (коллизии параллельных сессий — см. prod-deploy-procedure), floor её пропустит. Лечение: `echo <меньший_номер> > state/migration-floor` и форс-прогон.

## Обновление данных с прода (по желанию, ~5 мин)

```bash
# 1) свежий дамп прода → mini
ssh deploy@108.61.87.117 'cd /opt/albusto && docker compose exec -T postgres pg_dump -U albusto -Fc albusto' \
  | ssh mini 'cat > ~/albusto-staging/seed.dump'
# 2) пересоздать БД и восстановить (staging-стек можно не гасить, но чище погасить app)
ssh mini 'export PATH=/opt/homebrew/bin:$PATH; cd ~/albusto-staging && \
  docker compose stop app keycloak && \
  docker compose exec -T postgres psql -U albusto -d postgres -c "DROP DATABASE albusto WITH (FORCE)" && \
  docker compose exec -T postgres psql -U albusto -d postgres -c "CREATE DATABASE albusto OWNER albusto" && \
  docker compose exec -T postgres pg_restore -U albusto -d albusto --no-owner < seed.dump && \
  ls app/backend/db/migrations/*.sql | grep -oE "[0-9]+" | sort -n | tail -1 > state/migration-floor && \
  docker compose start keycloak app'
```
После рефреша KC-redirect-URI staging-origin уже в дампе НЕ живёт (он добавлялся руками) — **повторить kcadm-добавление** `https://kurais-mac-mini.taile2152e.ts.net/*` в `crm-web` (см. Verification ниже) либо прогнать `bin/enable-serve.sh`-соседний сниппет из этого файла.

## Verification (выполнено 2026-08-09)

- Рестор дампа: exit 0, 0 ошибок; 1628 jobs, 18 KC-юзеров.
- `GET /health` → 200; `GET /api/jobs` без токена → 401; FE-бандл отдаётся.
- Логи app: 0 попыток наружу (только баннер и «Zenbooker cron: stub»).
- MinIO: бакет `albusto-staging` создан.
- KC: `crm-web` содержит staging redirect/webOrigin (прод-записи не тронуты).
- LaunchAgent `com.albusto.staging-deploy` загружен, первый тик — no-op (SHA совпал).
- Диск mini: чистка Xcode (DerivedData + старые архивы, свежий сохранён) 9.8→29GB свободно.

## Ограничения v1

- Всё, что требует внешних сервисов, на staging мертво по дизайну: SMS/звонки, платежи, ZB-синк, почта, пуши, Google Ads, AI-фичи (Gemini пуст). Тестировать здесь UI/CRUD/RBAC/FSM/финансы-без-charge.
- App Studio выключен (runner отсутствует).
- Prod-вложения (фото и т.п.) — битые ссылки (чужой бакет остался в прод-МинИО).
- Карты — если ключ Google ограничен доменом прода, на staging тихий fallback.
