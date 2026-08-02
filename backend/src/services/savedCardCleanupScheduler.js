'use strict';

const cleanupService = require('./savedCardCleanupService');

const INTERVAL_MS = 6 * 60 * 60 * 1000;
let nextRunAt = 0;
let running = false;

async function tick(now = new Date()) {
    const nowMs = new Date(now).getTime();
    if (running || nowMs < nextRunAt) return { skipped: true };
    running = true;
    nextRunAt = nowMs + INTERVAL_MS;
    try {
        const results = await cleanupService.cleanupAllExpiredSavedCards();
        return { skipped: false, results };
    } finally {
        running = false;
    }
}

function registerScheduler(registry) {
    registry.register('saved-card-cleanup', tick);
}

function resetForTests() {
    nextRunAt = 0;
    running = false;
}

module.exports = { INTERVAL_MS, tick, registerScheduler, _resetForTests: resetForTests };

