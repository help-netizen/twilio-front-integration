-- =============================================================================
-- Rollback 172: remove Rate Me tables and marketplace app.
-- Disconnect the app before rollback because active installations restrict
-- deletion of their marketplace app row.
-- =============================================================================

DROP TABLE IF EXISTS technician_ratings;
DROP TABLE IF EXISTS rate_tokens;
DROP TABLE IF EXISTS rate_me_domains;

DELETE FROM marketplace_apps WHERE app_key = 'rate-me';
