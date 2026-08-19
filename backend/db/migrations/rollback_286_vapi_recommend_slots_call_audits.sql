DROP TABLE IF EXISTS vapi_recommend_slots_call_audits;

-- Preserve any already-created human task while restoring migration 285's
-- narrower decision vocabulary.
UPDATE vapi_inbound_recovery_cases
SET decision_reason = 'missing_open_work',
    updated_at = now()
WHERE state = 'task_created'
  AND decision_reason = 'slot_unavailable';

ALTER TABLE vapi_inbound_recovery_cases
    DROP CONSTRAINT IF EXISTS chk_vapi_inbound_recovery_terminal_shape;

ALTER TABLE vapi_inbound_recovery_cases
    ADD CONSTRAINT chk_vapi_inbound_recovery_terminal_shape CHECK (
        (state = 'task_created' AND decision_reason = 'missing_open_work')
        OR (state = 'skipped' AND task_id IS NULL AND decision_reason IS NOT NULL)
        OR (state IN ('pending', 'retry_pending') AND task_id IS NULL)
    );
