-- =============================================================================
-- Migration 183: recurring per-technician work schedules (TECH-SCHEDULE-001).
--
-- A missing parent row is equivalent to inheriting the company dispatch
-- schedule.  Child rows are deliberately retained when inheritance is enabled
-- so a technician's custom week can be restored later.
-- =============================================================================

CREATE TABLE IF NOT EXISTS technician_work_schedules (
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    technician_id TEXT NOT NULL,
    inherits_company_schedule BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, technician_id)
);

CREATE TABLE IF NOT EXISTS technician_work_schedule_days (
    company_id UUID NOT NULL,
    technician_id TEXT NOT NULL,
    day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    is_working BOOLEAN NOT NULL,
    work_start_time TIME WITHOUT TIME ZONE,
    work_end_time TIME WITHOUT TIME ZONE,
    PRIMARY KEY (company_id, technician_id, day_of_week),
    CONSTRAINT technician_work_schedule_days_schedule_fk
        FOREIGN KEY (company_id, technician_id)
        REFERENCES technician_work_schedules(company_id, technician_id)
        ON DELETE CASCADE,
    CONSTRAINT technician_work_schedule_days_hours_check CHECK (
        (is_working = TRUE
            AND work_start_time IS NOT NULL
            AND work_end_time IS NOT NULL
            AND work_start_time < work_end_time)
        OR
        (is_working = FALSE
            AND work_start_time IS NULL
            AND work_end_time IS NULL)
    )
);
