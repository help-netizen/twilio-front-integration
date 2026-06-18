/**
 * routeRetentionScheduler — SCHED-ROUTE-001 (C-13) retention.
 * Once a day, deletes stale route segments older than 30 days and prunes
 * route-cache rows untouched for 180 days, so neither table grows unbounded.
 * Both deletes are idempotent; the first tick runs ~1 min after boot.
 */
const routeQueries = require('../db/routeQueries');

const INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const FIRST_DELAY_MS = 60 * 1000;        // let boot settle before the first sweep
const STALE_DAYS = 30;
const CACHE_DAYS = 180;
let handle = null;

async function tick() {
    try {
        const seg = await routeQueries.purgeStaleSegments(STALE_DAYS);
        const cache = await routeQueries.pruneRouteCache(CACHE_DAYS);
        if (seg || cache) console.log(`[RouteRetention] purged ${seg} stale segment(s), ${cache} cache row(s)`);
    } catch (e) {
        console.error('[RouteRetention] tick error:', e.message);
    }
}

function start() {
    if (handle) return;
    handle = setInterval(tick, INTERVAL_MS);
    console.log('[RouteRetention] Started (daily tick)');
    setTimeout(tick, FIRST_DELAY_MS);
}

function stop() {
    if (handle) { clearInterval(handle); handle = null; }
}

module.exports = { start, stop, tick };
