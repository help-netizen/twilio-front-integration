'use strict';

/**
 * ZB-DECOUPLE Phase C3 — native technician-directory maintenance.
 *
 * Native technician-directory maintenance and membership projection.
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
 * ZB-DECOUPLE C3b/E — USERS-FIRST projection (owner 2026-08-09: «роль provider ⇒
 * автоматически техник; техники не создаются вручную, они из раздела
 * пользователей»; Phase E: «Also works in the field» тоже ⇒ нативный техник):
 * Idempotent, company-scoped. A FIELD WORKER = role=provider OR the profile
 * is_provider flag.
 *
 *   • every ACTIVE field-worker membership has an ACTIVE technician:
 *     find by crm link → reactivate; otherwise create one
 *     (display_name from the user, only at creation — manual renames stick);
 *   • an ACTIVE technician LINKED to a user who is no longer an active field
 *     worker is deactivated (work history stays);
 *   • UNLINKED technicians are never touched (the owner links historical ones
 *     себе later; manual create stays as the temporary fallback).
 */
async function projectFromMemberships(companyId) {
    const fieldWorkers = await membershipQueries.listActiveFieldWorkerMemberships(companyId);
    const fieldWorkerIds = new Set(fieldWorkers.map(row => String(row.user_id)));
    const summary = { created: 0, reactivated: 0, adopted: 0, deactivated: 0 };

    for (const provider of fieldWorkers) {
        const userId = String(provider.user_id);
        const existing = await technicianDirectoryQueries.findTechnicianByCrmUserId(companyId, userId);
        if (existing) {
            if (!existing.active) {
                await technicianDirectoryQueries.updateTechnician({
                    companyId, technicianId: existing.id, active: true,
                });
                summary.reactivated += 1;
            }
            continue;
        }

        await technicianDirectoryQueries.createTechnician({
            companyId,
            displayName: String(provider.full_name || provider.email || 'Technician').trim() || 'Technician',
            active: true,
            crmUserId: userId,
        });
        summary.created += 1;
    }

    // Linked + active technicians whose user is no longer an active field worker → off.
    const directory = await technicianDirectoryQueries.listTechnicians(companyId);
    for (const technician of directory) {
        if (!technician.active || technician.crm_user_id == null) continue;
        if (!fieldWorkerIds.has(String(technician.crm_user_id))) {
            await technicianDirectoryQueries.updateTechnician({
                companyId, technicianId: technician.id, active: false,
            });
            summary.deactivated += 1;
        }
    }
    return summary;
}

module.exports = {
    createNativeTechnician,
    updateNativeTechnician,
    listDirectory,
    projectFromMemberships,
    TechnicianDirectoryError,
};
