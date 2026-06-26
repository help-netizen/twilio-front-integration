/**
 * technicianBaseLocationQueries.js — company-scoped CRUD over technician_base_locations
 * (SLOT-ENGINE-001 Phase 2). Stores each technician's home/base coordinates, keyed by
 * (company_id, tech_id). Every query filters by company_id.
 */
const fs = require('fs');
const path = require('path');
const db = require('./connection');

let schemaReady = false;
async function ensureSchema() {
    if (schemaReady) return;
    const sql = fs.readFileSync(
        path.join(__dirname, '..', '..', 'db', 'migrations', '125_create_technician_base_locations.sql'),
        'utf8'
    );
    await db.query(sql);
    schemaReady = true;
}

async function listByCompany(companyId) {
    await ensureSchema();
    const { rows } = await db.query(
        `SELECT tech_id, lat, lng, label, address, created_at, updated_at
         FROM technician_base_locations
         WHERE company_id = $1
         ORDER BY tech_id`,
        [companyId]
    );
    return rows;
}

async function upsert(companyId, techId, { lat, lng, label, address }) {
    await ensureSchema();
    const { rows } = await db.query(
        `INSERT INTO technician_base_locations (company_id, tech_id, lat, lng, label, address)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (company_id, tech_id) DO UPDATE SET
            lat = EXCLUDED.lat,
            lng = EXCLUDED.lng,
            label = EXCLUDED.label,
            address = EXCLUDED.address,
            updated_at = NOW()
         RETURNING *`,
        [companyId, techId, lat, lng, label ?? null, address ?? null]
    );
    return rows[0];
}

async function remove(companyId, techId) {
    await ensureSchema();
    const { rows } = await db.query(
        `DELETE FROM technician_base_locations
         WHERE company_id = $1 AND tech_id = $2
         RETURNING tech_id`,
        [companyId, techId]
    );
    return rows[0] || null;
}

module.exports = { listByCompany, upsert, remove };
