'use strict';

const crypto = require('crypto');
const db = require('../db/connection');
const rateMeQueries = require('../db/rateMeQueries');
const marketplaceQueries = require('../db/marketplaceQueries');
const storageService = require('./storageService');

const RATE_ME_PUBLIC_HOST = String(
    process.env.RATE_ME_PUBLIC_HOST || 'rate.albusto.com'
).trim().toLowerCase().replace(/\.+$/, '');
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;
const domainCache = new Map();

const NO_CNAME_MESSAGE = "We can't see the CNAME record yet — DNS changes can take up to an hour. Check the record and try again. If your DNS provider proxies traffic (e.g. Cloudflare's orange cloud), switch the record to DNS-only.";
const DNS_RETRY_MESSAGE = "We couldn't check DNS just now — please try again in a minute.";

class RateMeServiceError extends Error {
    constructor(message, code, httpStatus = 400) {
        super(message);
        this.name = 'RateMeServiceError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

async function requireConnectedInstallation(companyId) {
    const installation = await rateMeQueries.getConnectedRateMeMeta(companyId);
    if (!installation) {
        throw new RateMeServiceError(
            'Marketplace app is not installed.',
            'APP_NOT_INSTALLED',
            404
        );
    }
    return installation;
}

function normalizeAssignedTechs(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        return [];
    }
}

async function mintToken(companyId, {
    jobId = null,
    techId,
    techName = null,
} = {}) {
    await requireConnectedInstallation(companyId);

    if (typeof techId !== 'string' || !techId.trim()) {
        throw new RateMeServiceError(
            'Technician id is required.',
            'INVALID_TECH_ID',
            400
        );
    }
    if (jobId !== null && (!Number.isInteger(jobId) || jobId <= 0)) {
        throw new RateMeServiceError(
            'Job id must be a positive integer.',
            'JOB_NOT_FOUND',
            400
        );
    }

    const normalizedTechId = techId.trim();
    let resolvedTechName = techName;
    if (jobId !== null) {
        const { rows } = await db.query(
            `SELECT 1 AS owned, assigned_techs
             FROM jobs
             WHERE id = $1
               AND company_id = $2`,
            [jobId, companyId]
        );
        const job = rows[0];
        if (!job) {
            throw new RateMeServiceError(
                'Job not found.',
                'JOB_NOT_FOUND',
                400
            );
        }
        if (resolvedTechName === null || resolvedTechName === undefined) {
            const technician = normalizeAssignedTechs(job.assigned_techs)
                .find((entry) => String(entry?.id ?? '') === normalizedTechId);
            resolvedTechName = technician?.name || null;
        }
    }

    const maxCollisionRetries = 3;
    for (let attempt = 0; attempt <= maxCollisionRetries; attempt += 1) {
        const token = crypto.randomBytes(24).toString('base64url');
        try {
            await rateMeQueries.insertToken({
                companyId,
                token,
                jobId,
                techId: normalizedTechId,
                techName: resolvedTechName,
            });
            console.log('[RateMe] mint', {
                company_id: companyId,
                job_id: jobId,
                tech_id: normalizedTechId,
                token_prefix: token.slice(0, 8),
            });
            return {
                token,
                url: `https://${RATE_ME_PUBLIC_HOST}/r/${token}`,
            };
        } catch (error) {
            if (error?.code === '23505' && attempt < maxCollisionRetries) continue;
            throw new RateMeServiceError(
                'Unable to mint rating token.',
                'INTERNAL_ERROR',
                500
            );
        }
    }

    throw new RateMeServiceError(
        'Unable to mint rating token.',
        'INTERNAL_ERROR',
        500
    );
}

function googleReviewUrl(metadata) {
    const value = metadata?.settings?.google_review_url;
    return typeof value === 'string' && value ? value : null;
}

async function getPublicContext(token, hostCompanyId = null) {
    const context = await rateMeQueries.getTokenContext(token, hostCompanyId);
    if (!context) return null;

    const installation = await rateMeQueries.getConnectedRateMeMeta(context.company_id);
    if (!installation) return null;

    let companyLogoUrl = null;
    if (context.logo_storage_key) {
        try {
            companyLogoUrl = await storageService.getPresignedUrl(context.logo_storage_key);
        } catch (error) {
            companyLogoUrl = null;
        }
    }

    return {
        company_name: context.company_name,
        company_logo_url: companyLogoUrl,
        technician_name: context.technician_name || null,
        already_rated: Boolean(context.already_rated),
        five_star_redirect: Boolean(googleReviewUrl(installation.metadata)),
    };
}

function normalizeFeedback(feedback) {
    if (feedback === undefined || feedback === null) return null;
    if (typeof feedback !== 'string') {
        throw new RateMeServiceError(
            'Feedback must be a string.',
            'INVALID_FEEDBACK',
            400
        );
    }
    const normalized = feedback.trim();
    return normalized ? normalized.slice(0, 2000) : null;
}

function validateStars(stars) {
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
        throw new RateMeServiceError(
            'Stars must be an integer from 1 to 5.',
            'INVALID_STARS',
            400
        );
    }
}

function replayResult() {
    return { recorded: false, already_recorded: true, next: 'thanks' };
}

function logRating(context, stars, feedback, replay) {
    console.log('[RateMe] rating', {
        company_id: context.company_id,
        rate_token_id: context.id,
        stars,
        has_feedback: Boolean(feedback),
        replay,
    });
}

async function getRatingIdentity(context, client) {
    if (context.tech_id !== undefined && context.job_id !== undefined) {
        return { jobId: context.job_id, techId: context.tech_id };
    }

    const { rows } = await client.query(
        `SELECT job_id, tech_id
         FROM rate_tokens
         WHERE id = $1
           AND company_id = $2`,
        [context.id, context.company_id]
    );
    return rows[0]
        ? { jobId: rows[0].job_id, techId: rows[0].tech_id }
        : null;
}

async function submitRating(token, { stars, feedback = null } = {}, hostCompanyId = null) {
    validateStars(stars);
    const normalizedFeedback = normalizeFeedback(feedback);
    const context = await rateMeQueries.getTokenContext(token, hostCompanyId);
    if (!context) return null;

    const installation = await rateMeQueries.getConnectedRateMeMeta(context.company_id);
    if (!installation) return null;

    if (context.already_rated) {
        logRating(context, stars, normalizedFeedback, true);
        return replayResult();
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const identity = await getRatingIdentity(context, client);
        if (!identity) throw new Error('Rate token identity not found');

        const inserted = await rateMeQueries.insertRating({
            companyId: context.company_id,
            rateTokenId: context.id,
            jobId: identity.jobId,
            techId: identity.techId,
            stars,
            feedback: normalizedFeedback,
        }, client);

        if (!inserted) {
            await client.query('COMMIT');
            logRating(context, stars, normalizedFeedback, true);
            return replayResult();
        }

        await rateMeQueries.stampTokenUsed(context.id, client);
        await client.query('COMMIT');
        logRating(context, stars, normalizedFeedback, false);

        const redirectUrl = googleReviewUrl(installation.metadata);
        if (stars === 5 && redirectUrl) {
            return {
                recorded: true,
                next: 'google_redirect',
                redirect_url: redirectUrl,
            };
        }
        return { recorded: true, next: 'thanks' };
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            // Preserve the original storage error.
        }
        throw error;
    } finally {
        client.release();
    }
}

function normalizeDomain(rawDomain) {
    if (typeof rawDomain !== 'string' || !rawDomain.trim()) return null;
    try {
        return new URL(`http://${rawDomain.trim()}`).hostname
            .toLowerCase()
            .replace(/\.+$/, '');
    } catch (error) {
        return null;
    }
}

function isValidHostname(domain) {
    if (!domain || domain.length > 253) return false;
    const labels = domain.split('.');
    if (labels.some((label) => !label || label.length > 63)) return false;
    return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function getCached(key) {
    const cached = domainCache.get(key);
    if (!cached) return { hit: false, value: null };
    if (cached.expiresAt <= Date.now()) {
        domainCache.delete(key);
        return { hit: false, value: null };
    }
    return { hit: true, value: cached.value };
}

function setCached(key, value) {
    if (!domainCache.has(key) && domainCache.size >= CACHE_MAX_ENTRIES) {
        domainCache.clear();
    }
    domainCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function clearDomainCache() {
    domainCache.clear();
}

async function resolveDomainCompany(host) {
    const domain = normalizeDomain(host);
    if (!domain) return null;
    const key = `host:${domain}`;
    const cached = getCached(key);
    if (cached.hit) return cached.value;

    const row = await rateMeQueries.getServableDomain(domain);
    const result = row ? { companyId: row.company_id } : null;
    setCached(key, result);
    return result;
}

async function writeDomainEvent(meta, companyId, actorId, eventType, domain) {
    return marketplaceQueries.writeEvent({
        companyId,
        installationId: meta.installation_id,
        appId: meta.app_id,
        actorId,
        eventType,
        payload: { app_key: 'rate-me', domain },
    });
}

async function computeAskDecision(domain) {
    const row = await rateMeQueries.getServableDomain(domain);
    if (!row) return false;

    const meta = await rateMeQueries.getConnectedRateMeMeta(row.company_id);
    if (!meta) return false;

    if (row.status === 'verified') {
        await rateMeQueries.setDomainStatus(row.company_id, 'active', {
            setActivatedAt: true,
        });
        clearDomainCache();
        await writeDomainEvent(
            meta,
            row.company_id,
            null,
            'domain_activated',
            row.domain || domain
        );
    }
    return true;
}

async function authorizeAskDomain(rawDomain) {
    const domain = normalizeDomain(rawDomain);
    if (!domain || !isValidHostname(domain)) {
        console.log('[RateMe] ask', { domain: domain || null, allow: false });
        return false;
    }

    const key = `ask:${domain}`;
    const cached = getCached(key);
    if (cached.hit) {
        const allow = await cached.value;
        console.log('[RateMe] ask', { domain, allow });
        return allow;
    }

    const decision = computeAskDecision(domain);
    setCached(key, decision);
    try {
        const allow = await decision;
        setCached(key, allow);
        console.log('[RateMe] ask', { domain, allow });
        return allow;
    } catch (error) {
        domainCache.delete(key);
        throw error;
    }
}

async function setCustomDomain(companyId, actorId, rawDomain) {
    const meta = await requireConnectedInstallation(companyId);
    const domain = normalizeDomain(rawDomain);
    if (!isValidHostname(domain)) {
        throw new RateMeServiceError(
            'Enter a valid hostname.',
            'INVALID_DOMAIN',
            400
        );
    }
    if (domain === 'albusto.com' || domain.endsWith('.albusto.com')) {
        throw new RateMeServiceError(
            'Albusto domains are reserved.',
            'RESERVED_DOMAIN',
            400
        );
    }
    if (domain.split('.').length < 3) {
        throw new RateMeServiceError(
            `Use a subdomain like rate.${domain} — root domains can't carry a CNAME record.`,
            'APEX_DOMAIN_NOT_SUPPORTED',
            400
        );
    }

    let row;
    try {
        row = await rateMeQueries.upsertDomainForCompany(companyId, domain);
    } catch (error) {
        if (error?.code === '23505') {
            throw new RateMeServiceError(
                'This domain is already in use.',
                'DOMAIN_TAKEN',
                400
            );
        }
        throw error;
    }

    clearDomainCache();
    await writeDomainEvent(meta, companyId, actorId, 'domain_added', domain);
    console.log('[RateMe] domain', {
        company_id: companyId,
        domain,
        action: 'set',
        result: row.status,
        error: null,
    });
    return row;
}

function normalizeDnsTarget(target) {
    return String(target || '').trim().toLowerCase().replace(/\.+$/, '');
}

async function resolveCnameWithTimeout(domain) {
    const resolver = new (require('dns').promises.Resolver)();
    let timeoutId;
    try {
        return await Promise.race([
            resolver.resolveCname(domain),
            new Promise((resolve, reject) => {
                timeoutId = setTimeout(() => {
                    const error = new Error('DNS lookup timed out');
                    error.code = 'ETIMEOUT';
                    reject(error);
                }, 5000);
            }),
        ]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

async function verifyDomain(companyId, actorId) {
    const meta = await requireConnectedInstallation(companyId);
    const current = await rateMeQueries.getDomainByCompany(companyId);
    if (!current) {
        throw new RateMeServiceError(
            'Custom domain not found.',
            'DOMAIN_NOT_FOUND',
            404
        );
    }

    let success = false;
    let failureType = null;
    let lastError = null;
    try {
        const targets = (await resolveCnameWithTimeout(current.domain))
            .map(normalizeDnsTarget)
            .filter(Boolean);
        success = targets.includes(RATE_ME_PUBLIC_HOST);
        if (!success) {
            if (targets.length > 0) {
                failureType = 'wrong_target';
                lastError = `The CNAME points to ${targets[0]} — it needs to point to ${RATE_ME_PUBLIC_HOST}.`;
            } else {
                failureType = 'not_found';
                lastError = NO_CNAME_MESSAGE;
            }
        }
    } catch (error) {
        if (error?.code === 'ENOTFOUND' || error?.code === 'ENODATA') {
            failureType = 'not_found';
            lastError = NO_CNAME_MESSAGE;
        } else {
            failureType = 'transport';
            lastError = DNS_RETRY_MESSAGE;
        }
    }

    const canTransition = current.status === 'pending' || current.status === 'failed';
    let nextStatus = current.status;
    const options = { setLastCheckedAt: true };
    let shouldWriteVerifiedEvent = false;

    if (success && canTransition) {
        nextStatus = 'verified';
        options.setVerifiedAt = true;
        options.updateLastError = true;
        options.lastError = null;
        shouldWriteVerifiedEvent = true;
    } else if (!success) {
        if (canTransition && failureType !== 'transport') nextStatus = 'failed';
        options.updateLastError = true;
        options.lastError = lastError;
    }

    const row = await rateMeQueries.setDomainStatus(companyId, nextStatus, options);
    clearDomainCache();
    if (shouldWriteVerifiedEvent) {
        await writeDomainEvent(
            meta,
            companyId,
            actorId,
            'domain_verified',
            current.domain
        );
    }
    console.log('[RateMe] domain', {
        company_id: companyId,
        domain: current.domain,
        action: 'verify',
        result: row?.status || nextStatus,
        error: lastError,
    });
    return row;
}

async function removeDomain(companyId, actorId) {
    const meta = await requireConnectedInstallation(companyId);
    const row = await rateMeQueries.deleteDomain(companyId);
    if (!row) {
        throw new RateMeServiceError(
            'Custom domain not found.',
            'DOMAIN_NOT_FOUND',
            404
        );
    }

    clearDomainCache();
    await writeDomainEvent(meta, companyId, actorId, 'domain_removed', row.domain);
    console.log('[RateMe] domain', {
        company_id: companyId,
        domain: row.domain,
        action: 'remove',
        result: 'removed',
        error: null,
    });
    return row;
}

module.exports = {
    RateMeServiceError,
    normalizeDomain,
    mintToken,
    getPublicContext,
    submitRating,
    resolveDomainCompany,
    authorizeAskDomain,
    setCustomDomain,
    verifyDomain,
    removeDomain,
};
