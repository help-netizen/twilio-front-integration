/**
 * routeQueries.js — SCHED-ROUTE-001 data layer.
 *
 * Tenant-safe access to schedule_route_segments (every query filters by
 * company_id) and the GLOBAL route_calculation_cache (keyed by rounded coords,
 * no company_id — distance between two points is tenant-independent, C-4).
 * All SQL is parameterized.
 */

const db = require('../db/connection');

// ── Timezone resolution (C-3: dispatch override, else company, else default) ──
async function getCompanyTimezone(companyId) {
    const { rows } = await db.query(
        `SELECT COALESCE(ds.timezone, c.timezone, 'America/New_York') AS tz
         FROM companies c
         LEFT JOIN dispatch_settings ds ON ds.company_id = c.id
         WHERE c.id = $1`,
        [companyId]
    );
    return rows[0]?.tz || 'America/New_York';
}

// Statuses that never participate in routing (C: spec product decisions).
const EXCLUDED_STATUSES = ['Canceled', 'Job is Done'];

/**
 * Participating jobs for one technician (internal crm_users.id) on one
 * company-local day, in the SAME order the UI uses (C-1: start_date ASC,
 * created_at DESC). Day is computed in the company timezone (C-3).
 */
async function getParticipatingJobsForTechDay(companyId, technicianId, scheduleDate, tz) {
    const { rows } = await db.query(
        `SELECT id, start_date, created_at, lat, lng, address, geocoding_status
         FROM jobs
         WHERE company_id = $1
           AND assigned_provider_user_ids @> $2::jsonb
           AND start_date IS NOT NULL
           AND (start_date AT TIME ZONE $3)::date = $4::date
           AND blanc_status <> ALL($5)
         ORDER BY start_date ASC, created_at DESC`,
        [companyId, JSON.stringify([technicianId]), tz, scheduleDate, EXCLUDED_STATUSES]
    );
    return rows;
}

/** Distinct (technician_id, company-local day) pairs a job currently belongs to. */
async function getTechDaysForJob(companyId, jobId, tz) {
    const { rows } = await db.query(
        `SELECT DISTINCT elem AS technician_id,
                (start_date AT TIME ZONE $3)::date AS schedule_date
         FROM jobs, jsonb_array_elements_text(assigned_provider_user_ids) elem
         WHERE company_id = $1 AND id = $2 AND start_date IS NOT NULL`,
        [companyId, jobId, tz]
    );
    return rows.map(r => ({ technicianId: r.technician_id, scheduleDate: r.schedule_date }));
}

// ── Backfill / seed helpers (SR-10) ──────────────────────────────────────────
/** Every company with its resolved routing timezone (dispatch override → company → default). */
async function getCompaniesWithTimezone() {
    const { rows } = await db.query(
        `SELECT c.id AS company_id,
                COALESCE(ds.timezone, c.timezone, 'America/New_York') AS tz
         FROM companies c
         LEFT JOIN dispatch_settings ds ON ds.company_id = c.id`
    );
    return rows.map(r => ({ companyId: r.company_id, tz: r.tz }));
}

/**
 * Distinct (technician_id, company-local day) pairs to seed for ONE company:
 * today + future only (company-local, C-3) so the one-time backfill never pays
 * to route past days. Same participation rules as the live engine.
 */
async function getSeedTechDays(companyId, tz) {
    const { rows } = await db.query(
        `SELECT DISTINCT elem AS technician_id,
                (start_date AT TIME ZONE $2)::date AS schedule_date
         FROM jobs, jsonb_array_elements_text(assigned_provider_user_ids) elem
         WHERE company_id = $1
           AND start_date IS NOT NULL
           AND blanc_status <> ALL($3)
           AND (start_date AT TIME ZONE $2)::date >= (now() AT TIME ZONE $2)::date
         ORDER BY schedule_date, technician_id`,
        [companyId, tz, EXCLUDED_STATUSES]
    );
    return rows.map(r => ({ technicianId: r.technician_id, scheduleDate: r.schedule_date }));
}

// ── Segment reads ─────────────────────────────────────────────────────────────
async function getActiveSegments(companyId, technicianId, scheduleDate) {
    const { rows } = await db.query(
        `SELECT * FROM schedule_route_segments
         WHERE company_id = $1 AND technician_id = $2 AND schedule_date = $3::date
           AND status <> 'stale'`,
        [companyId, technicianId, scheduleDate]
    );
    return rows;
}

/** Schedule-read endpoint: segments in a date range, optionally one technician. */
async function getSegmentsForRange(companyId, { from, to, technicianId } = {}) {
    const conds = ['company_id = $1', "status <> 'stale'"];
    const params = [companyId];
    if (from) { params.push(from); conds.push(`schedule_date >= $${params.length}::date`); }
    if (to) { params.push(to); conds.push(`schedule_date <= $${params.length}::date`); }
    if (technicianId) { params.push(technicianId); conds.push(`technician_id = $${params.length}`); }
    const { rows } = await db.query(
        `SELECT id, technician_id, schedule_date, from_job_id, to_job_id,
                distance_meters, duration_minutes, travel_mode, status, calculated_at
         FROM schedule_route_segments
         WHERE ${conds.join(' AND ')}
         ORDER BY schedule_date, technician_id, from_job_id`,
        params
    );
    return rows;
}

// ── Segment writes ────────────────────────────────────────────────────────────
/** Flip the given active pairs to stale. pairs = [[fromId,toId], …]. */
async function markSegmentsStale(companyId, technicianId, scheduleDate, pairs) {
    if (!pairs?.length) return 0;
    let n = 0;
    for (const [fromId, toId] of pairs) {
        const { rowCount } = await db.query(
            `UPDATE schedule_route_segments
             SET status = 'stale', stale_at = now(), updated_at = now()
             WHERE company_id = $1 AND technician_id = $2 AND schedule_date = $3::date
               AND from_job_id = $4 AND to_job_id = $5 AND status <> 'stale'`,
            [companyId, technicianId, scheduleDate, fromId, toId]
        );
        n += rowCount;
    }
    return n;
}

/**
 * Create an active segment in an initial state (pending / missing_address /
 * address_needs_review). Idempotent: ON CONFLICT on the active partial-unique
 * index does nothing (a concurrent recalc already created it). Returns the row
 * or null if it already existed.
 */
async function insertSegment(seg) {
    const { rows } = await db.query(
        `INSERT INTO schedule_route_segments
            (company_id, technician_id, technician_source, schedule_date,
             from_job_id, to_job_id, from_latitude, from_longitude,
             to_latitude, to_longitude, travel_mode, status, cache_key)
         VALUES ($1,$2,'company_user',$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (company_id, technician_id, schedule_date, from_job_id, to_job_id)
            WHERE status <> 'stale'
         DO NOTHING
         RETURNING *`,
        [seg.companyId, seg.technicianId, seg.scheduleDate, seg.fromJobId, seg.toJobId,
         seg.fromLat ?? null, seg.fromLng ?? null, seg.toLat ?? null, seg.toLng ?? null,
         seg.travelMode || 'driving', seg.status, seg.cacheKey ?? null]
    );
    return rows[0] || null;
}

/** Fill in a result (success/failed) for an existing segment id. */
async function setSegmentResult(companyId, segmentId, result) {
    await db.query(
        `UPDATE schedule_route_segments
         SET status = $3, distance_meters = $4, duration_minutes = $5,
             cache_key = COALESCE($6, cache_key), error_code = $7, error_message = $8,
             calculated_at = now(), updated_at = now()
         WHERE company_id = $1 AND id = $2 AND status <> 'stale'`,
        [companyId, segmentId, result.status, result.distanceMeters ?? null,
         result.durationMinutes ?? null, result.cacheKey ?? null,
         result.errorCode ?? null, result.errorMessage ?? null]
    );
}

/** Active pending/calculable segments needing a route_calc (worker pulls these). */
async function getCalculableSegments(companyId, technicianId, scheduleDate) {
    const { rows } = await db.query(
        `SELECT * FROM schedule_route_segments
         WHERE company_id = $1 AND technician_id = $2 AND schedule_date = $3::date
           AND status = 'pending'
           AND from_latitude IS NOT NULL AND to_latitude IS NOT NULL`,
        [companyId, technicianId, scheduleDate]
    );
    return rows;
}

// ── GLOBAL route cache (no company_id — C-4) ─────────────────────────────────
async function getCache(cacheKey) {
    const { rows } = await db.query(
        `SELECT distance_meters, duration_minutes, status
         FROM route_calculation_cache WHERE cache_key = $1 AND status = 'success'`,
        [cacheKey]
    );
    return rows[0] || null;
}

async function putCache(entry) {
    await db.query(
        `INSERT INTO route_calculation_cache
            (origin_latitude, origin_longitude, destination_latitude, destination_longitude,
             travel_mode, cache_key, distance_meters, duration_minutes, status, error_code, error_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (cache_key) DO UPDATE SET
            distance_meters = EXCLUDED.distance_meters,
            duration_minutes = EXCLUDED.duration_minutes,
            status = EXCLUDED.status, updated_at = now()`,
        [entry.originLat, entry.originLng, entry.destLat, entry.destLng,
         entry.travelMode || 'driving', entry.cacheKey,
         entry.distanceMeters ?? null, entry.durationMinutes ?? null,
         entry.status || 'success', entry.errorCode ?? null, entry.errorMessage ?? null]
    );
}

module.exports = {
    EXCLUDED_STATUSES,
    getCompanyTimezone,
    getCompaniesWithTimezone,
    getSeedTechDays,
    getParticipatingJobsForTechDay,
    getTechDaysForJob,
    getActiveSegments,
    getSegmentsForRange,
    markSegmentsStale,
    insertSegment,
    setSegmentResult,
    getCalculableSegments,
    getCache,
    putCache,
};
