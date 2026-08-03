-- AI-GEN-LOG-002: capture what the user actually SAVED after an AI generation,
-- so the owner can analyze the delta (AI proposed -> user corrected).
ALTER TABLE ai_generation_log
    ADD COLUMN IF NOT EXISTS estimate_id      BIGINT,
    ADD COLUMN IF NOT EXISTS invoice_id       BIGINT,
    ADD COLUMN IF NOT EXISTS final_line_items JSONB,
    ADD COLUMN IF NOT EXISTS finalized_at     TIMESTAMPTZ;
