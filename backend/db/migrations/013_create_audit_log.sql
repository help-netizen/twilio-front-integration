-- =============================================================================
-- Migration 013: Create audit_log table
-- Domain event logging for auth, user mgmt, and RBAC actions (§12)
-- Retention: 365 days minimum
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL PRIMARY KEY,
    
    -- Actor
    actor_id    UUID,                       -- crm_users.id (NULL for system events)
    actor_email VARCHAR(255),               -- denormalized for readability
    actor_ip    INET,                       -- client IP
    
    -- Event
    action      VARCHAR(100) NOT NULL,      -- e.g. login_success, role_changed
    target_type VARCHAR(50),                -- e.g. user, session, company
    target_id   VARCHAR(255),               -- e.g. user UUID, session ID
    
    -- Context
    company_id  UUID REFERENCES companies(id),
    details     JSONB NOT NULL DEFAULT '{}', -- action-specific payload
    trace_id    VARCHAR(64),                -- request correlation ID
    
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_company ON audit_log(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_trace ON audit_log(trace_id) WHERE trace_id IS NOT NULL;

COMMENT ON TABLE audit_log IS 'Auth and RBAC audit trail — 365 day retention';

-- ── Allowed actions (documented, not enforced via constraint for flexibility) ──
-- login_success, login_failed, logout
-- refresh_token_used
-- access_denied_403
-- user_created, user_disabled, user_enabled
-- role_changed
-- session_revoked
-- auth_policy_changed
