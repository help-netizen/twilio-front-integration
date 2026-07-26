/**
 * Platform Marketplace review moderation.
 *
 * This router is ready for Claude's authorized bridge at /api/admin/app-reviews.
 * It is self-guarded so a future mount cannot accidentally expose the global
 * moderation queue without the platform super_admin role.
 */
'use strict';

const express = require('express');
const { requirePlatformRole } = require('../middleware/authorization');
const marketplaceRatingsService = require('../services/marketplaceRatingsService');

const router = express.Router();

router.use(requirePlatformRole('super_admin'));

function positiveInteger(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function handleError(err, req, res) {
    if (err instanceof marketplaceRatingsService.MarketplaceRatingsError) {
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
        const result = await marketplaceRatingsService.listReviewsForModeration({
            status,
            page,
            limit,
        });
        res.json({ ok: true, ...result, trace_id: req.traceId });
    } catch (err) {
        handleError(err, req, res);
    }
});

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
