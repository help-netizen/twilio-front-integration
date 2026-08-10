-- Migration 248 — turn App Studio on for ABC Homes (owner request 2026-08-05).
--
-- Migration 247 gave every company an app_studio_enabled flag defaulting to
-- false, so App Studio is now off for everyone. The owner asked for their own
-- company — ABC Homes, the fixed primary tenant at this id — to have it on.
-- Idempotent: a plain UPDATE by id, safe to replay, touches no one else.

UPDATE companies
   SET app_studio_enabled = true,
       updated_at = NOW()
 WHERE id = '00000000-0000-0000-0000-000000000001';
