-- 244_drop_zenbooker_bridge_column.sql
-- ZB-DECOUPLE-001 Phase F5: Zenbooker is fully decommissioned.
--
-- The technician-directory bridge company_user_profiles.zenbooker_team_member_id
-- (added in mig 096, partial-indexed in mig 096/100) has been dormant since Phase E
-- and has NO readers left after Phase F5 — the native-only technician directory
-- removed getZenbookerTeamMemberIdForUser and the legacy roster mode. Drop the
-- dormant column; PostgreSQL drops its dependent partial indexes along with it.
ALTER TABLE company_user_profiles DROP COLUMN IF EXISTS zenbooker_team_member_id;
