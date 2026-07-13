/**
 * SERVICE-TERR-002 radius-territory persistence. All tenant-owned reads and
 * writes are scoped by company_id. zip_geocache is the documented global
 * public-geography exception and is only used here for display metadata.
 */

const db = require('./connection');

async function getSettings(companyId) {
    const { rows } = await db.query(
        `SELECT active_mode
         FROM company_territory_settings
         WHERE company_id = $1`,
        [companyId]
    );
    return rows[0] || { active_mode: 'list' };
}

async function setMode(companyId, mode) {
    const { rows } = await db.query(
        `INSERT INTO company_territory_settings (company_id, active_mode)
         VALUES ($1, $2)
         ON CONFLICT (company_id) DO UPDATE SET
            active_mode = EXCLUDED.active_mode,
            updated_at = NOW()
         RETURNING active_mode`,
        [companyId, mode]
    );
    return rows[0];
}

async function listRadii(companyId) {
    const { rows } = await db.query(
        `SELECT r.id, r.zip, r.radius_miles, r.lat, r.lon, r.position,
                z.city, z.state
         FROM territory_radii r
         LEFT JOIN zip_geocache z ON z.zip = r.zip
         WHERE r.company_id = $1
         ORDER BY r.position ASC, r.created_at ASC, r.id ASC`,
        [companyId]
    );
    return rows;
}

async function createRadius(companyId, { zip, lat, lon, radius_miles, position }) {
    const { rows } = await db.query(
        `INSERT INTO territory_radii
            (company_id, zip, lat, lon, radius_miles, position)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, zip, radius_miles, lat, lon, position`,
        [companyId, zip, lat, lon, radius_miles, position]
    );
    return rows[0];
}

async function deleteRadius(companyId, id) {
    const { rows } = await db.query(
        `DELETE FROM territory_radii
         WHERE id = $1 AND company_id = $2
         RETURNING id`,
        [id, companyId]
    );
    return rows[0] || null;
}

async function countListZips(companyId) {
    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS count
         FROM service_territories
         WHERE company_id = $1`,
        [companyId]
    );
    return Number(rows[0]?.count || 0);
}

module.exports = {
    getSettings,
    setMode,
    listRadii,
    createRadius,
    deleteRadius,
    countListZips,
};
