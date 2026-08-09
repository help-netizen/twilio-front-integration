'use strict';

/**
 * ZB-DECOUPLE Phase C3 — native technician-directory maintenance.
 *
 * Until now the native directory was import-only (seeded by the backfill CLI)
 * and the admin ZB-bridge editor updated ONLY the legacy company_user_profiles
 * bridge (spec deferred #3/#4). This service adds:
 *   • create / rename / (de)activate for native technicians (production CRUD);
 *   • syncBridgeLink — the users.js bridge editor now dual-writes the native
 *     plane: technicians.crm_user_id follows the ZB-bridge re-link.
 *
 * Plane rules: crm_user_id must be an ACTIVE member of the company (crm plane);
 * the ZB external id maps through technician_external_identities (roster plane).
 */

const technicianDirectoryQueries = require('../db/technicianDirectoryQueries');
const membershipQueries = require('../db/membershipQueries');

const SOURCE = 'zenbooker';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class TechnicianDirectoryError extends Error {
    constructor(code, message, httpStatus) {
        super(message);
        this.name = 'TechnicianDirectoryError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function cleanName(value) {
    const name = String(value ?? '').trim();
    if (!name) throw new TechnicianDirectoryError('INVALID_NAME', 'display_name is required', 400);
    if (name.length > 120) throw new TechnicianDirectoryError('INVALID_NAME', 'display_name must be at most 120 characters', 400);
    return name;
}

async function assertMemberOrThrow(companyId, crmUserId) {
    const membership = await membershipQueries.getActiveMembershipInCompany(String(crmUserId), companyId);
    if (!membership) {
        throw new TechnicianDirectoryError('INVALID_CRM_USER', 'crm_user_id is not an active member of this company', 400);
    }
}

/** Create a native technician; optional crm link and ZB compat identity. */
async function createNativeTechnician(companyId, { display_name, crm_user_id = null, zenbooker_external_id = null } = {}) {
    const displayName = cleanName(display_name);
    if (crm_user_id != null && String(crm_user_id).trim() !== '') {
        await assertMemberOrThrow(companyId, crm_user_id);
        // The partial unique index allows one technician per user — clear stale links first.
        await technicianDirectoryQueries.unlinkCrmUser({ companyId, crmUserId: String(crm_user_id) });
    } else {
        crm_user_id = null;
    }

    const technician = await technicianDirectoryQueries.createTechnician({
        companyId,
        displayName,
        active: true,
        crmUserId: crm_user_id ? String(crm_user_id) : null,
    });

    const externalId = zenbooker_external_id == null ? '' : String(zenbooker_external_id).trim();
    if (externalId) {
        const stored = await technicianDirectoryQueries.upsertExternalIdentity({
            companyId, source: SOURCE, externalId, technicianId: technician.id,
        });
        // upsert keeps a pre-existing mapping — a foreign claim is a conflict, not a repoint.
        if (!stored || String(stored.technician_id) !== String(technician.id)) {
            throw new TechnicianDirectoryError(
                'EXTERNAL_ID_TAKEN',
                `zenbooker_external_id ${externalId} is already mapped to another technician`,
                409
            );
        }
    }
    return technicianDirectoryQueries.getTechnicianById(companyId, technician.id);
}

/** Rename / (de)activate a native technician (company-scoped, 404 on unknown). */
async function updateNativeTechnician(companyId, technicianId, { display_name, active } = {}) {
    const id = String(technicianId || '').toLowerCase();
    if (!UUID_RE.test(id)) {
        throw new TechnicianDirectoryError('INVALID_TECHNICIAN_ID', 'technician id must be a uuid', 400);
    }
    const existing = await technicianDirectoryQueries.getTechnicianById(companyId, id);
    if (!existing) {
        throw new TechnicianDirectoryError('NOT_FOUND', 'Technician not found', 404);
    }
    const patch = { companyId, technicianId: id };
    if (display_name !== undefined) patch.displayName = cleanName(display_name);
    if (active !== undefined) patch.active = !!active;
    await technicianDirectoryQueries.updateTechnician(patch);
    return technicianDirectoryQueries.getTechnicianById(companyId, id);
}

/** Full directory (active + inactive) for the maintenance surface. */
async function listDirectory(companyId) {
    return technicianDirectoryQueries.listTechnicians(companyId);
}

/**
 * Deferred #3 fix: keep the native plane in step with the legacy ZB-bridge
 * editor. Called by routes/users.js AFTER company_user_profiles changes.
 *   newExternalId = null/''  → just unlink this user's native technician(s);
 *   newExternalId set        → unlink, then link the mapped native technician
 *                              (no-op with reason when the directory has no row
 *                              for that external id — e.g. before the backfill).
 * Never throws business errors at the caller — the bridge write already
 * happened; this reports what it did for the route's non-fatal log.
 */
async function syncBridgeLink(companyId, crmUserId, newExternalId) {
    const userId = String(crmUserId);
    const unlinked = await technicianDirectoryQueries.unlinkCrmUser({ companyId, crmUserId: userId });
    const externalId = newExternalId == null ? '' : String(newExternalId).trim();
    if (!externalId) {
        return { linked: false, unlinked_count: unlinked.length, reason: 'BRIDGE_CLEARED' };
    }
    const technicianUuid = await technicianDirectoryQueries.resolveExternalToUuid(companyId, SOURCE, externalId);
    if (!technicianUuid) {
        return { linked: false, unlinked_count: unlinked.length, reason: 'NO_NATIVE_TECHNICIAN' };
    }
    const technician = await technicianDirectoryQueries.linkCrmUser({
        companyId, technicianId: technicianUuid, crmUserId: userId,
    });
    return { linked: !!technician, unlinked_count: unlinked.length, technician_uuid: technicianUuid };
}

module.exports = {
    createNativeTechnician,
    updateNativeTechnician,
    listDirectory,
    syncBridgeLink,
    TechnicianDirectoryError,
};
