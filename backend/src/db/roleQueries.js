/**
 * Role Queries — PF007
 * 
 * Data access for company_role_configs, company_role_permissions,
 * company_role_scopes tables.
 */

const db = require('./connection');

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

/**
 * Get all role configs for a company.
 */
async function listRoleConfigs(companyId) {
    const { rows } = await db.query(
        `SELECT id, company_id, role_key, display_name, description, is_locked,
                created_at, updated_at
         FROM company_role_configs
         WHERE company_id = $1
         ORDER BY CASE role_key
             WHEN 'tenant_admin' THEN 1
             WHEN 'manager' THEN 2
             WHEN 'dispatcher' THEN 3
             WHEN 'provider' THEN 4
         END`,
        [companyId]
    );
    return rows;
}

/**
 * Get a specific role config by company + role_key.
 */
async function getRoleConfig(companyId, roleKey, client = null) {
    const { rows } = await queryFor(client)(
        `SELECT id, company_id, role_key, display_name, description, is_locked,
                created_at, updated_at
         FROM company_role_configs
         WHERE company_id = $1 AND role_key = $2`,
        [companyId, roleKey]
    );
    return rows[0] || null;
}

/**
 * Get role config by ID.
 */
async function getRoleConfigById(roleConfigId) {
    const { rows } = await db.query(
        'SELECT * FROM company_role_configs WHERE id = $1',
        [roleConfigId]
    );
    return rows[0] || null;
}

/**
 * Get all permissions for a role config.
 */
async function getRolePermissions(roleConfigId) {
    const { rows } = await db.query(
        `SELECT id, permission_key, is_allowed
         FROM company_role_permissions
         WHERE role_config_id = $1
         ORDER BY permission_key`,
        [roleConfigId]
    );
    return rows;
}

/**
 * Get all scopes for a role config.
 */
async function getRoleScopes(roleConfigId) {
    const { rows } = await db.query(
        `SELECT id, scope_key, scope_json
         FROM company_role_scopes
         WHERE role_config_id = $1
         ORDER BY scope_key`,
        [roleConfigId]
    );
    return rows;
}

/**
 * Get allowed permission keys for a role config.
 * Returns flat array of permission_key strings.
 */
async function getAllowedPermissionKeys(roleConfigId, client = null) {
    const { rows } = await queryFor(client)(
        `SELECT permission_key FROM company_role_permissions
         WHERE role_config_id = $1 AND is_allowed = true
         ORDER BY permission_key`,
        [roleConfigId]
    );
    return rows.map(r => r.permission_key);
}

/**
 * Get scope map for a role config.
 * Returns { scope_key: scope_json } object.
 */
async function getScopeMap(roleConfigId, client = null) {
    const { rows } = await queryFor(client)(
        `SELECT scope_key, scope_json FROM company_role_scopes
         WHERE role_config_id = $1`,
        [roleConfigId]
    );
    const map = {};
    for (const row of rows) {
        map[row.scope_key] = row.scope_json;
    }
    return map;
}

/**
 * Upsert a single role permission (RBAC-ROLES-EDITOR-001).
 * Sets is_allowed for (role_config_id, permission_key), inserting the row if
 * absent. Returns the upserted row.
 */
async function setRolePermission(roleConfigId, permissionKey, isAllowed) {
    const { rows } = await db.query(
        `INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
         VALUES ($1, $2, $3)
         ON CONFLICT (role_config_id, permission_key)
         DO UPDATE SET is_allowed = EXCLUDED.is_allowed, updated_at = NOW()
         RETURNING id, permission_key, is_allowed`,
        [roleConfigId, permissionKey, isAllowed]
    );
    return rows[0];
}

/**
 * Lazy-seed safety net (RBAC-ROLES-EDITOR-001): if a company has no role
 * configs yet (e.g. created outside the bootstrap path), seed the 4 defaults.
 * Returns the company's role configs.
 */
async function ensureRoleConfigs(companyId, createdBy = null) {
    const existing = await listRoleConfigs(companyId);
    if (existing.length > 0) return existing;
    await seedRoleConfigs(companyId, createdBy);
    return listRoleConfigs(companyId);
}

/**
 * Insert 4 default role configs for a new company.
 */
async function seedRoleConfigs(companyId, createdBy = null) {
    const roles = [
        { key: 'tenant_admin', name: 'Tenant Admin', desc: 'Full access to tenant scope', locked: true },
        { key: 'manager',      name: 'Manager',      desc: 'Broad access to business modules', locked: false },
        { key: 'dispatcher',   name: 'Dispatcher',    desc: 'Dispatch and communication operations', locked: false },
        { key: 'provider',     name: 'Provider',      desc: 'Field work and assigned jobs', locked: false },
    ];

    const results = [];
    for (const r of roles) {
        const { rows } = await db.query(
            `INSERT INTO company_role_configs (company_id, role_key, display_name, description, is_locked, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (company_id, role_key) DO NOTHING
             RETURNING *`,
            [companyId, r.key, r.name, r.desc, r.locked, createdBy]
        );
        if (rows[0]) results.push(rows[0]);
    }
    return results;
}

module.exports = {
    listRoleConfigs,
    getRoleConfig,
    getRoleConfigById,
    getRolePermissions,
    getRoleScopes,
    getAllowedPermissionKeys,
    getScopeMap,
    seedRoleConfigs,
    setRolePermission,
    ensureRoleConfigs,
};
