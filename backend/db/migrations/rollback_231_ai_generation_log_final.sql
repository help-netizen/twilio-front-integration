-- Rollback AI-GEN-LOG-002
ALTER TABLE ai_generation_log
    DROP COLUMN IF EXISTS estimate_id,
    DROP COLUMN IF EXISTS invoice_id,
    DROP COLUMN IF EXISTS final_line_items,
    DROP COLUMN IF EXISTS finalized_at;
