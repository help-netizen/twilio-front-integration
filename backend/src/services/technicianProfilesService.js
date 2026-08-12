/**
 * technicianProfilesService.js — technician display info (photo + name) for the
 * public payment page. Settings supplies the active native roster and this
 * service merges stored photo/name overrides keyed by technician UUID.
 * Invoice display still resolves the assigned technician from the invoice job.
 */
const db = require('../db/connection');
const directoryQueries = require('../db/technicianDirectoryQueries');
const storageService = require('./storageService');

function invalidTechnicianIdentityError() {
    const error = new Error('Technician identity not found');
    error.code = 'TECHNICIAN_IDENTITY_NOT_FOUND';
    error.httpStatus = 404;
    return error;
}

async function resolveTechnicianIdentity(companyId, techId, { required = true } = {}) {
    const input = techId == null ? '' : String(techId).trim();
    if (!input) {
        if (!required) return null;
        throw invalidTechnicianIdentityError();
    }
    const technicianUuid = await directoryQueries.resolveTechnicianUuid(
        companyId,
        input,
        'zenbooker'
    );
    if (!technicianUuid) {
        if (!required) return null;
        throw invalidTechnicianIdentityError();
    }
    return {
        technicianUuid: String(technicianUuid).toLowerCase(),
        publicId: String(technicianUuid).toLowerCase(),
    };
}

/** Stored display profiles for a caller-supplied, already company-scoped roster. */
async function listProfiles(companyId, technicianIds) {
    const ids = Array.from(new Set((technicianIds || []).map(String).filter(Boolean)));
    if (ids.length === 0) return [];
    const identities = (await Promise.all(ids.map(async id => ({
        publicId: id,
        identity: await resolveTechnicianIdentity(companyId, id, { required: false }),
    })))).filter(item => item.identity);
    if (identities.length === 0) return [];
    const { rows } = await db.query(
        `SELECT technician_uuid::text AS tech_id, name,
                (photo_storage_key IS NOT NULL) AS has_photo
         FROM technician_profiles
         WHERE company_id = $1
           AND technician_uuid = ANY($2::uuid[])
         ORDER BY technician_uuid`,
        [
            companyId,
            identities.map(item => item.identity.technicianUuid),
        ]
    );
    return rows;
}

async function getProfile(companyId, techId) {
    const identity = await resolveTechnicianIdentity(companyId, techId, { required: false });
    if (!identity) return null;
    const { rows } = await db.query(
        `SELECT technician_uuid::text AS tech_id, name, photo_storage_key
         FROM technician_profiles
         WHERE company_id = $1 AND technician_uuid = $2::uuid
         LIMIT 1`,
        [companyId, identity.technicianUuid]
    );
    return rows[0] || null;
}

/** Upload (or replace) a technician photo. Deletes the previous object if any. */
async function uploadPhoto(companyId, techId, { name, file }) {
    const identity = await resolveTechnicianIdentity(companyId, techId);
    const prev = await getProfile(companyId, identity.publicId);
    const storageKey = storageService.generateStorageKey(
        companyId,
        'technician',
        identity.technicianUuid,
        file.originalname || 'photo.jpg'
    );
    await storageService.uploadFile(file.buffer, file.mimetype, storageKey);
    await db.query(
        `INSERT INTO technician_profiles
            (company_id, technician_uuid, name, photo_storage_key)
         VALUES ($1, $2::uuid, $3, $4)
         ON CONFLICT (company_id, technician_uuid) DO UPDATE SET
            name = COALESCE(EXCLUDED.name, technician_profiles.name),
            photo_storage_key = EXCLUDED.photo_storage_key,
            updated_at = NOW()`,
        [companyId, identity.technicianUuid, name || null, storageKey]
    );
    if (prev?.photo_storage_key && prev.photo_storage_key !== storageKey) {
        try { await storageService.deleteFile(prev.photo_storage_key); } catch (e) { /* best-effort */ }
    }
    return { tech_id: identity.technicianUuid, has_photo: true };
}

/**
 * Resolve the technician to show for an invoice: invoice → job → assigned_techs[0],
 * merged with the stored profile (name override + presigned photo url).
 */
async function getTechnicianForInvoice(companyId, invoice) {
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
