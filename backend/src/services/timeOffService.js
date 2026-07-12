/**
 * Time Off Service — TECH-DAYOFF-001 (DO-01)
 *
 * Business logic for technician day-off periods (technician_time_off, mig 167):
 *   • listTimeOff — range read with provider assigned_only scoping: a provider
 *     is forced onto his OWN ZB team-member id via the bridge
 *     (company_user_profiles.zenbooker_team_member_id); no bridge → [] —
 *     deny-by-default (E-14), never tenant-wide.
 *   • createTimeOff — target 'technician' inserts ONE row (name snapshot from
 *     the client); target 'company' materializes K rows from the live ZB
 *     roster in ONE multi-row INSERT (E-3 atomicity), sharing a fresh batch_id.
 *   • deleteTimeOff — always per-row (INV-6); zero affected rows → 404
 *     (foreign tenant indistinguishable from a missing id, E-13).
 *
 * Errors carry { code, httpStatus } and are rendered by routes/schedule.js's
 * canonical { ok:false, error:{ code, message } } shape.
 */

const crypto = require('crypto');
const timeOffQueries = require('../db/timeOffQueries');
const membershipQueries = require('../db/membershipQueries');
const zenbookerClient = require('./zenbookerClient');

const NOTE_MAX_LENGTH = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class TimeOffServiceError extends Error {
    constructor(code, message, httpStatus = 500) {
        super(message);
        this.name = 'TimeOffServiceError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

/** Parse a strict ISO timestamp; returns a Date or null when invalid/absent. */
function parseInstant(value) {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * List time-off records overlapping [from, to), optionally filtered by
 * technician. Provider (assigned_only) scope is enforced server-side: the
 * technician_id query parameter is overwritten by the caller's own bridged
 * ZB id; without a bridge mapping the result is [] (deny-by-default).
 *
 * @param {string} companyId - req.companyFilter?.company_id
 * @param {Object} params - { from, to, technicianId? } (UTC ISO strings)
 * @param {Object} providerScope - getProviderScope(req) → { assignedOnly, userId }
 * @returns {Promise<Object[]>}
 */
async function listTimeOff(companyId, { from, to, technicianId } = {}, providerScope = { assignedOnly: false, userId: null }) {
    const fromDate = parseInstant(from);
    const toDate = parseInstant(to);
    if (!fromDate || !toDate) {
        throw new TimeOffServiceError('VALIDATION', 'from and to are required and must be valid ISO timestamps', 400);
    }
    if (fromDate.getTime() > toDate.getTime()) {
        throw new TimeOffServiceError('VALIDATION', 'from must not be after to', 400);
    }

    let effectiveTechnicianId = technicianId ? String(technicianId) : undefined;
    if (providerScope?.assignedOnly) {
        // Provider sees ONLY his own blocks: resolve his ZB id through the
        // bridge; request parameters never widen his visibility (S-8).
        if (!providerScope.userId) return [];
        const ownZbId = await membershipQueries.getZenbookerTeamMemberIdForUser(companyId, providerScope.userId);
        if (!ownZbId) return []; // no bridge mapping → deny-by-default (E-14)
        effectiveTechnicianId = ownZbId;
    }

    return timeOffQueries.listRange(companyId, {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        technicianId: effectiveTechnicianId,
    });
}

/**
 * Create time-off record(s).
 *
 * target 'technician' → ONE row, source='individual', batch_id=null; the
 * display name is the client's snapshot (ZB is NOT called, E-5: the id is not
 * validated against the roster — an orphaned row is harmless).
 *
 * target 'company' → the active ZB roster (exactly the buildTechnicians
 * contract) is materialized into K rows sharing one fresh batch_id via ONE
 * multi-row INSERT. Empty roster → 400 NO_ACTIVE_TECHNICIANS; ZB failure →
 * 502 ZENBOOKER_UNAVAILABLE; zero inserts in both cases (E-3).
 *
 * @param {string} companyId
 * @param {Object} payload - { target, technician_id?, technician_name?, starts_at, ends_at, note? }
 * @param {string|null} createdBy - req.user.crmUser?.id || null (NOT the Keycloak sub)
 * @returns {Promise<Object[]>} created rows (individual → array of 1)
 */
async function createTimeOff(companyId, payload = {}, createdBy = null) {
    const { target, starts_at: startsAtRaw, ends_at: endsAtRaw, note } = payload;

    if (target !== 'technician' && target !== 'company') {
        throw new TimeOffServiceError('VALIDATION', "target must be 'technician' or 'company'", 400);
    }
    if (startsAtRaw === undefined || startsAtRaw === null || startsAtRaw === '' ||
        endsAtRaw === undefined || endsAtRaw === null || endsAtRaw === '') {
        throw new TimeOffServiceError('MISSING_FIELD', 'starts_at and ends_at are required', 400);
    }
    const startsAt = parseInstant(startsAtRaw);
    const endsAt = parseInstant(endsAtRaw);
    if (!startsAt || !endsAt) {
        throw new TimeOffServiceError('VALIDATION', 'starts_at and ends_at must be valid ISO timestamps', 400);
    }
    if (endsAt.getTime() <= startsAt.getTime()) {
        throw new TimeOffServiceError('VALIDATION', 'ends_at must be after starts_at', 400);
    }
    // E-1: a fully past period is meaningless; starts_at in the past with a
    // future ends_at is allowed (an already-running absence entered late).
    if (endsAt.getTime() <= Date.now()) {
        throw new TimeOffServiceError('VALIDATION', 'ends_at must be in the future', 400);
    }
    let normalizedNote = null;
    if (note !== undefined && note !== null) {
        if (typeof note !== 'string') {
            throw new TimeOffServiceError('VALIDATION', 'note must be a string', 400);
        }
        if (note.length > NOTE_MAX_LENGTH) {
            throw new TimeOffServiceError('VALIDATION', `note must be at most ${NOTE_MAX_LENGTH} characters`, 400);
        }
        normalizedNote = note;
    }

    const startsAtIso = startsAt.toISOString();
    const endsAtIso = endsAt.toISOString();

    if (target === 'technician') {
        const technicianId = payload.technician_id != null ? String(payload.technician_id).trim() : '';
        if (!technicianId) {
            throw new TimeOffServiceError('MISSING_FIELD', "technician_id is required when target is 'technician'", 400);
        }
        const created = await timeOffQueries.insertOne(companyId, {
            technicianId,
            technicianName: payload.technician_name != null ? String(payload.technician_name) : null,
            startsAt: startsAtIso,
            endsAt: endsAtIso,
            note: normalizedNote,
            source: 'individual',
            batchId: null,
            createdBy,
        });
        return [created];
    }

    // target === 'company' — materialize over the active ZB roster.
    let members;
    try {
        members = await zenbookerClient.getTeamMembers(
            { service_provider: true, deactivated: false },
            companyId
        );
    } catch (err) {
        console.error('[TimeOff] ZB roster fetch failed:', err.message);
        throw new TimeOffServiceError('ZENBOOKER_UNAVAILABLE', 'Zenbooker roster is unavailable; no time off was created', 502);
    }
    const roster = Array.isArray(members) ? members : [];
    if (roster.length === 0) {
        throw new TimeOffServiceError('NO_ACTIVE_TECHNICIANS', 'No active technicians found to apply company-wide time off', 400);
    }

    const batchId = crypto.randomUUID();
    const rows = roster.map(m => ({
        technicianId: String(m.id),
        // Same display-name derivation as buildTechnicians (slotEngineService).
        technicianName: [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || m.name || String(m.id),
        startsAt: startsAtIso,
        endsAt: endsAtIso,
        note: normalizedNote,
        source: 'company',
        batchId,
        createdBy,
    }));
    return timeOffQueries.insertMany(companyId, rows);
}

/**
 * Delete ONE time-off row (never by batch, INV-6). Missing id and a foreign
 * tenant's id are the same 404 (E-13).
 *
 * @param {string} companyId
 * @param {string} id - technician_time_off.id (uuid)
 * @returns {Promise<{deleted: true}>}
 */
async function deleteTimeOff(companyId, id) {
    // A malformed uuid can never match a row — same 404, without letting the
    // cast error surface as a 500.
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
        throw new TimeOffServiceError('NOT_FOUND', 'Time off record not found', 404);
    }
    const count = await timeOffQueries.deleteById(companyId, id);
    if (!count) {
        throw new TimeOffServiceError('NOT_FOUND', 'Time off record not found', 404);
    }
    return { deleted: true };
}

module.exports = {
    listTimeOff,
    createTimeOff,
    deleteTimeOff,
    TimeOffServiceError,
    NOTE_MAX_LENGTH,
};
