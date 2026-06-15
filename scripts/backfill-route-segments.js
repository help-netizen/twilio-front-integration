/**
 * SCHED-ROUTE-001 (SR-10) — one-time route-segment seed.
 *
 * For every company, reconciles each technician's today+future schedule days so
 * the timeline shows route connectors without waiting for a job edit to trigger
 * the first reconcile. Past days are intentionally skipped to bound Google cost
 * (getSeedTechDays filters to company-local today onward, C-3).
 *
 * reconcileTechDay() is idempotent and the partial-unique index prevents
 * duplicate active segments, so this script is safe to re-run. It only inserts
 * 'pending' segments + enqueues route_calc agent tasks — the existing
 * agentWorker performs the actual (cache-first) distance calls.
 *
 * Run locally:   node scripts/backfill-route-segments.js [--dry-run]
 * Run on prod:   ssh deploy@108.61.87.117 'cd /opt/albusto && \
 *                  docker compose exec -T app node scripts/backfill-route-segments.js'
 *
 * NOTE: geocoding_status backfill for legacy jobs is a separate, paid-call-free
 * step — see backend/db/migrations/108_sched_route_backfill.sql. Run that first.
 */
const db = require('../backend/src/db/connection');
const routeQueries = require('../backend/src/db/routeQueries');
const routeSeg = require('../backend/src/services/routeSegmentService');

async function run({ dryRun = process.argv.includes('--dry-run') } = {}) {
    const DRY_RUN = dryRun;
    console.log(`[seed-routes] start${DRY_RUN ? ' (dry-run)' : ''}`);
    const companies = await routeQueries.getCompaniesWithTimezone();
    console.log(`[seed-routes] ${companies.length} companies`);

    let totalDays = 0, totalCompanies = 0, totalCreated = 0, totalEnqueued = 0;

    for (const { companyId, tz } of companies) {
        let techDays;
        try {
            techDays = await routeQueries.getSeedTechDays(companyId, tz);
        } catch (err) {
            console.error(`[seed-routes] company ${companyId}: enumerate failed — ${err.message}`);
            continue;
        }
        if (!techDays.length) continue;
        totalCompanies++;
        console.log(`[seed-routes] company ${companyId} (${tz}): ${techDays.length} tech-day(s)`);

        for (const { technicianId, scheduleDate } of techDays) {
            totalDays++;
            if (DRY_RUN) continue;
            try {
                const r = await routeSeg.reconcileTechDay(companyId, technicianId, scheduleDate, { tz });
                totalCreated += r.created;
                if (r.enqueuedCalc) totalEnqueued++;
            } catch (err) {
                console.error(`[seed-routes]   ${technicianId} ${scheduleDate}: ${err.message}`);
            }
        }
    }

    console.log(`[seed-routes] done — ${totalCompanies} companies, ${totalDays} tech-days, ` +
        `${totalCreated} segments created, ${totalEnqueued} route_calc tasks enqueued` +
        `${DRY_RUN ? ' (dry-run: nothing written)' : ''}`);
}

module.exports = { run };

if (require.main === module) {
    run()
        .then(() => db.pool?.end?.())
        .then(() => process.exit(0))
        .catch((err) => { console.error('[seed-routes] fatal:', err); process.exit(1); });
}
