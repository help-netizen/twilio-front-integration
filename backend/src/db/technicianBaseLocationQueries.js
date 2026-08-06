/**
 * technicianBaseLocationQueries.js — company-scoped CRUD over technician_base_locations
 * (SLOT-ENGINE-001 Phase 2). Stores each technician's home/base coordinates, keyed by
 * (company_id, tech_id). Every query filters by company_id.
 */
const fs = require('fs');
const path = require('path');
const db = require('./connection');
const directoryQueries = require('./technicianDirectoryQueries');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPANY_BASE_ID = '__company__';

function invalidTechnicianIdentityError() {
    const error = new Error('Technician identity not found');
    error.code = 'TECHNICIAN_IDENTITY_NOT_FOUND';
    error.httpStatus = 404;
    return error;
}

async function resolveTechnicianIdentity(companyId, techId, { required = true } = {}) {
    const id = String(techId);
    if (id === COMPANY_BASE_ID) {
        return { externalId: id, technicianUuid: null };
    }
    if (UUID_RE.test(id)) {
        const technicianUuid = id.toLowerCase();
        const externalId = await directoryQueries.resolveUuidToExternal(
            companyId,
            'zenbooker',
            technicianUuid
        );
        return { externalId: externalId || technicianUuid, technicianUuid };
    }
    const technicianUuid = await directoryQueries.resolveExternalToUuid(
        companyId,
        'zenbooker',
        id
    );
    if (!technicianUuid) {
        if (!required) return null;
        throw invalidTechnicianIdentityError();
    }
    return { externalId: id, technicianUuid: String(technicianUuid).toLowerCase() };
}

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
        `WITH base_locations AS (
             SELECT tech_id, lat, lng, label, address,
                    street, apt, city, state, zip,
                    created_at, updated_at, company_id, technician_uuid
             FROM technician_base_locations
             WHERE company_id = $1
         )
         SELECT CASE
                    WHEN b.tech_id = '__company__' THEN b.tech_id
                    ELSE COALESCE(public_identity.external_id, b.tech_id)
                END AS tech_id,
                b.lat, b.lng, b.label, b.address,
                b.street, b.apt, b.city, b.state, b.zip,
                b.created_at, b.updated_at
         FROM base_locations b
         LEFT JOIN technician_external_identities e
          ON b.technician_uuid IS NULL
          AND b.tech_id <> '__company__'
          AND e.company_id = b.company_id
          AND e.source = 'zenbooker'
          AND e.external_id = b.tech_id
         LEFT JOIN LATERAL (
             SELECT mapped.external_id
             FROM technician_external_identities mapped
             WHERE mapped.company_id = b.company_id
               AND mapped.source = 'zenbooker'
               AND mapped.technician_id = COALESCE(b.technician_uuid, e.technician_id)
             ORDER BY mapped.created_at ASC, mapped.external_id ASC
             LIMIT 1
         ) public_identity ON TRUE
         WHERE (
                b.tech_id = '__company__'
                OR COALESCE(b.technician_uuid, e.technician_id) IS NOT NULL
           )
         ORDER BY tech_id`,
        [companyId]
    );
    return rows;
}

async function upsert(companyId, techId, { lat, lng, label, address, street, apt, city, state, zip }) {
    await ensureSchema();
    const identity = await resolveTechnicianIdentity(companyId, techId);
    const { rows } = await db.query(
        `WITH updated AS (
             UPDATE technician_base_locations b
             SET technician_uuid = $3::uuid,
                 lat = $4,
                 lng = $5,
                 label = $6,
                 address = $7,
                 street = $8,
                 apt = $9,
                 city = $10,
                 state = $11,
                 zip = $12,
                 updated_at = NOW()
             WHERE b.company_id = $1
               AND (
                    ($3::uuid IS NULL AND b.tech_id = $2)
                    OR b.technician_uuid = $3::uuid
                    OR (
                        b.technician_uuid IS NULL
                        AND EXISTS (
                            SELECT 1
                            FROM technician_external_identities e
                            WHERE e.company_id = b.company_id
                              AND e.source = 'zenbooker'
                              AND e.external_id = b.tech_id
                              AND e.technician_id = $3::uuid
                        )
                    )
               )
             RETURNING b.*
         ), inserted AS (
             INSERT INTO technician_base_locations
                (company_id, tech_id, technician_uuid, lat, lng, label, address,
                 street, apt, city, state, zip)
             SELECT $1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12
             WHERE NOT EXISTS (SELECT 1 FROM updated)
             ON CONFLICT (company_id, tech_id) DO UPDATE SET
                technician_uuid = EXCLUDED.technician_uuid,
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
             WHERE technician_base_locations.technician_uuid IS NULL
                OR technician_base_locations.technician_uuid = EXCLUDED.technician_uuid
             RETURNING technician_base_locations.*
         )
         SELECT company_id, tech_id, lat, lng, label, address,
                created_at, updated_at, street, apt, city, state, zip
         FROM updated
         UNION ALL
         SELECT company_id, tech_id, lat, lng, label, address,
                created_at, updated_at, street, apt, city, state, zip
         FROM inserted
         LIMIT 1`,
        [
            companyId, identity.externalId, identity.technicianUuid, lat, lng,
            label ?? null, address ?? null,
            street ?? null, apt ?? null, city ?? null, state ?? null, zip ?? null,
        ]
    );
    if (!rows[0]) throw invalidTechnicianIdentityError();
    return rows[0];
}

async function remove(companyId, techId) {
    await ensureSchema();
    const identity = await resolveTechnicianIdentity(companyId, techId, { required: false });
    if (!identity) return null;
    const { rows } = await db.query(
        `DELETE FROM technician_base_locations b
         WHERE b.company_id = $1
           AND (
                ($3::uuid IS NULL AND b.tech_id = $2)
                OR b.technician_uuid = $3::uuid
                OR (
                    b.technician_uuid IS NULL
                    AND EXISTS (
                        SELECT 1
                        FROM technician_external_identities e
                        WHERE e.company_id = b.company_id
                          AND e.source = 'zenbooker'
                          AND e.external_id = b.tech_id
                          AND e.technician_id = $3::uuid
                    )
                )
           )
         RETURNING b.tech_id`,
        [companyId, identity.externalId, identity.technicianUuid]
    );
    return rows[0] || null;
}

module.exports = { listByCompany, upsert, remove, resolveTechnicianIdentity };
