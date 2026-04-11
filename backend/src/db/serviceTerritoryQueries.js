const db = require('./connection');

// =============================================================================
// Service Territories CRUD (service_territories table, per-company)
// =============================================================================

async function getAll(companyId) {
    const result = await db.query(
        `SELECT zip, area, city, state, county, created_at
         FROM service_territories
         WHERE company_id = $1
         ORDER BY area ASC, zip ASC`,
        [companyId]
    );
    return result.rows;
}

async function getAreas(companyId) {
    const result = await db.query(
        `SELECT DISTINCT area
         FROM service_territories
         WHERE company_id = $1 AND area != ''
         ORDER BY area ASC`,
        [companyId]
    );
    return result.rows.map(r => r.area);
}

async function create(companyId, { zip, area, city, state, county }) {
    const result = await db.query(
        `INSERT INTO service_territories (company_id, zip, area, city, state, county)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (company_id, zip) DO NOTHING
         RETURNING zip, area, city, state, county, created_at`,
        [companyId, zip, area || '', city || null, state || null, county || null]
    );
    return result.rows[0] || null;
}

async function remove(companyId, zip) {
    const result = await db.query(
        `DELETE FROM service_territories
         WHERE company_id = $1 AND zip = $2
         RETURNING zip`,
        [companyId, zip]
    );
    return result.rows[0] || null;
}

async function bulkReplace(companyId, rows) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `DELETE FROM service_territories WHERE company_id = $1`,
            [companyId]
        );
        if (rows.length > 0) {
            const zips = [];
            const areas = [];
            const cities = [];
            const states = [];
            const counties = [];
            for (const r of rows) {
                zips.push(r.zip);
                areas.push(r.area || '');
                cities.push(r.city || null);
                states.push(r.state || null);
                counties.push(r.county || null);
            }
            await client.query(
                `INSERT INTO service_territories (company_id, zip, area, city, state, county)
                 SELECT $1, unnest($2::text[]), unnest($3::text[]), unnest($4::text[]), unnest($5::text[]), unnest($6::text[])
                 ON CONFLICT (company_id, zip) DO NOTHING`,
                [companyId, zips, areas, cities, states, counties]
            );
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// =============================================================================
// Territory Lookup (search/findByZip)
// Searches service_territories first (per-company), falls back to dim_zip (shared)
// =============================================================================

async function findByZip(companyId, zip) {
    // 1) Per-company service_territories
    const st = await db.query(
        `SELECT zip, area, city, state, county FROM service_territories WHERE company_id = $1 AND zip = $2`,
        [companyId, zip]
    );
    if (st.rows[0]) return st.rows[0];

    // 2) Fallback: shared dim_zip reference table
    const dz = await db.query(
        `SELECT zip, service_zone AS area, city, state FROM dim_zip WHERE zip = $1`,
        [zip]
    );
    return dz.rows[0] || null;
}

/**
 * Search service territories by zip code, city, area, or full address.
 * Tries service_territories (per-company) first, falls back to dim_zip (shared).
 * Handles raw zip, city name, or full address strings like "123 Main St, Brockton, MA, USA".
 */
async function search(companyId, query) {
    const trimmed = query.trim();
    if (!trimmed) return null;

    // 1) If looks like a zip code (digits only, at least 3 chars)
    if (/^\d{3,10}$/.test(trimmed)) {
        return findByZip(companyId, trimmed);
    }

    // 2) Try exact match on city, area, or county — service_territories first
    const stExact = await db.query(
        `SELECT zip, area, city, state, county FROM service_territories
         WHERE company_id = $1 AND (city ILIKE $2 OR area ILIKE $2 OR county ILIKE $2)
         ORDER BY area, zip LIMIT 1`,
        [companyId, trimmed]
    );
    if (stExact.rows[0]) return stExact.rows[0];

    // Fallback: dim_zip
    const dzExact = await db.query(
        `SELECT zip, service_zone AS area, city, state FROM dim_zip
         WHERE city ILIKE $1 OR service_zone ILIKE $1
         ORDER BY service_zone, zip LIMIT 1`,
        [trimmed]
    );
    if (dzExact.rows[0]) return dzExact.rows[0];

    // 3) Extract zip from the string (e.g. "123 Main St, Brockton, MA 02301, USA")
    const zipMatch = trimmed.match(/\b(\d{5})(?:-\d{4})?\b/);
    if (zipMatch) {
        const row = await findByZip(companyId, zipMatch[1]);
        if (row) return row;
    }

    // 4) Try each comma-separated part as a city name
    const parts = trimmed.split(',').map(p => p.trim()).filter(Boolean);
    for (const part of parts) {
        // Skip parts that look like state codes, zip codes, "USA", or street addresses (start with digit)
        if (/^\d/.test(part) || /^[A-Z]{2}(\s+\d{5})?$/.test(part) || /^(USA|United States)$/i.test(part)) continue;

        // service_territories first
        const stPart = await db.query(
            `SELECT zip, area, city, state, county FROM service_territories
             WHERE company_id = $1 AND (city ILIKE $2 OR area ILIKE $2 OR county ILIKE $2)
             ORDER BY area, zip LIMIT 1`,
            [companyId, part]
        );
        if (stPart.rows[0]) return stPart.rows[0];

        // Fallback: dim_zip
        const dzPart = await db.query(
            `SELECT zip, service_zone AS area, city, state FROM dim_zip
             WHERE city ILIKE $1 OR service_zone ILIKE $1
             ORDER BY service_zone, zip LIMIT 1`,
            [part]
        );
        if (dzPart.rows[0]) return dzPart.rows[0];
    }

    return null;
}

module.exports = {
    getAll,
    getAreas,
    create,
    remove,
    bulkReplace,
    findByZip,
    search,
};
