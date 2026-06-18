/**
 * technicianProfilesService.js — technician display info (photo + name) for the
 * public payment page. Technicians come from jobs.assigned_techs (JSONB); this adds
 * an uploadable photo + optional display-name override, keyed by (company_id, tech_id).
 */
const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const storageService = require('./storageService');

let schemaReady = false;
async function ensureSchema() {
    if (schemaReady) return;
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '123_create_technician_profiles.sql'), 'utf8');
    await db.query(sql);
    schemaReady = true;
}

/** Distinct technicians seen across this company's jobs, with photo/name status. */
async function listTechnicians(companyId) {
    await ensureSchema();
    const { rows } = await db.query(
        `SELECT techs.tech_id,
                COALESCE(p.name, techs.name) AS name,
                (p.photo_storage_key IS NOT NULL) AS has_photo
         FROM (
            SELECT DISTINCT t->>'id' AS tech_id, (array_agg(t->>'name'))[1] AS name
            FROM jobs j, jsonb_array_elements(j.assigned_techs) t
            WHERE j.company_id = $1 AND jsonb_typeof(j.assigned_techs) = 'array' AND (t->>'id') IS NOT NULL
            GROUP BY t->>'id'
         ) techs
         LEFT JOIN technician_profiles p ON p.company_id = $1 AND p.tech_id = techs.tech_id
         ORDER BY name NULLS LAST`,
        [companyId]
    );
    return rows;
}

async function getProfile(companyId, techId) {
    await ensureSchema();
    const { rows } = await db.query(
        `SELECT tech_id, name, photo_storage_key FROM technician_profiles WHERE company_id = $1 AND tech_id = $2`,
        [companyId, techId]
    );
    return rows[0] || null;
}

/** Upload (or replace) a technician photo. Deletes the previous object if any. */
async function uploadPhoto(companyId, techId, { name, file }) {
    await ensureSchema();
    const prev = await getProfile(companyId, techId);
    const storageKey = storageService.generateStorageKey(companyId, 'technician', techId, file.originalname || 'photo.jpg');
    await storageService.uploadFile(file.buffer, file.mimetype, storageKey);
    await db.query(
        `INSERT INTO technician_profiles (company_id, tech_id, name, photo_storage_key)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (company_id, tech_id) DO UPDATE SET
            name = COALESCE($3, technician_profiles.name),
            photo_storage_key = EXCLUDED.photo_storage_key,
            updated_at = NOW()`,
        [companyId, techId, name || null, storageKey]
    );
    if (prev?.photo_storage_key && prev.photo_storage_key !== storageKey) {
        try { await storageService.deleteFile(prev.photo_storage_key); } catch (e) { /* best-effort */ }
    }
    return { tech_id: techId, has_photo: true };
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

module.exports = { listTechnicians, getProfile, uploadPhoto, getTechnicianForInvoice };
