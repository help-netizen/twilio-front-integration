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
    const migrationsDir = path.join(__dirname, '..', '..', 'db', 'migrations');
    // 125 creates the table; 135 adds the structured-address columns (ADDR-UX-001).
    // Both are idempotent, so replaying them here keeps the schema correct even if
    // the migration runner has not caught up yet.
    for (const file of [
        '125_create_technician_base_locations.sql',
        '135_base_location_structured_address.sql',
    ]) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await db.query(sql);
    }
    schemaReady = true;
}

async function listByCompany(companyId) {
    await ensureSchema();
    const { rows } = await db.query(
        `SELECT tech_id, lat, lng, label, address,
                street, apt, city, state, zip,
                created_at, updated_at
         FROM technician_base_locations
         WHERE company_id = $1
         ORDER BY tech_id`,
        [companyId]
    );
    return rows;
}

async function upsert(companyId, techId, { lat, lng, label, address, street, apt, city, state, zip }) {
    await ensureSchema();
    const { rows } = await db.query(
        `INSERT INTO technician_base_locations
            (company_id, tech_id, lat, lng, label, address, street, apt, city, state, zip)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (company_id, tech_id) DO UPDATE SET
            lat = EXCLUDED.lat,
            lng = EXCLUDED.lng,
            label = EXCLUDED.label,
            address = EXCLUDED.address,
            street = EXCLUDED.street,
            apt = EXCLUDED.apt,
            city = EXCLUDED.city,
            state = EXCLUDED.state,
            zip = EXCLUDED.zip,
            updated_at = NOW()
         RETURNING *`,
        [
            companyId, techId, lat, lng, label ?? null, address ?? null,
            street ?? null, apt ?? null, city ?? null, state ?? null, zip ?? null,
        ]
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
