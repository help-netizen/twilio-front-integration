/** Platform App Studio version moderation plus legacy Marketplace ratings. */
'use strict';

const express = require('express');
const { requirePlatformRole } = require('../middleware/authorization');
const appVersionReviewService = require('../services/appVersionReviewService');
const appVersionTransitionService = require('../services/appVersionTransitionService');
const marketplaceRatingsService = require('../services/marketplaceRatingsService');

const router = express.Router();

router.use(requirePlatformRole('super_admin'));

function positiveInteger(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function handleError(err, req, res) {
    if (err instanceof marketplaceRatingsService.MarketplaceRatingsError
        || err instanceof appVersionTransitionService.AppVersionTransitionError) {
        return res.status(err.httpStatus || 400).json({
            ok: false,
            code: err.code,
            message: err.message,
            trace_id: req.traceId,
        });
    }
    console.error('[PlatformAppReviews] Error:', err.message);
    return res.status(500).json({
        ok: false,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        trace_id: req.traceId,
    });
}

router.get('/', async (req, res) => {
    try {
        const status = typeof req.query.status === 'string'
            ? req.query.status.trim().toLowerCase()
            : 'pending';
        const page = positiveInteger(req.query.page, 1);
        const limit = Math.min(positiveInteger(req.query.limit, 25), 100);
        const result = await appVersionReviewService.listReviews({
            status,
            page,
            limit,
        });
        res.json({ ok: true, ...result, trace_id: req.traceId });
    } catch (err) {
        handleError(err, req, res);
    }
});

router.get('/ratings', async (req, res) => {
    try {
        const status = typeof req.query.status === 'string'
            ? req.query.status.trim().toLowerCase()
            : 'pending';
        const page = positiveInteger(req.query.page, 1);
        const limit = Math.min(positiveInteger(req.query.limit, 25), 100);
        const result = await marketplaceRatingsService.listReviewsForModeration({
            status,
            page,
            limit,
        });
        return res.json({ ok: true, ...result, trace_id: req.traceId });
    } catch (err) {
        return handleError(err, req, res);
    }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function actorContext(req) {
    const actorId = req.user?.crmUser?.id;
    if (!actorId) {
        throw new appVersionTransitionService.AppVersionTransitionError(
            'PLATFORM_ACTOR_REQUIRED',
            'Authenticated CRM user required.',
            403
        );
    }
    return { actorId, traceId: req.traceId || req.requestId || null };
}

function requireVersionId(req, res, next) {
    if (!UUID_RE.test(String(req.params.versionId || ''))) {
        return res.status(404).json({
            ok: false,
            code: 'NOT_FOUND',
            message: 'App version review was not found.',
            trace_id: req.traceId,
        });
    }
    return next();
}

router.get('/:versionId', requireVersionId, async (req, res) => {
    try {
        const review = await appVersionReviewService.getReview(req.params.versionId, {
            ...actorContext(req),
            includeCode: req.query.include_code === 'true',
        });
        return res.json({ ok: true, review, trace_id: req.traceId });
    } catch (err) {
        return handleError(err, req, res);
    }
});

async function transition(req, res, action) {
    try {
        const version = await appVersionTransitionService[action]({
            versionId: req.params.versionId,
            ...actorContext(req),
            ...(action === 'rejectVersion' ? { reason: req.body?.reason } : {}),
        });
        return res.json({ ok: true, version, trace_id: req.traceId });
    } catch (err) {
        return handleError(err, req, res);
    }
}

router.post('/:versionId/start-review', requireVersionId, (req, res) => (
    transition(req, res, 'startReview')
));
router.post('/:versionId/approve', requireVersionId, (req, res) => (
    transition(req, res, 'approveVersion')
));
router.post('/:versionId/reject', requireVersionId, (req, res) => (
    transition(req, res, 'rejectVersion')
));
router.post('/:versionId/revoke', requireVersionId, (req, res) => (
    transition(req, res, 'revokeVersion')
));

// MARKETPLACE-RATINGS-001 compatibility endpoint. Version ids are UUIDs, while
// product review ids are positive integers, so the two contracts cannot collide.
router.post('/:id/moderate', async (req, res) => {
    try {
        if (!/^[1-9]\d*$/.test(String(req.params.id || ''))) {
            throw new marketplaceRatingsService.MarketplaceRatingsError(
                'Review id must be a positive integer.',
                'VALIDATION_ERROR',
                422
            );
        }
        const review = await marketplaceRatingsService.moderateReview(
            req.params.id,
            req.body?.action,
            req.user?.crmUser?.id,
            req.body?.reason
        );
        res.json({ ok: true, review, trace_id: req.traceId });
    } catch (err) {
        handleError(err, req, res);
    }
});

module.exports = router;
