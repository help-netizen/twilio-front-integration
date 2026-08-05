-- Migration 239 — APP-STUDIO-GATE-002: per-company App Studio availability.

ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS app_studio_enabled BOOLEAN NOT NULL DEFAULT false;
