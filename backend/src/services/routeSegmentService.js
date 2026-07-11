/**
 * routeSegmentService.js — SCHED-ROUTE-001 recalculation orchestration.
 *
 * Reconciles ONE technician/day to its desired adjacent-pair set (local, not a
 * full-day rebuild). Idempotent: re-running yields the same active segments.
 * Enqueues async work on the existing agentWorker (job_geocode / route_calc) so
 * HTTP saves never block on Google latency.
 */

const db = require('../db/connection');
const routeQueries = require('../db/routeQueries');
const { adjacentPairs, diffPairs } = require('./routeGeo');

// ── async task enqueue (reuses agentWorker; kind='agent') ────────────────────
async function enqueueAgentTask(companyId, agentType, input, title) {
    await db.query(
        `INSERT INTO tasks (company_id, kind, agent_type, agent_status, agent_input, status, title, created_by)
         VALUES ($1, 'agent', $2, 'queued', $3::jsonb, 'open', $4, 'system')`,
        [companyId, agentType, JSON.stringify(input || {}), title || agentType]
    );
}

const enqueueGeocode = (companyId, jobId) =>
    enqueueAgentTask(companyId, 'job_geocode', { job_id: jobId }, `Geocode job ${jobId}`);

const enqueueRouteCalc = (companyId, technicianId, scheduleDate) =>
    enqueueAgentTask(companyId, 'route_calc',
        { technician_id: technicianId, schedule_date: scheduleDate },
        `Route calc ${technicianId} ${scheduleDate}`);

/**
 * SCHED-ROUTE-VIS-001 (FR-2): dedup-guarded route_calc enqueue for the
 * lazy-on-read seeder. Skips the INSERT when a task with agent_status='queued'
 * already exists for the same (company, technician, day) — a queued task will
 * run AFTER our inserts, so a duplicate buys nothing. Deliberately does NOT
 * guard against 'running' (E-7): the worker may have already read the segments,
 * so a duplicate beside a running task closes that race; the extra task is a
 * no-op (getCalculableSegments comes back empty). Plain enqueueRouteCalc stays
 * as-is for the low-frequency event-driven hooks.
 */
async function enqueueRouteCalcDeduped(companyId, technicianId, scheduleDate) {
    await db.query(
        `INSERT INTO tasks (company_id, kind, agent_type, agent_status, agent_input, status, title, created_by)
         SELECT $1, 'agent', 'route_calc', 'queued', $4::jsonb, 'open', $5, 'system'
         WHERE NOT EXISTS (
             SELECT 1 FROM tasks
             WHERE company_id = $1
               AND kind = 'agent'
               AND agent_type = 'route_calc'
               AND agent_status = 'queued'
               AND agent_input->>'technician_id' = $2
               AND agent_input->>'schedule_date' = $3
         )`,
        [companyId, technicianId, scheduleDate,
         JSON.stringify({ technician_id: technicianId, schedule_date: scheduleDate }),
         `Route calc ${technicianId} ${scheduleDate}`]
    );
}

// ── initial segment status from a pair's coordinates ─────────────────────────
function pairInitialStatus(fromJob, toJob) {
    const usable = (j) => j && j.lat != null && j.lng != null;
    if (usable(fromJob) && usable(toJob)) return 'pending';        // calculable
    const noAddr = (j) => !j || !j.address || !String(j.address).trim();
    if (noAddr(fromJob) || noAddr(toJob)) return 'missing_address';
    return 'address_needs_review';                                  // address but no usable coords
}

/**
 * Reconcile one technician/day. Returns { stale, created, enqueuedCalc }.
 * @param changedJobIds jobs whose address/coords changed (force recalc of
 *        surviving pairs touching them).
 */
async function reconcileTechDay(companyId, technicianId, scheduleDate, { tz, changedJobIds = [] } = {}) {
    const timezone = tz || await routeQueries.getCompanyTimezone(companyId);
    const jobs = await routeQueries.getParticipatingJobsForTechDay(companyId, technicianId, scheduleDate, timezone);
    const jobById = new Map(jobs.map(j => [String(j.id), j]));
    const desiredPairs = adjacentPairs(jobs.map(j => String(j.id)));

    const active = await routeQueries.getActiveSegments(companyId, technicianId, scheduleDate);
    const activePairs = active.map(s => [String(s.from_job_id), String(s.to_job_id)]);

    const { stale, toCalc } = diffPairs(activePairs, desiredPairs, changedJobIds.map(String));

    await routeQueries.markSegmentsStale(companyId, technicianId, scheduleDate, stale);

    let created = 0;
    let anyCalculable = false;
    for (const [fromId, toId] of toCalc) {
        const fromJob = jobById.get(String(fromId));
        const toJob = jobById.get(String(toId));
        const status = pairInitialStatus(fromJob, toJob);
        const row = await routeQueries.insertSegment({
            companyId, technicianId, scheduleDate, fromJobId: Number(fromId), toJobId: Number(toId),
            fromLat: fromJob?.lat, fromLng: fromJob?.lng, toLat: toJob?.lat, toLng: toJob?.lng,
            status,
        });
        if (row) created++;
        if (status === 'pending') anyCalculable = true;
    }

    let enqueuedCalc = false;
    if (anyCalculable) { await enqueueRouteCalc(companyId, technicianId, scheduleDate); enqueuedCalc = true; }
    return { stale: stale.length, created, enqueuedCalc };
}

/**
 * Entry point after a job create/edit. Reconciles every technician/day the job
 * touches now, plus any it touched before (passed by the caller as
 * beforeTechDays = [{technicianId, scheduleDate}]) so vacated sequences repair.
 */
async function recalcForJob(companyId, jobId, { beforeTechDays = [], coordsChanged = false } = {}) {
    const tz = await routeQueries.getCompanyTimezone(companyId);
    const after = await routeQueries.getTechDaysForJob(companyId, jobId, tz);
    // Union of before + after tech/day pairs.
    const seen = new Set();
    const all = [];
    for (const td of [...beforeTechDays, ...after]) {
        const k = `${td.technicianId}|${td.scheduleDate}`;
        if (seen.has(k)) continue;
        seen.add(k); all.push(td);
    }
    const results = [];
    for (const td of all) {
        results.push(await reconcileTechDay(companyId, td.technicianId, td.scheduleDate, {
            tz, changedJobIds: coordsChanged ? [jobId] : [],
        }));
    }
    return { techDays: all.length, results };
}

/**
 * SCHED-ROUTE-VIS-001 (FR-2): lazy-on-read self-heal for a schedule read range.
 * Fired via setImmediate from scheduleService.getRouteSegments — NEVER awaited
 * by the HTTP path. Finds up to `cap` missing/stuck tech-day pairs in [from,to]
 * (ORDER BY schedule_date; later reads advance the tail, S-13) and reconciles
 * each; reconcileTechDay itself enqueues route_calc when it creates new pending
 * pairs. When it didn't (stuck pending, desired == active, S-14) but calculable
 * pending segments exist, enqueue through the deduped path. DB-only + enqueue —
 * no Google here (INV-1). Errors are non-fatal by design.
 */
async function seedMissingForRange(companyId, { from, to, technicianId } = {}, { cap = 10 } = {}) {
    if (!from || !to) return;                                   // E-6 guard
    try {
        const tz = await routeQueries.getCompanyTimezone(companyId);
        const candidates = await routeQueries.getMissingTechDaysInRange(
            companyId, { from, to, technicianId }, tz, cap);
        for (const td of candidates) {
            const r = await reconcileTechDay(companyId, td.technicianId, td.scheduleDate, { tz });
            if (!r.enqueuedCalc) {
                const calculable = await routeQueries.getCalculableSegments(
                    companyId, td.technicianId, td.scheduleDate);
                if (calculable.length > 0) {
                    await enqueueRouteCalcDeduped(companyId, td.technicianId, td.scheduleDate);
                }
            }
        }
    } catch (e) {
        console.error('[Schedule] lazy route seed failed (non-fatal):', e.message);
    }
}

module.exports = {
    reconcileTechDay,
    recalcForJob,
    seedMissingForRange,
    enqueueGeocode,
    enqueueRouteCalc,
    enqueueRouteCalcDeduped,
    enqueueAgentTask,
    pairInitialStatus,
};
