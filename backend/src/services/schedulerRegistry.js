'use strict';

const callbacks = new Map();

function register(name, callback) {
    if (!name || typeof callback !== 'function') {
        throw new Error('Scheduler registration requires name and callback');
    }
    callbacks.set(name, callback);
}

async function tick(now = new Date()) {
    const results = [];
    for (const [name, callback] of callbacks) {
        try {
            results.push({ name, ok: true, result: await callback(now) });
        } catch (error) {
            console.warn(`[schedulerRegistry] scheduler=${name} code=tick_failed`);
            results.push({ name, ok: false, error: error?.message || String(error) });
        }
    }
    return results;
}

function clearForTests() {
    callbacks.clear();
}

module.exports = { register, tick, _callbacks: callbacks, _clearForTests: clearForTests };
