/**
 * Snooze Scheduler Service
 * Periodically checks for snoozed threads whose snooze has expired,
 * unsnoozes them, and broadcasts SSE events so UI updates in real time.
 */
const queries = require('../db/queries');

const INTERVAL_MS = 60_000; // Check every 60 seconds
let intervalHandle = null;

async function tick() {
    try {
        const unsnoozedIds = await queries.unsnoozeExpiredThreads();
        if (unsnoozedIds.length > 0) {
            const realtimeService = require('./realtimeService');
            for (const timelineId of unsnoozedIds) {
                realtimeService.broadcast('thread.unsnoozed', { timelineId });
            }
            console.log(`[SnoozeScheduler] Unsnoozed ${unsnoozedIds.length} thread(s): ${unsnoozedIds.join(', ')}`);
        }
    } catch (error) {
        console.error('[SnoozeScheduler] tick error:', error.message);
    }
}

function start() {
    if (intervalHandle) return;
    console.log('[SnoozeScheduler] Started (interval: 60s)');
    intervalHandle = setInterval(tick, INTERVAL_MS);
    // Run once immediately on start
    tick();
}

function stop() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
        console.log('[SnoozeScheduler] Stopped');
    }
}

module.exports = { start, stop, tick };
