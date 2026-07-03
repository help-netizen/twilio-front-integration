-- =============================================================================
-- Migration 149: PULSE-PERF-001 — expression-индексы contacts по цифрам телефона
--
-- GET /api/calls/by-contact (getUnifiedTimelinePage) занимал ~8.5s на страницу:
-- EXPLAIN ANALYZE на проде показал, что 98% времени — SubPlan orphan-dedup'а
-- (NOT EXISTS): на КАЖДЫЙ контактлесс-таймлайн (1355 шт) выполнялся Seq Scan
-- по contacts (3261 строк) с двумя regexp_replace на строку — ~4.4 млн regex-
-- вычислений на один запрос страницы.
--
-- Индексы — ЧИСТО по выражению (без company_id: в EXISTS-подзапросе у contacts
-- нет прямого предиката компании — она фильтруется через join к timelines, так
-- что составной (company_id, expr) планировщик применить не смог бы). Выражение
-- В ТОЧНОСТИ повторяет предикат запроса, иначе индекс не подхватится:
--     NULLIF(regexp_replace(<col>, '\D', '', 'g'), '')
-- OR из двух сравнений становится BitmapOr двух index-lookup'ов на орфан.
--
-- Аддитивно, идемпотентно (IF NOT EXISTS), данных не трогает.
-- Откат: rollback_149_contacts_phone_digits_index.sql.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_contacts_phone_digits
  ON contacts ((NULLIF(regexp_replace(phone_e164, '\D', '', 'g'), '')));

CREATE INDEX IF NOT EXISTS idx_contacts_secondary_phone_digits
  ON contacts ((NULLIF(regexp_replace(secondary_phone, '\D', '', 'g'), '')));

COMMENT ON INDEX idx_contacts_phone_digits IS 'PULSE-PERF-001: orphan-dedup lookup по цифрам primary-телефона';
COMMENT ON INDEX idx_contacts_secondary_phone_digits IS 'PULSE-PERF-001: orphan-dedup lookup по цифрам secondary-телефона';
