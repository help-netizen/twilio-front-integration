'use strict';

const DEFAULT_INSTALLATION_LIMIT = 60;
const DEFAULT_UNAUTHENTICATED_LIMIT = 60;
const DEFAULT_WINDOW_MS = 60_000;

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const INSTALLATION_LIMIT = positiveInteger(
    process.env.APP_RUNTIME_INSTALLATION_RATE_LIMIT,
    DEFAULT_INSTALLATION_LIMIT
);
const UNAUTHENTICATED_LIMIT = positiveInteger(
    process.env.APP_RUNTIME_UNAUTHENTICATED_RATE_LIMIT,
    DEFAULT_UNAUTHENTICATED_LIMIT
);
const WINDOW_MS = positiveInteger(
    process.env.APP_RUNTIME_RATE_WINDOW_MS,
    DEFAULT_WINDOW_MS
);

// APP-GW-001: this process-local store is valid only while the CRM is a single
// instance. A shared rate store is a hard prerequisite for horizontal scaling.
const installationWindows = new Map();
const unauthenticatedWindows = new Map();

function sweepExpired(store, now) {
    for (const [key, window] of store) {
        if (window.resetAt <= now) store.delete(key);
    }
}

function consume(store, key, limit, now = Date.now()) {
    sweepExpired(store, now);
    const current = store.get(key);
    const window = !current || current.resetAt <= now
        ? { count: 0, resetAt: now + WINDOW_MS }
        : current;
    window.count += 1;
    store.set(key, window);
    return {
        allowed: window.count <= limit,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
        remaining: Math.max(0, limit - window.count),
    };
}

function installationKey(installationId) {
    return `installation:${String(installationId)}`;
}

function requestIp(req) {
    // Express derives req.ip from its configured trust-proxy boundary. Raw XFF is
    // attacker-controlled when no trusted proxy is configured and must not key auth limits.
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function consumeInstallation(installationId, now) {
    return consume(
        installationWindows,
        installationKey(installationId),
        INSTALLATION_LIMIT,
        now
    );
}

function consumeUnauthenticated(req, now) {
    return consume(
        unauthenticatedWindows,
        `ip:${requestIp(req)}`,
        UNAUTHENTICATED_LIMIT,
        now
    );
}

function resetForTests() {
    installationWindows.clear();
    unauthenticatedWindows.clear();
}

function storeSizesForTests() {
    return {
        installations: installationWindows.size,
        unauthenticated: unauthenticatedWindows.size,
    };
}

module.exports = {
    DEFAULT_INSTALLATION_LIMIT,
    DEFAULT_UNAUTHENTICATED_LIMIT,
    DEFAULT_WINDOW_MS,
    INSTALLATION_LIMIT,
    UNAUTHENTICATED_LIMIT,
    WINDOW_MS,
    consumeInstallation,
    consumeUnauthenticated,
    resetForTests,
    storeSizesForTests,
};
