-- =============================================================================
-- Migration 150: MOBILE-TECH-APP-001 / MTECH-T2 — device_tokens (APNs device
-- registry for the native mobile push path; spec §3.7, §4.2, §8.T2, C9/C13).
--
-- Ground truth (spec §0 G5): the app has ONLY Web Push today (VAPID,
-- push_subscriptions) + browser-only SSE — no APNs, no FCM, no device-token
-- table. This table is the from-scratch APNs registry the native iOS client
-- writes to on login / cold-start / token rotation (POST /api/devices) and
-- clears on logout (DELETE /api/devices/:token). pushService resolves rows by
-- (company_id, crm_user_id) and delivers APNs alerts for job_assigned /
-- job_rescheduled events.
--
-- Columns:
--   company_id    UUID  — tenant isolation. Every push resolve is company-scoped;
--                         mirrors req.authz.company.id (G6). Rebound on handoff.
--   crm_user_id   UUID  — owning provider (crm_users.id). Pushes are targeted per
--                         user; a device with no crm_user is meaningless (route
--                         returns 409 NO_CRM_USER before any insert).
--   apns_token    TEXT  — the APNs device token; UNIQUE so a physical device maps
--                         to exactly one row. On device handoff (a different user
--                         signs in on the same hardware) POST re-binds owner via
--                         ON CONFLICT (apns_token) — no duplicate row (spec C9/C13).
--   platform      TEXT  — 'ios' for v1 (kept generic for a future 'android'/FCM).
--   app_version   TEXT  — client build (diagnostics; optional).
--   device_model  TEXT  — hardware model (diagnostics; optional).
--   last_seen_at  TIMESTAMPTZ — bumped on every re-register (cold-start heartbeat).
--   created_at    TIMESTAMPTZ — first registration.
--
-- UNIQUE (apns_token) makes the register idempotent (ON CONFLICT DO UPDATE) and
-- guarantees one row per device. Index (company_id, crm_user_id) supports the
-- pushService fan-out (SELECT ... WHERE company_id=$c AND crm_user_id=$u).
-- A stale token surfaces at send time as an APNs 410 Unregistered → pushService
-- deletes that row (spec C9); no schema support needed for that.
--
-- Additive, idempotent (IF NOT EXISTS), touches no existing data. Reversible via
-- rollback_150_device_tokens.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS device_tokens (
    id            BIGSERIAL   PRIMARY KEY,
    company_id    UUID        NOT NULL,
    crm_user_id   UUID        NOT NULL,
    apns_token    TEXT        NOT NULL UNIQUE,
    platform      TEXT        NOT NULL DEFAULT 'ios',
    app_version   TEXT,
    device_model  TEXT,
    last_seen_at  TIMESTAMPTZ DEFAULT now(),
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_company_user
    ON device_tokens (company_id, crm_user_id);
