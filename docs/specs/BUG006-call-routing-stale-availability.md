# Спецификация: BUG006 — Исправление маршрутизации входящих звонков (stale availability)

## Общее описание

Входящие звонки ошибочно направляются на войсмейл, когда все операторы свободны. Причина — "зависшие" записи в таблице `calls` (`is_final = false`, `status IN ('ringing', 'in-progress')`) заставляют систему считать операторов занятыми. Исправление добавляет 4 защитных слоя.

## Сценарии поведения

### Сценарий 1: Happy path — операторы свободны, нет stale записей
- **Предусловия:** Нет активных звонков в таблице `calls`
- **Шаги:**
  1. Twilio вызывает `handleVoiceInbound()`
  2. SQL-запрос проверки занятости возвращает пустой набор
  3. `allBusy = false` → звонок маршрутизируется к свободным операторам
- **Ожидаемый результат:** `<Dial>` с `<Client>` endpoints для всех операторов
- **Изменения:** Нет — happy path не затронут

### Сценарий 2: Stale запись с ringing > 90 сек
- **Предусловия:** В таблице `calls` есть запись `status='ringing', is_final=false, started_at < NOW() - 90s`
- **Шаги:**
  1. SQL-запрос проверки занятости **исключает** записи с `ringing` старше 90 секунд
  2. Оператор не считается занятым
- **Ожидаемый результат:** Звонок маршрутизируется к оператору

### Сценарий 3: Все операторы "заняты" по БД → Twilio API fallback
- **Предусловия:** SQL показывает all busy, но звонки на самом деле завершены
- **Шаги:**
  1. SQL-запрос показывает `allBusy = true`
  2. Система вызывает Twilio REST API для каждого "busy" call_sid
  3. Twilio API возвращает `completed` / `no-answer` → запись обновляется в БД
  4. Пересчитывается `allBusy` с актуальными данными
- **Ожидаемый результат:** Если реально все свободны → маршрутизация, не войсмейл

### Сценарий 4: dial-action финализирует child legs
- **Предусловия:** `<Dial>` с 3 `<Client>` — один ответил, два не ответили
- **Шаги:**
  1. Twilio вызывает `handleDialAction()` с `DialCallStatus`
  2. Система находит все child legs для `parentCallSid`
  3. Все non-final child legs обновляются: `is_final = true`
- **Ожидаемый результат:** Child legs не блокируют будущую маршрутизацию

## Граничные случаи

1. Twilio API недоступен → логируем warning, fallback на текущую логику (hold loop / voicemail)
2. Twilio API rate limit → try/catch, не ломаем основной flow
3. dial-action приходит раньше, чем child legs созданы в БД → UPDATE затронет 0 строк, это нормально
4. Параллельные входящие звонки → каждый проверяет availability независимо, age filter не зависит от порядка

## Обработка ошибок

1. `twilio.calls(sid).fetch()` throws → catch, log warning, keep DB-based decision
2. DB query fails during availability check → ring all operators (current fallback behavior preserved)

## Файлы для изменений

| Файл | Что меняется |
|------|-------------|
| `backend/src/webhooks/twilioWebhooks.js` | Age filter в SQL-запросе занятости (client + SIP), Twilio API fallback при allBusy, финализация child legs в handleDialAction |
| `backend/src/services/reconcileStale.js` | `STALE_THRESHOLD_MINUTES: 10 → 3` |
