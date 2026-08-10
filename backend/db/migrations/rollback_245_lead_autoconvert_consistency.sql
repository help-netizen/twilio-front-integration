-- rollback_245_lead_autoconvert_consistency.sql
-- The data repair is intentionally not reversed: restoring stale status/boolean
-- values or unlinking historical Jobs would reintroduce the production defect.

ALTER TABLE leads
    DROP CONSTRAINT IF EXISTS chk_leads_conversion_consistency;

DELETE FROM audit_log
WHERE action IN ('lead.converted', 'lead.status_changed')
  AND details->>'actor_type' = 'system'
  AND details->>'actor_label' = 'Lead auto-convert backfill';
