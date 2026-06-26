/**
 * slotEngineSettingsQueries.js — company-scoped read/write over slot_engine_settings
 * (REC-SETTINGS-001). One row per company (company_id is PK = FK). Stores the discrete
 * recommendation-settings config jsonb. Every query is scoped by company_id.
 */
const fs = require('fs');
const path = require('path');
const db = require('./connection');

let schemaReady = false;
async function ensureSchema() {
    if (schemaReady) return;
    const sql = fs.readFileSync(
        path.join(__dirname, '..', '..', 'db', 'migrations', '128_create_slot_engine_settings.sql'),
        'utf8'
    );
    await db.query(sql);
    schemaReady = true;
}

async function getByCompany(companyId) {
    await ensureSchema();
    const { rows } = await db.query(
        `SELECT config
         FROM slot_engine_settings
         WHERE company_id = $1`,
        [companyId]
    );
    return rows[0] ? rows[0].config : null;
}

async function upsert(companyId, config) {
    await ensureSchema();
    const { rows } = await db.query(
        `INSERT INTO slot_engine_settings (company_id, config)
         VALUES ($1, $2)
         ON CONFLICT (company_id) DO UPDATE SET
            config = $2,
            updated_at = NOW()
         RETURNING config`,
        [companyId, config]
    );
    return rows[0].config;
}

module.exports = { getByCompany, upsert, ensureSchema };
