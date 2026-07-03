-- =============================================================================
-- Migration 153: MAIL-AGENT-002 — the agent only reviews mail that ARRIVES
-- after it was activated.
--
-- Prod fallout of MAIL-AGENT-001: history re-walks funneled months-old letters
-- through linkInboundMessage right after enablement, and the agent dutifully
-- reviewed them (contacts + tasks for stale mail). The gate is the email's own
-- Gmail timestamp vs the activation moment — sync path independent.
--
-- DEFAULT now(): any settings row existing at migration time (prod) gets its
-- activation pinned to the deploy moment — the backlog stops immediately, new
-- mail keeps flowing.
-- =============================================================================

ALTER TABLE mail_agent_settings
    ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
