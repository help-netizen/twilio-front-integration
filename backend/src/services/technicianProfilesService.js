/**
 * technicianProfilesService.js — technician display info (photo + name) for the
 * public payment page. Settings supplies the active native roster and this
 * service merges stored photo/name overrides keyed by (company_id, tech_id).
 * Invoice display still resolves the assigned technician from the invoice job.
 */
const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const directoryQueries = require('../db/technicianDirectoryQueries');
const storageService = require('./storageService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidTechnicianIdentityError() {
    const error = new Error('Technician identity not found');
    error.code = 'TECHNICIAN_IDENTITY_NOT_FOUND';
    error.httpStatus = 404;
    return error;
}

async function resolveTechnicianIdentity(companyId, techId, { required = true } = {}) {
    const id = techId == null ? '' : String(techId).trim();
    if (!id) {
        if (!required) return null;
        throw invalidTechnicianIdentityError();
    }
    if (UUID_RE.test(id)) {
        const technicianUuid = id.toLowerCase();
        const externalId = await directoryQueries.resolveUuidToExternal(
            companyId,
            'zenbooker',
            technicianUuid
        );
        return { externalId: externalId || technicianUuid, technicianUuid, publicId: id };
    }
    const technicianUuid = await directoryQueries.resolveExternalToUuid(
        companyId,
        'zenbooker',
        id
    );
    return {
        externalId: id,
        technicianUuid: technicianUuid ? String(technicianUuid).toLowerCase() : null,
        publicId: id,
    };
}

let schemaReady = false;
async function ensureSchema() {
    if (schemaReady) return;
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '123_create_technician_profiles.sql'), 'utf8');
    await db.query(sql);
    schemaReady = true;
}

/** Stored display profiles for a caller-supplied, already company-scoped roster. */
async function listProfiles(companyId, technicianIds) {
    await ensureSchema();
    const ids = Array.from(new Set((technicianIds || []).map(String).filter(Boolean)));
    if (ids.length === 0) return [];
    const identities = (await Promise.all(ids.map(async id => ({
        publicId: id,
        identity: await resolveTechnicianIdentity(companyId, id, { required: false }),
    })))).filter(item => item.identity);
    if (identities.length === 0) return [];
    const publicIdByMatchKey = new Map(identities.map(item => [
        item.identity.technicianUuid || item.identity.externalId,
        item.publicId,
    ]));
    const { rows } = await db.query(
        `WITH resolved_profiles AS (
             SELECT p.*,
                    COALESCE(
                        p.technician_uuid::text,
                        e.technician_id::text,
                        p.tech_id
                    ) AS resolved_match_key
             FROM technician_profiles p
             LEFT JOIN technician_external_identities e
               ON p.technician_uuid IS NULL
              AND e.company_id = p.company_id
              AND e.source = 'zenbooker'
              AND e.external_id = p.tech_id
             WHERE p.company_id = $1
         )
         SELECT resolved_match_key AS tech_id, name,
                (photo_storage_key IS NOT NULL) AS has_photo
         FROM resolved_profiles
         WHERE resolved_match_key = ANY($2::text[])
         ORDER BY resolved_match_key`,
        [
            companyId,
            identities.map(item => item.identity.technicianUuid || item.identity.externalId),
        ]
    );
    return rows.map(row => ({
        ...row,
        tech_id: publicIdByMatchKey.get(String(row.tech_id)) || String(row.tech_id),
    }));
}

async function getProfile(companyId, techId) {
    await ensureSchema();
    const identity = await resolveTechnicianIdentity(companyId, techId, { required: false });
    if (!identity) return null;
    const { rows } = await db.query(
        `WITH resolved_profiles AS (
             SELECT p.*,
                    COALESCE(
                        p.technician_uuid::text,
                        e.technician_id::text,
                        p.tech_id
                    ) AS resolved_match_key
             FROM technician_profiles p
             LEFT JOIN technician_external_identities e
               ON p.technician_uuid IS NULL
              AND e.company_id = p.company_id
              AND e.source = 'zenbooker'
              AND e.external_id = p.tech_id
             WHERE p.company_id = $1
         )
         SELECT resolved_match_key AS tech_id, name, photo_storage_key
         FROM resolved_profiles
         WHERE resolved_match_key = $2::text
         LIMIT 1`,
        [companyId, identity.technicianUuid || identity.externalId]
    );
    return rows[0] ? { ...rows[0], tech_id: String(techId) } : null;
}

/** Upload (or replace) a technician photo. Deletes the previous object if any. */
async function uploadPhoto(companyId, techId, { name, file }) {
    await ensureSchema();
    const identity = await resolveTechnicianIdentity(companyId, techId);
    const prev = await getProfile(companyId, identity.publicId);
    const storageKey = storageService.generateStorageKey(
        companyId,
        'technician',
        identity.externalId,
        file.originalname || 'photo.jpg'
    );
    await storageService.uploadFile(file.buffer, file.mimetype, storageKey);
    await db.query(
        `WITH updated AS (
             UPDATE technician_profiles p
             SET technician_uuid = $3::uuid,
                 name = COALESCE($4, p.name),
                 photo_storage_key = $5,
                 updated_at = NOW()
             WHERE p.company_id = $1
               AND (
                    p.technician_uuid = $3::uuid
                    OR (
                        p.technician_uuid IS NULL
                        AND (
                            p.tech_id = $2
                            OR EXISTS (
                                SELECT 1
                                FROM technician_external_identities e
                                WHERE e.company_id = p.company_id
                                  AND e.source = 'zenbooker'
                                  AND e.external_id = p.tech_id
                                  AND e.technician_id = $3::uuid
                            )
                        )
                    )
               )
             RETURNING p.id
         )
         INSERT INTO technician_profiles
            (company_id, tech_id, technician_uuid, name, photo_storage_key)
         SELECT $1, $2, $3::uuid, $4, $5
         WHERE NOT EXISTS (SELECT 1 FROM updated)
         ON CONFLICT (company_id, tech_id) DO UPDATE SET
            technician_uuid = EXCLUDED.technician_uuid,
            name = COALESCE(EXCLUDED.name, technician_profiles.name),
            photo_storage_key = EXCLUDED.photo_storage_key,
            updated_at = NOW()
         WHERE technician_profiles.technician_uuid IS NULL
            OR technician_profiles.technician_uuid = EXCLUDED.technician_uuid`,
        [companyId, identity.externalId, identity.technicianUuid, name || null, storageKey]
    );
    if (prev?.photo_storage_key && prev.photo_storage_key !== storageKey) {
        try { await storageService.deleteFile(prev.photo_storage_key); } catch (e) { /* best-effort */ }
    }
    return { tech_id: String(techId), has_photo: true };
}

/**
 * Resolve the technician to show for an invoice: invoice → job → assigned_techs[0],
 * merged with the stored profile (name override + presigned photo url).
 */
async function getTechnicianForInvoice(companyId, invoice) {
    await ensureSchema();
    if (!invoice?.job_id) return null;
    const { rows } = await db.query(
        `SELECT (j.assigned_techs->0->>'id') AS tech_id, (j.assigned_techs->0->>'name') AS name
         FROM jobs j WHERE j.id = $1 AND j.company_id = $2 AND jsonb_typeof(j.assigned_techs) = 'array' AND jsonb_array_length(j.assigned_techs) > 0`,
        [invoice.job_id, companyId]
    );
    const tech = rows[0];
    if (!tech?.tech_id) return null;
    const profile = await getProfile(companyId, tech.tech_id);
    let photo_url = null;
    if (profile?.photo_storage_key) {
        try { photo_url = await storageService.getPresignedUrl(profile.photo_storage_key); } catch (e) { /* ignore */ }
    }
    return { name: profile?.name || tech.name || null, photo_url };
}

module.exports = {
    listProfiles,
    getProfile,
    uploadPhoto,
    getTechnicianForInvoice,
    resolveTechnicianIdentity,
};
