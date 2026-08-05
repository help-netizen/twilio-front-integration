-- Rollback 240 — turn App Studio back off for ABC Homes.

UPDATE companies
   SET app_studio_enabled = false,
       updated_at = NOW()
 WHERE id = '00000000-0000-0000-0000-000000000001';
