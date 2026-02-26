-- =============================================================================
-- 037: Add Action Required + Snooze + Owner fields to timelines
-- Supports "Action Required" state independent of "Unread".
-- =============================================================================

-- Action Required flag & metadata
ALTER TABLE timelines ADD COLUMN IF NOT EXISTS is_action_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE timelines ADD COLUMN IF NOT EXISTS action_required_reason TEXT;
ALTER TABLE timelines ADD COLUMN IF NOT EXISTS action_required_set_at TIMESTAMPTZ;
ALTER TABLE timelines ADD COLUMN IF NOT EXISTS action_required_set_by TEXT;

-- Snooze support
ALTER TABLE timelines ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;

-- Owner assignment
ALTER TABLE timelines ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES crm_users(id) ON DELETE SET NULL;

-- Partial index: only action_required timelines (used for sorting + scheduler)
CREATE INDEX IF NOT EXISTS idx_timelines_action_required
  ON timelines(is_action_required, snoozed_until, action_required_set_at DESC)
  WHERE is_action_required = true;

CREATE INDEX IF NOT EXISTS idx_timelines_snoozed
  ON timelines(snoozed_until)
  WHERE snoozed_until IS NOT NULL AND is_action_required = true;

COMMENT ON COLUMN timelines.is_action_required IS 'Whether this thread requires dispatcher action';
COMMENT ON COLUMN timelines.action_required_reason IS 'Why action is required: new_message, manual, etc.';
COMMENT ON COLUMN timelines.snoozed_until IS 'If set, thread is hidden from AR queue until this time';
COMMENT ON COLUMN timelines.owner_user_id IS 'Assigned owner (dispatcher) for this thread';
