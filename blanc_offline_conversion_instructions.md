# Blanc — Offline Conversion Import: GCLID + amount_paid

## Контекст

Rely Lead Processor (prices) теперь извлекает Google Click ID (`gclid`) из URL страницы при создании лида через веб-форму сайта и передаёт его в payload `POST /api/v1/integrations/leads`. Этот GCLID нужен для загрузки offline конверсий обратно в Google Ads — чтобы Google знал, какой клик по рекламе привёл к реальной оплате.

Также для расчёта ROAS нужна фактически оплаченная сумма (`amount_paid`), а не только `invoice_total`.

---

## Задача 1: Принять и сохранить `gclid` при создании лида

### 1.1 Миграция БД

```sql
-- Миграция: add_gclid_to_leads
ALTER TABLE leads ADD COLUMN gclid TEXT;

-- Индекс для быстрого поиска лидов с gclid (для offline conversion pipeline)
CREATE INDEX idx_leads_gclid ON leads(gclid) WHERE gclid IS NOT NULL;

COMMENT ON COLUMN leads.gclid IS 'Google Click ID (gclid) — extracted from pageUrl by rely-lead-processor for offline conversion tracking in Google Ads';
```

### 1.2 Обработка в `POST /api/v1/integrations/leads`

Rely Lead Processor уже отправляет поле `gclid` в payload. Пример payload:

```json
{
  "FirstName": "John",
  "LastName": "Smith",
  "Phone": "6175006181",
  "JobType": "COD Service",
  "JobSource": "Web site order",
  "Address": "123 Main St",
  "City": "Boston",
  "State": "MA",
  "PostalCode": "02108",
  "Description": "Refrigerator not cooling",
  "gclid": "CjwKCAjw7p6aBhAlEiwAXbR8..."
}
```

**Что сделать:**
- При получении `gclid` в payload — сохранить в `leads.gclid`
- Поле необязательное — если `gclid` отсутствует или `null`, лид создаётся как обычно
- GCLID приходит только для `JobSource = "Web site order"` (заявки с сайта)

---

## Задача 2: Вернуть `gclid` в Analytics API

### Endpoint: `GET /api/v1/integrations/analytics/leads`

Добавить поле `gclid` в ответ. Текущий формат:

```json
{
  "items": [
    {
      "id": "592",
      "first_name": "John",
      "last_name": "Smith",
      "job_source": "Web site order",
      "converted_to_job": true,
      "lead_lost": false,
      ...
    }
  ]
}
```

**Нужный формат (добавить `gclid`):**

```json
{
  "items": [
    {
      "id": "592",
      "first_name": "John",
      "last_name": "Smith",
      "job_source": "Web site order",
      "converted_to_job": true,
      "lead_lost": false,
      "gclid": "CjwKCAjw7p6aBhAlEiwAXbR8...",
      ...
    }
  ]
}
```

**Фильтрация:** Было бы полезно поддержать фильтр по наличию gclid:
```
GET /api/v1/integrations/analytics/leads?has_gclid=true
```
Это вернёт только лиды с непустым gclid — для pipeline offline conversion upload.

---

## Задача 3: Добавить `amount_paid` в Jobs API

### Endpoint: `GET /api/v1/integrations/analytics/jobs`

Текущий формат:

```json
{
  "items": [
    {
      "id": "648",
      "job_number": "768223",
      "invoice_total": "399.45",
      "invoice_status": "paid",
      "lead_id": "533",
      ...
    }
  ]
}
```

**Нужный формат (добавить `amount_paid`):**

```json
{
  "items": [
    {
      "id": "648",
      "job_number": "768223",
      "invoice_total": "399.45",
      "invoice_status": "paid",
      "amount_paid": "399.45",
      "lead_id": "533",
      ...
    }
  ]
}
```

**Логика `amount_paid`:**
- Для `invoice_status = "paid"` → `amount_paid = invoice_total`
- Для `invoice_status = "partially_paid"` → `amount_paid` = фактически полученная сумма (из Zenbooker payments или аналогичного источника)
- Для `invoice_status = "draft"` → `amount_paid = 0` или `null`
- Тип: строка (как `invoice_total`) или число — на усмотрение

---

## Зачем это нужно

Pipeline работает так:

```
1. Пользователь кликает рекламу Google Ads → попадает на сайт с ?gclid=ABC
2. Заполняет форму → rely-lead-processor извлекает gclid → отправляет в Blanc
3. Blanc сохраняет лид с gclid=ABC
4. Лид конвертируется в работу → работа оплачена
5. Daily cron (prices бот) запрашивает у Blanc:
   - GET /analytics/leads?has_gclid=true&converted_to_job=true
   - GET /analytics/jobs?lead_id=X (с amount_paid)
6. Загружает в Google Ads API:
   - gclid=ABC, conversion_value=$399.45, conversion_date=2026-04-23
7. Google Ads знает: "этот клик по рекламе принёс $399 дохода"
   → Smart Bidding обучается показывать рекламу похожим пользователям
```

---

## Приоритет

1. **Задача 1** (gclid в leads) — обязательно, без этого pipeline не работает
2. **Задача 2** (gclid в analytics) — обязательно, для чтения данных pipeline'ом
3. **Задача 3** (amount_paid) — важно для точности ROAS, но можно использовать `invoice_total` как fallback

---

## Тестирование

После реализации можно проверить:

```bash
# 1. Создать лид с gclid
curl -X POST https://abc-metrics.fly.dev/api/v1/integrations/leads \
  -H "X-BLANC-API-KEY: <key>" \
  -H "X-BLANC-API-SECRET: <secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "FirstName": "Test",
    "LastName": "GCLID",
    "Phone": "5550001111",
    "JobType": "COD Service",
    "JobSource": "Web site order",
    "gclid": "test_gclid_12345"
  }'

# 2. Проверить что gclid вернулся
curl "https://abc-metrics.fly.dev/api/v1/integrations/analytics/leads?has_gclid=true&limit=5" \
  -H "X-BLANC-API-KEY: blanc_ana_<key>" \
  -H "X-BLANC-API-SECRET: <secret>"

# 3. Проверить amount_paid в jobs
curl "https://abc-metrics.fly.dev/api/v1/integrations/analytics/jobs?limit=5" \
  -H "X-BLANC-API-KEY: blanc_ana_<key>" \
  -H "X-BLANC-API-SECRET: <secret>"
```
