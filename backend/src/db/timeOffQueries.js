/**
 * Time Off Queries — TECH-DAYOFF-001 (DO-01)
 *
 * Data access for technician_time_off (migration 167). Every query is
 * parameterized and company_id-scoped (tenant isolation).
 *
 * Interval semantics (INV-8): periods are half-open UTC intervals
 * [starts_at, ends_at). Range reads use strict overlap
 * (starts_at < $to AND ends_at > $from) — records merely touching a boundary
 * do NOT overlap. Multi-day / cross-midnight periods are single rows and are
 * never sliced per-date.
 *
 * batch_id is audit-only: there is deliberately NO delete-by-batch here or
 * anywhere else (INV-6 — deletion is always per-row).
 */

const db = require('./connection');
const directoryQueries = require('./technicianDirectoryQueries');

const RETURN_COLUMNS = `id, company_id, technician_uuid::text AS technician_id, technician_name,
        starts_at, ends_at, note, source, batch_id, created_by, created_at`;

function invalidTechnicianIdentityError() {
    const error = new Error('Technician identity not found');
    error.code = 'TECHNICIAN_IDENTITY_NOT_FOUND';
    error.httpStatus = 404;
    return error;
}

async function resolveTechnicianIdentity(companyId, technicianId, { required = true } = {}) {
    const input = technicianId == null ? '' : String(technicianId).trim();
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

/**
 * List time-off records overlapping the half-open range [from, to),
 * optionally narrowed to one technician (native UUID or inbound legacy id).
 *
 * Past records are NOT trimmed — the caller owns the range.
 *
 * @param {string} companyId - tenant company id (required)
 * @param {Object} opts
 * @param {string} opts.from - UTC ISO range start (inclusive)
 * @param {string} opts.to - UTC ISO range end (exclusive)
 * @param {string} [opts.technicianId] - optional technician UUID/legacy-id filter
 * @returns {Promise<Object[]>} rows ordered by starts_at
 */
async function listRange(companyId, { from, to, technicianId } = {}) {
    const params = [companyId, from, to];
    let technicianMatchKey = null;
    if (technicianId) {
        const identity = await resolveTechnicianIdentity(
            companyId,
            technicianId,
            { required: false }
        );
        if (!identity) return [];
        technicianMatchKey = identity.technicianUuid;
        params.push(identity.technicianUuid);
    }
    let sql = `SELECT ${RETURN_COLUMNS}
         FROM technician_time_off
         WHERE company_id = $1
           AND starts_at < $3
           AND ends_at > $2`;
    if (technicianMatchKey) {
        sql += `
           AND technician_uuid = $4::uuid`;
    }
    sql += `
         ORDER BY starts_at ASC, id ASC`;
    const { rows } = await db.query(sql, params);
    return rows;
}

/**
 * Seam-facing overlap read (slotEngineService.getRecommendations, DO-02):
 * all records of the company overlapping [fromUtc, toUtc). Errors propagate
 * to the caller (E-15 — never swallowed into "0 rows").
 *
 * @param {string} companyId
 * @param {string} fromUtc - UTC ISO horizon start (inclusive)
 * @param {string} toUtc - UTC ISO horizon end (exclusive)
 * @returns {Promise<Object[]>}
 */
async function listOverlappingRange(companyId, fromUtc, toUtc) {
    return listRange(companyId, { from: fromUtc, to: toUtc });
}

/**
 * Insert a single (individual) time-off row.
 *
 * @param {string} companyId
 * @param {Object} row - { technicianId, technicianName, startsAt, endsAt,
 *                         note, source, batchId, createdBy }
 * @returns {Promise<Object>} the created row
 */
async function insertOne(companyId, row) {
    const identity = await resolveTechnicianIdentity(companyId, row.technicianId);
    const { rows } = await db.query(
        `INSERT INTO technician_time_off
            (company_id, technician_uuid, technician_name,
             starts_at, ends_at, note, source, batch_id, created_by)
         VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${RETURN_COLUMNS}`,
        [
            companyId,
            identity.technicianUuid,
            row.technicianName ?? null,
            row.startsAt,
            row.endsAt,
            row.note ?? null,
            row.source || 'individual',
            row.batchId ?? null,
            row.createdBy ?? null,
        ]
    );
    return rows[0];
}

/**
 * Insert K rows as ONE multi-row INSERT statement (company-wide
 * materialization, E-3 atomicity: either all K rows land or none).
 *
 * @param {string} companyId
 * @param {Object[]} timeOffRows - same shape as insertOne's row
 * @returns {Promise<Object[]>} created rows
 */
async function insertMany(companyId, timeOffRows) {
    if (!Array.isArray(timeOffRows) || timeOffRows.length === 0) return [];
    const identities = await Promise.all(
        timeOffRows.map(row => resolveTechnicianIdentity(companyId, row.technicianId))
    );
    const params = [companyId];
    const tuples = timeOffRows.map((row, index) => {
        const base = params.length;
        params.push(
            identities[index].technicianUuid,
            row.technicianName ?? null,
            row.startsAt,
            row.endsAt,
            row.note ?? null,
            row.source || 'company',
            row.batchId ?? null,
            row.createdBy ?? null
        );
        return `($1, $${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
    });
    const { rows } = await db.query(
        `INSERT INTO technician_time_off
            (company_id, technician_uuid, technician_name,
             starts_at, ends_at, note, source, batch_id, created_by)
         VALUES ${tuples.join(', ')}
         RETURNING ${RETURN_COLUMNS}`,
        params
    );
    return rows;
}

/**
 * Delete one time-off row inside one tenant. A foreign tenant's id matches
 * zero rows — indistinguishable from a missing id (E-13).
 *
 * @param {string} companyId
 * @param {string} id - technician_time_off.id (uuid)
 * @returns {Promise<number>} affected row count (0 or 1)
 */
async function deleteById(companyId, id) {
    const result = await db.query(
        `DELETE FROM technician_time_off
         WHERE id = $1 AND company_id = $2`,
        [id, companyId]
    );
    return result.rowCount || 0;
}

module.exports = {
    listRange,
    listOverlappingRange,
    insertOne,
    insertMany,
    deleteById,
    resolveTechnicianIdentity,
};
