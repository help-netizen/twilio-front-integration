'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/appVersionReviewService', () => ({
    listReviews: jest.fn(),
    getReview: jest.fn(),
}));

jest.mock('../backend/src/services/appVersionTransitionService', () => {
    class AppVersionTransitionError extends Error {
        constructor(code, message, httpStatus) {
            super(message);
            this.code = code;
            this.httpStatus = httpStatus;
        }
    }
    return {
        AppVersionTransitionError,
        startReview: jest.fn(),
        approveVersion: jest.fn(),
        rejectVersion: jest.fn(),
        revokeVersion: jest.fn(),
    };
});

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

const reviewService = require('../backend/src/services/appVersionReviewService');
const transitionService = require('../backend/src/services/appVersionTransitionService');
const ratingsService = require('../backend/src/services/marketplaceRatingsService');
const router = require('../backend/src/routes/platformAppReviews');

const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VERSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeApp(platformRole = 'none', tenantRole = 'tenant_admin') {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            email: 'moderator@example.test',
            crmUser: { id: ACTOR },
        };
        req.authz = {
            platform_role: platformRole,
            membership: { role_key: tenantRole },
        };
        req.traceId = 'trace-app-review';
        next();
    });
    app.use('/api/platform/app-reviews', router);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    reviewService.listReviews.mockResolvedValue({ requests: [], total: 0, page: 1, limit: 25 });
    reviewService.getReview.mockResolvedValue({ version: { id: VERSION_ID, status: 'in_review' } });
    transitionService.startReview.mockResolvedValue({ id: VERSION_ID, status: 'in_review' });
    transitionService.approveVersion.mockResolvedValue({ id: VERSION_ID, status: 'approved' });
    transitionService.rejectVersion.mockResolvedValue({ id: VERSION_ID, status: 'rejected' });
    transitionService.revokeVersion.mockResolvedValue({ id: VERSION_ID, status: 'revoked' });
});

describe('APP-MOD-001 platform app review routes', () => {
    const paths = [
        ['GET', '/api/platform/app-reviews?status=pending'],
        ['GET', `/api/platform/app-reviews/${VERSION_ID}`],
        ['POST', `/api/platform/app-reviews/${VERSION_ID}/start-review`],
        ['POST', `/api/platform/app-reviews/${VERSION_ID}/approve`],
        ['POST', `/api/platform/app-reviews/${VERSION_ID}/reject`],
        ['POST', `/api/platform/app-reviews/${VERSION_ID}/revoke`],
    ];

    test.each(['tenant_admin', 'manager', 'dispatcher', 'provider', 'custom'])(
        'R-matrix: %s is denied from every platform version-review route',
        async tenantRole => {
            for (const [method, path] of paths) {
                const call = request(makeApp('none', tenantRole))[method.toLowerCase()](path);
                if (path.endsWith('/reject')) call.send({ reason: 'Unsafe behavior.' });
                const response = await call;
                expect(response.status).toBe(403);
                expect(response.body.code).toBe('ACCESS_DENIED');
            }
            expect(reviewService.listReviews).not.toHaveBeenCalled();
            expect(transitionService.approveVersion).not.toHaveBeenCalled();
        }
    );

    test('GET lists the global application-version queue with clamped pagination', async () => {
        reviewService.listReviews.mockResolvedValue({
            requests: [{
                version_id: VERSION_ID,
                app_name: 'Task digest',
                company_name: 'Tenant A',
                status: 'submitted',
            }],
            total: 1,
            page: 2,
            limit: 100,
        });
        const response = await request(makeApp('super_admin'))
            .get('/api/platform/app-reviews?status=pending&page=2&limit=500');
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            ok: true,
            total: 1,
            requests: [{ version_id: VERSION_ID, company_name: 'Tenant A' }],
            trace_id: 'trace-app-review',
        });
        expect(reviewService.listReviews).toHaveBeenCalledWith({
            status: 'pending', page: 2, limit: 100,
        });
    });

    test('GET detail passes source reveal and the authenticated CRM actor to audited read service', async () => {
        const response = await request(makeApp('super_admin'))
            .get(`/api/platform/app-reviews/${VERSION_ID}?include_code=true`);
        expect(response.status).toBe(200);
        expect(reviewService.getReview).toHaveBeenCalledWith(VERSION_ID, {
            actorId: ACTOR,
            traceId: 'trace-app-review',
            includeCode: true,
        });
    });

    test.each([
        ['start-review', 'startReview', undefined, 'in_review'],
        ['approve', 'approveVersion', undefined, 'approved'],
        ['reject', 'rejectVersion', 'Unsafe dynamic behavior.', 'rejected'],
        ['revoke', 'revokeVersion', undefined, 'revoked'],
    ])('POST %s delegates one transition with CRM actor and reason', async (
        routeAction,
        serviceAction,
        reason,
        expectedStatus
    ) => {
        const call = request(makeApp('super_admin'))
            .post(`/api/platform/app-reviews/${VERSION_ID}/${routeAction}`);
        if (reason) call.send({ reason });
        const response = await call;
        expect(response.status).toBe(200);
        expect(response.body.version.status).toBe(expectedStatus);
        expect(transitionService[serviceAction]).toHaveBeenCalledWith({
            versionId: VERSION_ID,
            actorId: ACTOR,
            traceId: 'trace-app-review',
            ...(reason ? { reason } : {}),
        });
    });

    test.each(['not-a-uuid', '12', ''])('invalid version id %s is an opaque 404', async versionId => {
        const response = await request(makeApp('super_admin'))
            .post(`/api/platform/app-reviews/${versionId || 'missing'}/approve`);
        expect(response.status).toBe(404);
        expect(response.body.code).toBe('NOT_FOUND');
        expect(transitionService.approveVersion).not.toHaveBeenCalled();
    });
});

describe('MARKETPLACE-RATINGS-001 compatibility routes', () => {
    test('GET /ratings preserves the product-rating queue', async () => {
        ratingsService.listReviewsForModeration.mockResolvedValue({
            reviews: [{ id: 12, app_key: 'vapi-ai', status: 'pending' }],
            total: 1,
            page: 1,
            limit: 25,
        });
        const response = await request(makeApp('super_admin'))
            .get('/api/platform/app-reviews/ratings?status=pending');
        expect(response.status).toBe(200);
        expect(response.body.reviews).toEqual([{ id: 12, app_key: 'vapi-ai', status: 'pending' }]);
        expect(ratingsService.listReviewsForModeration).toHaveBeenCalledWith({
            status: 'pending', page: 1, limit: 25,
        });
    });

    test('POST moderate still passes the authenticated CRM user id', async () => {
        ratingsService.moderateReview.mockResolvedValue({ id: 12, status: 'rejected' });
        const response = await request(makeApp('super_admin'))
            .post('/api/platform/app-reviews/12/moderate')
            .send({ action: 'reject', reason: 'Abusive.' });
        expect(response.status).toBe(200);
        expect(ratingsService.moderateReview)
            .toHaveBeenCalledWith('12', 'reject', ACTOR, 'Abusive.');
    });
});
