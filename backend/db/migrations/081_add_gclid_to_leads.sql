-- =============================================================================
-- Migration 081: Add gclid (Google Click ID) column to leads
--
-- gclid is extracted from the lead form's pageUrl by rely-lead-processor and
-- stored on the lead so that the daily offline-conversion uploader can attribute
-- paid jobs back to the original Google Ads click. Optional — only website
-- leads ('Web site order') currently carry it.
-- =============================================================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS gclid TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_gclid ON leads(gclid) WHERE gclid IS NOT NULL;

COMMENT ON COLUMN leads.gclid IS
    'Google Click ID (gclid) — extracted from pageUrl by rely-lead-processor for offline conversion tracking in Google Ads';
