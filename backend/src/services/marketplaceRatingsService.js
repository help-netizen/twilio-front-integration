'use strict';

const marketplaceQueries = require('../db/marketplaceQueries');
const ratingsQueries = require('../db/marketplaceRatingsQueries');
const reviewModerator = require('./marketplaceReviewModerator');

const MAX_COMMENT_LENGTH = 1000;
const MAX_REASON_LENGTH = 1000;
const REVIEW_STATUSES = new Set(['pending', 'posted', 'rejected']);

const LINK_PATTERNS = [
    /https?:\/\/[^\s]+/i,
    /\bwww\.[^\s]+/i,
    /\[[^\]]+\]\s*\(\s*[^)]+\)/,
    /\b(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+[a-z]{2,24}(?:[/:?#][^\s]*)?/i,
    /(^|[^\w@])@[a-z0-9_][a-z0-9_.-]{0,63}\b/i,
];

const INJECTION_PATTERNS = [
    /\bignore\s+(?:all\s+)?(?:previous|prior|above|rules?|instructions?)\b/i,
    /\bdisregard\b/i,
    /\b(?:system|assistant|developer|user)\s*:/i,
    /\byou\s+are\b/i,
    /\bprompt\b/i,
    /```/,
    /<\|(?:system|assistant|developer|user)\|>/i,
    /\[(?:system|assistant|developer|user)\]/i,
];

const UNUSUAL_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;

class MarketplaceRatingsError extends Error {
    constructor(message, code, httpStatus = 400) {
        super(message);
        this.name = 'MarketplaceRatingsError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function sanitizeText(value, maxLength) {
    return String(value || '')
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function normalizeComment(value) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') {
        throw new MarketplaceRatingsError(
            'comment must be a string.',
            'VALIDATION_ERROR',
            422
        );
    }
    const normalized = sanitizeText(value, MAX_COMMENT_LENGTH);
    return normalized || null;
}

function validateStars(stars) {
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
        throw new MarketplaceRatingsError(
            'stars must be an integer from 1 to 5.',
            'VALIDATION_ERROR',
            422
        );
    }
}

function securityGate(rawComment) {
    if (rawComment == null || rawComment === '') {
        return { comment: null, pendingReason: null };
    }
    if (typeof rawComment !== 'string') {
        normalizeComment(rawComment);
    }

    const normalizedFull = sanitizeText(rawComment, Math.max(rawComment.length, MAX_COMMENT_LENGTH));
    if (LINK_PATTERNS.some(pattern => pattern.test(normalizedFull))) {
        throw new MarketplaceRatingsError(
            'Links and social handles are not allowed in Marketplace reviews.',
            'REVIEW_LINKS_NOT_ALLOWED',
            422
        );
    }

    const injectionDetected = UNUSUAL_CONTROL_RE.test(rawComment)
        || INJECTION_PATTERNS.some(pattern => pattern.test(normalizedFull));

    return {
        comment: normalizeComment(rawComment),
        pendingReason: injectionDetected
            ? 'Potential prompt-injection content requires manual review.'
            : null,
    };
}

function mapOwnReview(row) {
    return {
        id: Number(row.id),
        app_key: row.app_key,
        stars: Number(row.stars),
        comment: row.comment,
        status: row.status,
        moderation_reason: row.moderation_reason,
        moderation_source: row.moderation_source,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function mapPublicReview(row) {
    return {
        id: Number(row.id),
        app_key: row.app_key,
        stars: Number(row.stars),
        comment: row.comment,
        status: row.status,
        reviewer_first_name: row.reviewer_first_name,
        is_mine: row.is_mine === true,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function mapModerationReview(row) {
    return {
        id: Number(row.id),
        app_key: row.app_key,
        app_name: row.app_name,
        stars: Number(row.stars),
        comment: row.comment,
        status: row.status,
        moderation_reason: row.moderation_reason,
        moderation_source: row.moderation_source,
        reviewer_first_name: row.reviewer_first_name,
        company_id: row.company_id,
        company_name: row.company_name,
        moderated_by: row.moderated_by,
        moderator_first_name: row.moderator_first_name,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

async function requireReviewer(companyId, userId) {
    if (!companyId || !userId) {
        throw new MarketplaceRatingsError(
            'Active company membership is required.',
            'REVIEWER_CONTEXT_INVALID',
            403
        );
    }
    const reviewer = await ratingsQueries.getActiveReviewer(companyId, userId);
    if (!reviewer) {
        throw new MarketplaceRatingsError(
            'Active company membership is required.',
            'REVIEWER_CONTEXT_INVALID',
            403
        );
    }
    return reviewer;
}

async function requirePublishedApp(appKey) {
    const app = await ratingsQueries.getPublishedApp(appKey);
    if (!app) {
        throw new MarketplaceRatingsError(
            'Marketplace app not found.',
            'APP_NOT_FOUND',
            404
        );
    }
    return app;
}

async function submitReview(companyId, userId, appKey, stars, rawComment, options = {}) {
    validateStars(stars);
    const security = securityGate(rawComment);

    await marketplaceQueries.ensureMarketplaceSchema();
    await Promise.all([
        requireReviewer(companyId, userId),
        requirePublishedApp(appKey),
    ]);

    let status = 'posted';
    let moderationReason = null;
    let moderationSource = null;

    if (security.pendingReason) {
        status = 'pending';
        moderationReason = security.pendingReason;
        moderationSource = 'security';
    } else if (security.comment) {
        try {
            const verdict = await (options.moderateCommentImpl || reviewModerator.moderateComment)(
                security.comment
            );
            if (verdict.allow !== true) {
                status = 'pending';
                moderationReason = sanitizeText(
                    verdict.reason || 'Automated policy review requires manual moderation.',
                    500
                );
                moderationSource = 'llm';
            }
        } catch (err) {
            status = 'pending';
            moderationReason = 'Automated moderation is unavailable; manual review is required.';
            moderationSource = 'llm';
            console.warn('[MarketplaceRatings] Gemini moderation unavailable; queued pending review.');
        }
    }

    const row = await ratingsQueries.upsertReview({
        companyId,
        userId,
        appKey,
        stars,
        comment: security.comment,
        status,
        moderationReason,
        moderationSource,
    });
    if (!row) {
        throw new MarketplaceRatingsError(
            'Review context changed before it could be saved.',
            'REVIEWER_CONTEXT_INVALID',
            403
        );
    }

    return { status: row.status, review: mapOwnReview(row) };
}

async function deleteMyReview(companyId, userId, appKey) {
    await marketplaceQueries.ensureMarketplaceSchema();
    await Promise.all([
        requireReviewer(companyId, userId),
        requirePublishedApp(appKey),
    ]);
    return { deleted: await ratingsQueries.deleteReview(companyId, userId, appKey) };
}

async function getPublicReviews(companyId, viewerUserId, appKey) {
    await marketplaceQueries.ensureMarketplaceSchema();
    await Promise.all([
        requireReviewer(companyId, viewerUserId),
        requirePublishedApp(appKey),
    ]);
    const rows = await ratingsQueries.listPublicReviews(appKey, viewerUserId);
    return rows.map(mapPublicReview);
}

async function getAggregate(appKey) {
    await marketplaceQueries.ensureMarketplaceSchema();
    await requirePublishedApp(appKey);
    const row = await ratingsQueries.getAggregate(appKey);
    return {
        avg_rating: row.avg_rating == null ? null : Number(row.avg_rating),
        rating_count: Number(row.rating_count || 0),
    };
}

function validateModerationStatus(status) {
    if (!REVIEW_STATUSES.has(status)) {
        throw new MarketplaceRatingsError(
            'status must be pending, posted, or rejected.',
            'VALIDATION_ERROR',
            422
        );
    }
}

async function listReviewsForModeration({ status = 'pending', page = 1, limit = 25 } = {}) {
    validateModerationStatus(status);
    await marketplaceQueries.ensureMarketplaceSchema();
    const result = await ratingsQueries.listReviewsForModeration({ status, page, limit });
    return {
        reviews: result.rows.map(mapModerationReview),
        total: result.total,
        page,
        limit,
    };
}

async function moderateReview(reviewId, action, moderatorUserId, reason) {
    if (!['approve', 'reject'].includes(action)) {
        throw new MarketplaceRatingsError(
            'action must be approve or reject.',
            'VALIDATION_ERROR',
            422
        );
    }
    if (!moderatorUserId || !await ratingsQueries.getActiveSuperAdmin(moderatorUserId)) {
        throw new MarketplaceRatingsError(
            'Active platform super admin required.',
            'ACCESS_DENIED',
            403
        );
    }

    if (reason != null && typeof reason !== 'string') {
        throw new MarketplaceRatingsError(
            'reason must be a string.',
            'VALIDATION_ERROR',
            422
        );
    }
    const cleanReason = reason == null ? null : sanitizeText(reason, MAX_REASON_LENGTH);

    await marketplaceQueries.ensureMarketplaceSchema();
    const row = await ratingsQueries.moderateReview(reviewId, {
        status: action === 'approve' ? 'posted' : 'rejected',
        reason: cleanReason || null,
        moderatorUserId,
    });
    if (!row) {
        throw new MarketplaceRatingsError(
            'Review not found.',
            'REVIEW_NOT_FOUND',
            404
        );
    }
    return mapModerationReview(row);
}

module.exports = {
    MarketplaceRatingsError,
    MAX_COMMENT_LENGTH,
    securityGate,
    submitReview,
    deleteMyReview,
    getPublicReviews,
    getAggregate,
    listReviewsForModeration,
    moderateReview,
};
