/**
 * SCHED-ROUTE-001 (C-13) — route data retention.
 *
 * Deletes stale route segments older than STALE_DAYS (default 30) and prunes
 * GLOBAL route-cache rows untouched for CACHE_DAYS (default 180), so neither
 * table grows unbounded. Safe to re-run; intended as a periodic cron.
 *
 *   node scripts/purge-route-data.js [--stale-days=30] [--cache-days=180] [--dry-run]
 *   ssh deploy@108.61.87.117 'cd /opt/albusto && docker compose exec -T app node scripts/purge-route-data.js'
 */
const db = require('../backend/src/db/connection');
const routeQueries = require('../backend/src/db/routeQueries');

function argNum(name, def) {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    if (!hit) return def;
    const n = parseInt(hit.split('=')[1], 10);
    return Number.isFinite(n) ? n : def;
}

async function run() {
    const staleDays = argNum('stale-days', 30);
    const cacheDays = argNum('cache-days', 180);
    const dryRun = process.argv.includes('--dry-run');
    console.log(`[purge-routes] stale>${staleDays}d, cache>${cacheDays}d${dryRun ? ' (dry-run)' : ''}`);

    if (dryRun) {
        const seg = await db.query(
            `SELECT COUNT(*)::int n FROM schedule_route_segments
             WHERE status='stale' AND COALESCE(stale_at,updated_at,calculated_at) < now() - ($1||' days')::interval`,
            [String(staleDays)]);
        const cache = await db.query(
            `SELECT COUNT(*)::int n FROM route_calculation_cache
             WHERE COALESCE(updated_at,calculated_at) < now() - ($1||' days')::interval`,
            [String(cacheDays)]);
        console.log(`[purge-routes] would delete ${seg.rows[0].n} stale segment(s), ${cache.rows[0].n} cache row(s)`);
        return;
    }

    const segDeleted = await routeQueries.purgeStaleSegments(staleDays);
    const cacheDeleted = await routeQueries.pruneRouteCache(cacheDays);
    console.log(`[purge-routes] deleted ${segDeleted} stale segment(s), ${cacheDeleted} cache row(s)`);
}

module.exports = { run };

if (require.main === module) {
    run()
        .then(() => db.pool?.end?.())
        .then(() => process.exit(0))
        .catch((err) => { console.error('[purge-routes] fatal:', err); process.exit(1); });
}
