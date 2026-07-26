'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/marketplaceRatingsService', () => {
    class MarketplaceRatingsError extends Error {
        constructor(message, code, httpStatus = 400) {
            super(message);
            this.code = code;
            this.httpStatus = httpStatus;
        }
    }
    return {
        MarketplaceRatingsError,
        listReviewsForModeration: jest.fn(),
        moderateReview: jest.fn(),
    };
});

const service = require('../backend/src/services/marketplaceRatingsService');
const router = require('../backend/src/routes/platformAppReviews');

const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeApp(platformRole = 'none') {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = {
            email: 'moderator@example.test',
            crmUser: { id: ACTOR },
        };
        req.authz = { platform_role: platformRole };
        req.traceId = 'trace-ratings';
        next();
    });
    app.use('/api/admin/app-reviews', router);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('platformAppReviews self-guard and API contract', () => {
    test.each([
        ['GET', '/api/admin/app-reviews?status=pending'],
        ['POST', '/api/admin/app-reviews/12/moderate'],
    ])('non-superadmin is denied for %s %s', async (method, path) => {
        const call = request(makeApp('none'))[method.toLowerCase()](path);
        if (method === 'POST') call.send({ action: 'approve' });
        const res = await call;

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
    });

    test('GET lists a clamped, status-filtered moderation page', async () => {
        service.listReviewsForModeration.mockResolvedValue({
            reviews: [{
                id: 12,
                app_key: 'vapi-ai',
                app_name: 'AI Receptionist',
                stars: 1,
                comment: 'Needs review',
                status: 'pending',
                moderation_reason: 'Policy review.',
                moderation_source: 'llm',
                reviewer_first_name: 'Alex',
                company_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                company_name: 'Tenant A',
                moderated_by: null,
                moderator_first_name: null,
                created_at: '2026-07-26T12:00:00.000Z',
                updated_at: '2026-07-26T12:00:00.000Z',
            }],
            total: 1,
            page: 2,
            limit: 100,
        });

        const res = await request(makeApp('super_admin'))
            .get('/api/admin/app-reviews?status=rejected&page=2&limit=500');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            ok: true,
            total: 1,
            page: 2,
            limit: 100,
            reviews: [{ app_key: 'vapi-ai', reviewer_first_name: 'Alex' }],
            trace_id: 'trace-ratings',
        });
        expect(service.listReviewsForModeration).toHaveBeenCalledWith({
            status: 'rejected',
            page: 2,
            limit: 100,
        });
    });

    test.each(['missing', '0', '-2', '1.5'])('invalid review id %s returns 422', async id => {
        const res = await request(makeApp('super_admin'))
            .post(`/api/admin/app-reviews/${id}/moderate`)
            .send({ action: 'approve' });

        expect(res.status).toBe(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(service.moderateReview).not.toHaveBeenCalled();
    });

    test('POST moderate passes the authenticated CRM user id and returns the review', async () => {
        service.moderateReview.mockResolvedValue({
            id: 12,
            app_key: 'vapi-ai',
            status: 'rejected',
            moderated_by: ACTOR,
        });

        const res = await request(makeApp('super_admin'))
            .post('/api/admin/app-reviews/12/moderate')
            .send({ action: 'reject', reason: 'Abusive.' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            ok: true,
            review: {
                id: 12,
                app_key: 'vapi-ai',
                status: 'rejected',
                moderated_by: ACTOR,
            },
            trace_id: 'trace-ratings',
        });
        expect(service.moderateReview)
            .toHaveBeenCalledWith('12', 'reject', ACTOR, 'Abusive.');
    });
});
