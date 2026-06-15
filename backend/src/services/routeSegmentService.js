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

module.exports = {
    reconcileTechDay,
    recalcForJob,
    enqueueGeocode,
    enqueueRouteCalc,
    enqueueAgentTask,
    pairInitialStatus,
};
