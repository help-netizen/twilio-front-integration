/**
 * companyProfileService.js — COMPANY-PROFILE-001
 *
 * Tenant-facing Company Profile: the single source of company identity + branding.
 * It is editable by the tenant and becomes the brand source overlaid onto
 * invoice/estimate PDF templates (see documentTemplatesService.resolveTemplate).
 *
 * Identity/contact/payment live directly on the `companies` row (migrations
 * 097 added city/state/zip/lat/lng; 134 added logo_storage_key + payment_*).
 * The logo is an uploadable object mirroring technician_profiles.photo_storage_key.
 *
 * The company NAME already flows into the ONWAY SMS via companies.name — this
 * service edits that same column, it does not introduce a parallel name.
 */

'use strict';

const db = require('../db/connection');
const companyQueries = require('../db/companyQueries');
const storageService = require('./storageService');

class CompanyProfileError extends Error {
    constructor(code, httpStatus, message) {
        super(message);
        this.name = 'CompanyProfileError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

// Fields a tenant may edit through this profile path. Deliberately excludes
// status / company_id / slug / zenbooker_api_key / timezone / locale, and the
// address (city/state/zip/lat/lng) which stays on the CompanyBaseAddress flow.
const UPDATE_WHITELIST = [
    'name',
    'contact_email',
    'contact_phone',
    'billing_email',
    'payment_bank_name',
    'payment_account_name',
    'payment_account_number',
    'payment_routing_number',
    'payment_swift',
    'payment_instructions',
];

function trimOrNull(v) {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s.length ? s : null;
}

/** Read the full company row including the profile/branding columns. */
async function getCompanyRow(companyId) {
    const { rows } = await db.query(
        `SELECT id, name, contact_email, contact_phone, billing_email,
                city, state, zip, lat, lng, logo_storage_key,
                payment_bank_name, payment_account_name, payment_account_number,
                payment_routing_number, payment_swift, payment_instructions
         FROM companies WHERE id = $1`,
        [companyId]
    );
    return rows[0] || null;
}

async function presign(storageKey) {
    if (!storageKey) return null;
    try {
        return await storageService.getPresignedUrl(storageKey);
    } catch (e) {
        return null; // best-effort: a broken logo must not break the profile
    }
}

/**
 * getProfile — the tenant-editable view of company identity + branding.
 */
async function getProfile(companyId) {
    const row = await getCompanyRow(companyId);
    if (!row) throw new CompanyProfileError('NOT_FOUND', 404, 'Company not found');
    return {
        name: row.name || null,
        contact_email: row.contact_email || null,
        contact_phone: row.contact_phone || null,
        billing_email: row.billing_email || null,
        city: row.city || null,
        state: row.state || null,
        zip: row.zip || null,
        logo_url: await presign(row.logo_storage_key),
        payment: {
            bank_name: row.payment_bank_name || null,
            account_name: row.payment_account_name || null,
            account_number: row.payment_account_number || null,
            routing_number: row.payment_routing_number || null,
            swift: row.payment_swift || null,
            instructions: row.payment_instructions || null,
        },
    };
}

/**
 * updateProfile — whitelist-only update. Trims strings, rejects an empty name (422),
 * and routes through companyQueries.updateCompany so nothing outside the whitelist
 * can be written.
 */
async function updateProfile(companyId, fields = {}) {
    const update = {};
    for (const key of UPDATE_WHITELIST) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) {
            update[key] = trimOrNull(fields[key]);
        }
    }

    // name is required identity: if the caller sends it, it must not be empty.
    if (Object.prototype.hasOwnProperty.call(update, 'name') && !update.name) {
        throw new CompanyProfileError('INVALID_NAME', 422, 'Company name cannot be empty');
    }

    if (Object.keys(update).length > 0) {
        await companyQueries.updateCompany(companyId, update);
    }
    return getProfile(companyId);
}

/**
 * uploadLogo — store a new logo object, point companies.logo_storage_key at it,
 * and best-effort delete the previous object. Mirrors technicianProfilesService.uploadPhoto.
 */
async function uploadLogo(companyId, file) {
    if (!file || !file.buffer) {
        throw new CompanyProfileError('NO_FILE', 400, 'Image file required');
    }
    const prev = await getCompanyRow(companyId);
    const storageKey = storageService.generateStorageKey(
        companyId, 'company', 'logo', file.originalname || 'logo.png'
    );
    await storageService.uploadFile(file.buffer, file.mimetype, storageKey);
    await companyQueries.updateCompany(companyId, { logo_storage_key: storageKey });
    if (prev?.logo_storage_key && prev.logo_storage_key !== storageKey) {
        try { await storageService.deleteFile(prev.logo_storage_key); } catch (e) { /* best-effort */ }
    }
    return { logo_url: await presign(storageKey) };
}

function composeAddress(row) {
    // Compose "City, ST ZIP" from whatever address parts exist.
    const cityState = [row.city, row.state].filter((p) => trimOrNull(p)).join(', ');
    const line = [cityState, trimOrNull(row.zip)].filter(Boolean).join(' ');
    return trimOrNull(line);
}

/**
 * buildBrand — the company-profile overlay for document templates. Returns ONLY
 * the non-empty fields so it never blanks out a template's existing values.
 *
 * Maps company payment_* → brand.ach.* using the EXACT factory ach field names
 * (`bank`, `routing_number`, `account_number`) plus richer extras the profile
 * carries (`account_name`, `swift`, `instructions`).
 */
async function buildBrand(companyId) {
    const row = await getCompanyRow(companyId);
    if (!row) return {};

    const brand = {};
    const name = trimOrNull(row.name);
    if (name) brand.name = name;
    const address = composeAddress(row);
    if (address) brand.address = address;
    const email = trimOrNull(row.contact_email);
    if (email) brand.email = email;
    const phone = trimOrNull(row.contact_phone);
    if (phone) brand.phone = phone;
    const logoUrl = await presign(row.logo_storage_key);
    if (logoUrl) brand.logo_url = logoUrl;

    const ach = {};
    const bank = trimOrNull(row.payment_bank_name);
    if (bank) ach.bank = bank;
    const routing = trimOrNull(row.payment_routing_number);
    if (routing) ach.routing_number = routing;
    const account = trimOrNull(row.payment_account_number);
    if (account) ach.account_number = account;
    const accountName = trimOrNull(row.payment_account_name);
    if (accountName) ach.account_name = accountName;
    const swift = trimOrNull(row.payment_swift);
    if (swift) ach.swift = swift;
    const instructions = trimOrNull(row.payment_instructions);
    if (instructions) ach.instructions = instructions;
    if (Object.keys(ach).length > 0) brand.ach = ach;

    return brand;
}

module.exports = {
    CompanyProfileError,
    getProfile,
    updateProfile,
    uploadLogo,
    buildBrand,
};
