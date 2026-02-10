-- Migration 009: Create CRM Users shadow table
-- Stores local profile synced from Keycloak IdP

CREATE TABLE IF NOT EXISTS crm_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    keycloak_sub VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255),
    full_name VARCHAR(255),
    role VARCHAR(50) NOT NULL DEFAULT 'viewer',
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_users_email ON crm_users(email);
CREATE INDEX IF NOT EXISTS idx_crm_users_status ON crm_users(status);
