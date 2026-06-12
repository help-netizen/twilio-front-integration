/**
 * Platform Company Service — ALB-101/102
 *
 * Company lifecycle for the commercial platform:
 *  - bootstrapCompany: self-service signup → company + first tenant_admin
 *  - list/get/update for the platform super admin panel
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const auditService = require('./auditService');

const ROLE_SEED_SQL = fs.readFileSync(
    path.resolve(__dirname, '../../db/migrations/050_seed_role_configs.sql'),
    'utf8'
);

function slugify(name) {
    return String(name).toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'company';
}

/**
 * Create a company + first tenant_admin membership in one transaction.
 * Idempotent for retries: if the creator already owns a company with the same
 * name, that company is returned instead of creating a duplicate.
 *
 * @param {Object} p
 * @param {string} p.userId        crm_users.id of the creator (becomes tenant_admin)
 * @param {string} p.name          company display name
 * @param {Object} p.geo           {city,state,zip,lat,lng,timezone} from Places
 * @param {string} p.phone         verified E.164 phone of the creator
 * @param {string} [p.email]       creator email (company contact_email)
 */
async function bootstrapCompany({ userId, name, geo = {}, phone, email }) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Retry-safety: same creator + same name → return existing
        const { rows: existing } = await client.query(
            `SELECT id, name, timezone, status FROM companies
             WHERE created_by_user_id = $1 AND LOWER(name) = LOWER($2)
             LIMIT 1`,
            [userId, name]
        );
        if (existing.length > 0) {
            await client.query('COMMIT');
            return { company: existing[0], created: false };
        }

        // Unique slug
        const base = slugify(name);
        let slug = base;
        for (let i = 2; ; i++) {
            const { rows } = await client.query('SELECT 1 FROM companies WHERE slug = $1', [slug]);
            if (rows.length === 0) break;
            slug = `${base}-${i}`;
        }

        const { rows: companyRows } = await client.query(
            `INSERT INTO companies (name, slug, status, timezone, contact_email, contact_phone,
                                    created_by_user_id, city, state, zip, lat, lng)
             VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id, name, slug, timezone, status`,
            [name, slug, geo.timezone || 'America/New_York', email || null, phone || null,
             userId, geo.city || null, geo.state || null, geo.zip || null,
             geo.lat || null, geo.lng || null]
        );
        const company = companyRows[0];

        const { rows: memRows } = await client.query(
            `INSERT INTO company_memberships (user_id, company_id, role, role_key, is_primary, status, activated_at)
             VALUES ($1, $2, 'company_admin', 'tenant_admin', true, 'active', now())
             ON CONFLICT (user_id, company_id) DO UPDATE SET role_key = 'tenant_admin', status = 'active'
             RETURNING id`,
            [userId, company.id]
        );

        await client.query(
            `INSERT INTO company_user_profiles (membership_id, phone)
             VALUES ($1, $2)
             ON CONFLICT (membership_id) DO UPDATE SET phone = COALESCE(EXCLUDED.phone, company_user_profiles.phone)`,
            [memRows[0].id, phone || null]
        );

        // Compatibility shadow + verified phone on the platform user
        await client.query(
            `UPDATE crm_users SET company_id = COALESCE(company_id, $2), role = 'company_admin',
                                  phone_e164 = COALESCE($3, phone_e164),
                                  phone_verified_at = COALESCE(phone_verified_at, CASE WHEN $3 IS NOT NULL THEN now() END),
                                  updated_at = now()
             WHERE id = $1`,
            [userId, company.id, phone || null]
        );

        // Seed default role matrix (migration 050 body is idempotent and
        // covers every company, including the one just created)
        await client.query(ROLE_SEED_SQL);

        await client.query('COMMIT');

        auditService.log({
            actor_id: userId,
            action: 'company.created',
            target_type: 'company',
            target_id: company.id,
            company_id: company.id,
            details: { name, slug, timezone: company.timezone, source: 'self_signup' },
        }).catch(() => {});

        return { company, created: true };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ── Platform admin panel queries ─────────────────────────────────────────────

async function listCompanies({ status, q, page = 1, limit = 25 } = {}) {
    const conditions = [];
    const params = [];
    let i = 1;
    if (status) { conditions.push(`c.status = $${i++}`); params.push(status); }
    if (q) { conditions.push(`(c.name ILIKE $${i} OR c.slug ILIKE $${i})`); params.push(`%${q}%`); i++; }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const { rows: countRows } = await db.query(
        `SELECT COUNT(*) AS total FROM companies c ${where}`, params
    );

    const { rows } = await db.query(
        `SELECT c.id, c.name, c.slug, c.status, c.status_reason, c.timezone,
                c.city, c.state, c.created_at, c.suspended_at,
                (SELECT COUNT(*) FROM company_memberships m
                  WHERE m.company_id = c.id AND m.status = 'active') AS users_count,
                GREATEST(
                    (SELECT MAX(created_at) FROM jobs  j WHERE j.company_id = c.id),
                    (SELECT MAX(created_at) FROM leads l WHERE l.company_id = c.id),
                    (SELECT MAX(created_at) FROM calls cc WHERE cc.company_id = c.id)
                ) AS last_activity_at
         FROM companies c
         ${where}
         ORDER BY c.created_at DESC
         LIMIT $${i++} OFFSET $${i++}`,
        [...params, limit, offset]
    );
    return { companies: rows, total: parseInt(countRows[0].total, 10), page, limit };
}

async function getCompanyDetail(companyId) {
    const { rows } = await db.query(
        `SELECT c.*,
                (SELECT COUNT(*) FROM company_memberships m
                  WHERE m.company_id = c.id AND m.status = 'active') AS users_count
         FROM companies c WHERE c.id = $1`,
        [companyId]
    );
    if (!rows[0]) return null;
    const { rows: audit } = await db.query(
        `SELECT action, actor_email, created_at, details
         FROM audit_log WHERE company_id = $1
         ORDER BY created_at DESC LIMIT 20`,
        [companyId]
    );
    const c = rows[0];
    delete c.zenbooker_api_key;
    delete c.zenbooker_webhook_key;
    delete c.settings;
    return { company: c, audit };
}

const PATCHABLE = ['name', 'slug', 'timezone', 'locale', 'contact_email', 'contact_phone', 'status', 'status_reason'];

async function updateCompany(companyId, updates, actor = {}) {
    const sets = [];
    const params = [companyId];
    let i = 2;
    for (const key of PATCHABLE) {
        if (updates[key] !== undefined) {
            if (key === 'status' && !['active', 'suspended', 'archived'].includes(updates[key])) {
                const err = new Error('Invalid status'); err.httpStatus = 422; throw err;
            }
            sets.push(`${key} = $${i++}`);
            params.push(updates[key]);
        }
    }
    if (sets.length === 0) { const err = new Error('No fields'); err.httpStatus = 422; throw err; }
    if (updates.status === 'suspended') sets.push('suspended_at = now()');
    if (updates.status === 'active') sets.push('suspended_at = NULL');
    sets.push('updated_at = now()');

    const { rows } = await db.query(
        `UPDATE companies SET ${sets.join(', ')} WHERE id = $1
         RETURNING id, name, slug, status, status_reason, timezone`,
        params
    );
    if (!rows[0]) return null;

    if (updates.status) {
        auditService.log({
            actor_id: actor.id, actor_email: actor.email,
            action: updates.status === 'suspended' ? 'company.suspended' : 'company.restored',
            target_type: 'company', target_id: companyId, company_id: companyId,
            details: { reason: updates.status_reason || null },
        }).catch(() => {});
    }
    return rows[0];
}

module.exports = { bootstrapCompany, listCompanies, getCompanyDetail, updateCompany, slugify };
