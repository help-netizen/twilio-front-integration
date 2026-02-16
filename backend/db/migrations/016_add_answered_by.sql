-- Add answered_by column to track which operator answered the call
ALTER TABLE calls ADD COLUMN IF NOT EXISTS answered_by TEXT;
