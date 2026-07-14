'use strict';

const rateMeService = require('../services/rateMeService');

const RATE_ME_PUBLIC_HOST = String(
    process.env.RATE_ME_PUBLIC_HOST || 'rate.albusto.com'
).trim().toLowerCase().replace(/\.+$/, '');
const RATE_ME_PASSTHROUGH_SUFFIXES = String(
    process.env.RATE_ME_PASSTHROUGH_SUFFIXES || 'localhost,127.0.0.1,::1,.fly.dev'
).split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);

function matchesPassThroughSuffix(host, suffix) {
    if (suffix.startsWith('.')) return host.endsWith(suffix);
    if (host === suffix) return true;
    return suffix.includes(':') && host === `[${suffix}]`;
}

function isPassThroughHost(host) {
    if (host === 'albusto.com' || host.endsWith('.albusto.com')) return true;
    return RATE_ME_PASSTHROUGH_SUFFIXES.some((suffix) => (
        matchesPassThroughSuffix(host, suffix)
    ));
}

function isAllowedRatePath(pathname) {
    return /^\/r\//.test(pathname) ||
        /^\/api\/public\/rate(?:\/|-domain-ask)/.test(pathname) ||
        /^\/assets\//.test(pathname) ||
        /^\/icons\//.test(pathname) ||
        /^\/vite\.svg$/.test(pathname);
}

function sendNotFound(req, res) {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({
            ok: false,
            error: { code: 'NOT_FOUND', message: 'Not found' },
        });
    }
    return res.status(404).type('text/plain').send('Not found');
}

async function rateHostGate(req, res, next) {
    const host = String(req.hostname || '').toLowerCase();
    let rateHost;

    if (host === RATE_ME_PUBLIC_HOST) {
        rateHost = { mode: 'shared' };
    } else if (isPassThroughHost(host)) {
        return next();
    } else {
        let resolved;
        try {
            resolved = await rateMeService.resolveDomainCompany(host);
        } catch (error) {
            console.error('[RateMe] host gate lookup error', {
                host,
                name: error?.name || 'Error',
                code: error?.code || 'UNKNOWN',
            });
            return res.status(503).end();
        }
        if (!resolved) return sendNotFound(req, res);
        rateHost = { mode: 'custom', companyId: resolved.companyId };
    }

    if (!isAllowedRatePath(req.path)) return sendNotFound(req, res);
    req.rateHost = rateHost;
    return next();
}

module.exports = rateHostGate;
