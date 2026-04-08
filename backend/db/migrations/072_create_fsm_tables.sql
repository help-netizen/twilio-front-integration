-- =============================================================================
-- Migration 072: Create FSM (Finite State Machine) tables
-- Tables for managing state machine definitions, versions, and audit log
-- =============================================================================

-- 1. fsm_machines — registered state machine definitions per company
CREATE TABLE IF NOT EXISTS fsm_machines (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    machine_key         VARCHAR(50) NOT NULL,
    company_id          UUID NOT NULL REFERENCES companies(id),
    title               VARCHAR(200),
    description         TEXT,
    active_version_id   UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(company_id, machine_key)
);

-- 2. fsm_versions — immutable snapshots of a machine's SCXML definition
CREATE TABLE IF NOT EXISTS fsm_versions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    machine_id          UUID NOT NULL REFERENCES fsm_machines(id) ON DELETE CASCADE,
    company_id          UUID NOT NULL REFERENCES companies(id),
    version_number      INT NOT NULL DEFAULT 1,
    status              VARCHAR(20) NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'archived')),
    scxml_source        TEXT NOT NULL,
    change_note         TEXT,
    created_by          VARCHAR(200),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_by        VARCHAR(200),
    published_at        TIMESTAMPTZ
);

-- 3. Add FK from fsm_machines.active_version_id -> fsm_versions.id
--    (deferred because fsm_versions must exist first)
ALTER TABLE fsm_machines
    ADD CONSTRAINT fk_fsm_machines_active_version
    FOREIGN KEY (active_version_id) REFERENCES fsm_versions(id);

-- 4. fsm_audit_log — append-only log of all FSM admin actions
CREATE TABLE IF NOT EXISTS fsm_audit_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          UUID NOT NULL,
    machine_key         VARCHAR(50) NOT NULL,
    version_id          UUID,
    actor_id            VARCHAR(200),
    actor_email         VARCHAR(200),
    action              VARCHAR(50) NOT NULL,
    payload_json        JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes: fsm_machines
CREATE INDEX IF NOT EXISTS idx_fsm_machines_company
    ON fsm_machines(company_id);

-- Indexes: fsm_versions
CREATE INDEX IF NOT EXISTS idx_fsm_versions_machine
    ON fsm_versions(machine_id);

CREATE INDEX IF NOT EXISTS idx_fsm_versions_company
    ON fsm_versions(company_id);

CREATE INDEX IF NOT EXISTS idx_fsm_versions_status
    ON fsm_versions(status);

-- Indexes: fsm_audit_log
CREATE INDEX IF NOT EXISTS idx_fsm_audit_company
    ON fsm_audit_log(company_id);

CREATE INDEX IF NOT EXISTS idx_fsm_audit_machine
    ON fsm_audit_log(machine_key);

CREATE INDEX IF NOT EXISTS idx_fsm_audit_created
    ON fsm_audit_log(created_at);

COMMENT ON TABLE fsm_machines  IS 'FSM: Registered state machine definitions per company';
COMMENT ON TABLE fsm_versions  IS 'FSM: Immutable versioned snapshots of machine SCXML definitions';
COMMENT ON TABLE fsm_audit_log IS 'FSM: Append-only audit log of all admin actions';
