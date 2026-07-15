'use strict';

const db = require('./connection');

async function insertToken({ companyId, token, jobId, techId, techName }) {
    const { rows } = await db.query(
        `INSERT INTO rate_tokens
            (company_id, token, job_id, tech_id, tech_name)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [companyId, token, jobId, techId, techName]
    );
    return rows[0];
}

async function getTokenContext(token, hostCompanyId = null) {
    const { rows } = await db.query(
        `SELECT t.id, t.company_id, t.expires_at, t.used_at,
                c.name AS company_name, c.logo_storage_key,
                COALESCE(p.name, t.tech_name) AS technician_name,
                (r.id IS NOT NULL) AS already_rated,
                j.service_name, j.start_date, j.customer_name,
                ct.first_name AS contact_first_name,
                c.timezone AS company_timezone,
                c.contact_phone AS company_phone,
                c.contact_email AS company_email
         FROM rate_tokens t
         JOIN companies c ON c.id = t.company_id
         LEFT JOIN technician_profiles p
            ON p.company_id = t.company_id
           AND p.tech_id = t.tech_id
         LEFT JOIN technician_ratings r ON r.rate_token_id = t.id
         LEFT JOIN jobs j ON j.id = t.job_id
         LEFT JOIN contacts ct ON ct.id = j.contact_id
         WHERE t.token = $1
           AND ($2::uuid IS NULL OR t.company_id = $2)
           AND (t.expires_at IS NULL OR t.expires_at > NOW())`,
        [token, hostCompanyId]
    );
    return rows[0];
}

async function getExpiredTokenBranding(token, hostCompanyId = null) {
    const { rows } = await db.query(
        `SELECT t.company_id, c.name AS company_name, c.logo_storage_key,
                c.contact_phone, c.contact_email
         FROM rate_tokens t
         JOIN companies c ON c.id = t.company_id
         WHERE t.token = $1
           AND t.expires_at IS NOT NULL
           AND t.expires_at <= NOW()
           AND ($2::uuid IS NULL OR t.company_id = $2)`,
        [token, hostCompanyId]
    );
    return rows[0] || null;
}

async function stampTokenOpened(rateTokenId, client = db.pool) {
    const { rows } = await client.query(
        `UPDATE rate_tokens
         SET opened_at = NOW()
         WHERE id = $1
           AND opened_at IS NULL
         RETURNING id, opened_at`,
        [rateTokenId]
    );
    return rows[0];
}

async function stampGoogleClick(rateTokenId, client = db.pool) {
    const { rows } = await client.query(
        `UPDATE rate_tokens
         SET google_click_at = NOW()
         WHERE id = $1
           AND google_click_at IS NULL
         RETURNING id, google_click_at`,
        [rateTokenId]
    );
    return rows[0];
}

async function stampTokenSent(token, companyId, via, client = db.pool) {
    const { rows } = await client.query(
        `UPDATE rate_tokens
         SET sent_at = NOW(), sent_via = $3
         WHERE token = $1
           AND company_id = $2
         RETURNING id, sent_at, sent_via`,
        [token, companyId, via]
    );
    return rows[0];
}

async function getJobRateStatus(companyId, jobId) {
    const [tokenResult, ratingResult] = await Promise.all([
        db.query(
            `SELECT sent_at, sent_via, opened_at, google_click_at
             FROM rate_tokens
             WHERE company_id = $1
               AND job_id = $2
             ORDER BY created_at DESC
             LIMIT 1`,
            [companyId, jobId]
        ),
        db.query(
            `SELECT stars, created_at
             FROM technician_ratings
             WHERE company_id = $1
               AND job_id = $2
             ORDER BY created_at DESC
             LIMIT 1`,
            [companyId, jobId]
        ),
    ]);
    const tokenRow = tokenResult.rows[0];
    const ratingRow = ratingResult.rows[0];

    return {
        has_token: Boolean(tokenRow),
        sent_at: tokenRow?.sent_at || null,
        sent_via: tokenRow?.sent_via || null,
        opened_at: tokenRow?.opened_at || null,
        google_click_at: tokenRow?.google_click_at || null,
        rating: ratingRow ? {
            stars: ratingRow.stars,
            created_at: ratingRow.created_at,
        } : null,
    };
}

async function insertRating({
    companyId,
    rateTokenId,
    jobId,
    techId,
    stars,
    feedback,
}, client) {
    const { rows } = await client.query(
        `INSERT INTO technician_ratings
            (company_id, rate_token_id, job_id, tech_id, stars, feedback)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (rate_token_id) DO NOTHING
         RETURNING id`,
        [companyId, rateTokenId, jobId, techId, stars, feedback]
    );
    return rows[0];
}

async function stampTokenUsed(rateTokenId, client) {
    const { rows } = await client.query(
        `UPDATE rate_tokens
         SET used_at = NOW()
         WHERE id = $1
           AND used_at IS NULL
         RETURNING id, used_at`,
        [rateTokenId]
    );
    return rows[0];
}

// RATE-ME-CRM-001: this public hot-path read deliberately skips
// ensureMarketplaceSchema so token GET/POST remains a single metadata query.
async function getConnectedRateMeMeta(companyId) {
    const { rows } = await db.query(
        `SELECT mi.metadata, mi.id AS installation_id, ma.id AS app_id
         FROM marketplace_installations mi
         JOIN marketplace_apps ma ON ma.id = mi.app_id
         WHERE mi.company_id = $1
           AND ma.app_key = 'rate-me'
           AND mi.status = 'connected'
         ORDER BY mi.created_at DESC
         LIMIT 1`,
        [companyId]
    );
    return rows[0] || null;
}

async function getDomainByCompany(companyId) {
    const { rows } = await db.query(
        `SELECT domain, status, verified_at, activated_at,
                last_checked_at, last_error
         FROM rate_me_domains
         WHERE company_id = $1`,
        [companyId]
    );
    return rows[0] || null;
}

async function getServableDomain(domain) {
    const { rows } = await db.query(
        `SELECT company_id, domain, status, verified_at, activated_at,
                last_checked_at, last_error
         FROM rate_me_domains
         WHERE domain = $1
           AND status IN ('verified', 'active')`,
        [domain]
    );
    return rows[0];
}

async function upsertDomainForCompany(companyId, domain) {
    const { rows } = await db.query(
        `INSERT INTO rate_me_domains (company_id, domain)
         VALUES ($1, $2)
         ON CONFLICT (company_id) DO UPDATE SET
            domain = EXCLUDED.domain,
            status = 'pending',
            verified_at = NULL,
            activated_at = NULL,
            last_checked_at = NULL,
            last_error = NULL
         RETURNING domain, status, verified_at, activated_at,
                   last_checked_at, last_error`,
        [companyId, domain]
    );
    return rows[0];
}

async function setDomainStatus(companyId, status, {
    setVerifiedAt = false,
    setActivatedAt = false,
    setLastCheckedAt = false,
    updateLastError = false,
    lastError = null,
} = {}) {
    const { rows } = await db.query(
        `UPDATE rate_me_domains
         SET status = $2,
             verified_at = CASE WHEN $3 THEN NOW() ELSE verified_at END,
             activated_at = CASE WHEN $4 THEN NOW() ELSE activated_at END,
             last_checked_at = CASE WHEN $5 THEN NOW() ELSE last_checked_at END,
             last_error = CASE WHEN $6 THEN $7 ELSE last_error END
         WHERE company_id = $1
         RETURNING domain, status, verified_at, activated_at,
                   last_checked_at, last_error`,
        [
            companyId,
            status,
            setVerifiedAt,
            setActivatedAt,
            setLastCheckedAt,
            updateLastError,
            lastError,
        ]
    );
    return rows[0];
}

async function deleteDomain(companyId) {
    const { rows } = await db.query(
        `DELETE FROM rate_me_domains
         WHERE company_id = $1
         RETURNING domain, status, verified_at, activated_at,
                   last_checked_at, last_error`,
        [companyId]
    );
    return rows[0];
}

module.exports = {
    insertToken,
    getTokenContext,
    getExpiredTokenBranding,
    stampTokenOpened,
    stampGoogleClick,
    stampTokenSent,
    getJobRateStatus,
    insertRating,
    stampTokenUsed,
    getConnectedRateMeMeta,
    getDomainByCompany,
    getServableDomain,
    upsertDomainForCompany,
    setDomainStatus,
    deleteDomain,
};
