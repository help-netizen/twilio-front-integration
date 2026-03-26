/**
 * Company Queries — PF007
 * 
 * Data access for companies table (platform admin operations).
 */

const db = require('./connection');

/**
 * Get company by ID.
 */
async function getCompanyById(companyId) {
    const { rows } = await db.query(
        `SELECT id, name, slug, status, timezone, locale,
                contact_email, contact_phone, billing_email,
                created_by_user_id, suspended_at, archived_at, status_reason,
                settings, created_at, updated_at
         FROM companies WHERE id = $1`,
        [companyId]
    );
    return rows[0] || null;
}

/**
 * List companies with optional filters (platform admin).
 */
async function listCompanies(opts = {}) {
    const { status, q, page = 1, limit = 25 } = opts;
    const conditions = [];
    const params = [];
    let i = 1;

    if (status) {
        conditions.push(`status = $${i++}`);
        params.push(status);
    }
    if (q) {
        conditions.push(`(name ILIKE $${i} OR slug ILIKE $${i} OR contact_email ILIKE $${i})`);
        params.push(`%${q}%`);
        i++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countRes = await db.query(
        `SELECT COUNT(*) as total FROM companies ${where}`,
        params
    );
    const total = parseInt(countRes.rows[0].total, 10);

    const { rows } = await db.query(
        `SELECT id, name, slug, status, timezone, contact_email,
                created_at, updated_at, suspended_at, archived_at
         FROM companies ${where}
         ORDER BY created_at DESC
         LIMIT $${i++} OFFSET $${i++}`,
        [...params, limit, offset]
    );

    return { companies: rows, total, page, limit };
}

/**
 * Create a new company.
 */
async function createCompany(fields) {
    const { name, slug, timezone = 'America/New_York', locale = 'en-US', contact_email = null, contact_phone = null, status = 'active' } = fields;
    
    // Check if slug exists
    const check = await db.query('SELECT id FROM companies WHERE slug = $1', [slug]);
    if (check.rows.length > 0) throw new Error(`Company with slug '${slug}' already exists.`);

    const { rows } = await db.query(
        `INSERT INTO companies (name, slug, timezone, locale, contact_email, contact_phone, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         RETURNING *`,
        [name, slug, timezone, locale, contact_email, contact_phone, status]
    );
    return rows[0];
}

/**
 * Update company fields.
 */
async function updateCompany(companyId, fields) {
    const allowedKeys = [
        'name', 'slug', 'status', 'timezone', 'locale',
        'contact_email', 'contact_phone', 'billing_email',
        'status_reason', 'suspended_at', 'archived_at',
    ];
    const sets = [];
    const params = [];
    let i = 1;

    for (const [key, value] of Object.entries(fields)) {
        if (allowedKeys.includes(key)) {
            sets.push(`${key} = $${i++}`);
            params.push(value);
        }
    }

    if (sets.length === 0) return null;

    params.push(companyId);
    const { rows } = await db.query(
        `UPDATE companies SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
        params
    );
    return rows[0] || null;
}

module.exports = {
    getCompanyById,
    listCompanies,
    createCompany,
    updateCompany,
};
