'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/marketplaceService', () => {
    class MarketplaceServiceError extends Error {}
    return {
        MarketplaceServiceError,
        listApps: jest.fn(),
    };
});

jest.mock('../backend/src/services/marketplaceRatingsService', () => {
    class MarketplaceRatingsError extends Error {}
    return {
        MarketplaceRatingsError,
        submitReview: jest.fn(),
        getPublicReviews: jest.fn(),
        deleteMyReview: jest.fn(),
    };
});

jest.mock('../backend/src/services/rateMeService', () => {
    class RateMeServiceError extends Error {}
    return { RateMeServiceError };
});

const { requirePermission } = require('../backend/src/middleware/authorization');
const { requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');
const ratingsService = require('../backend/src/services/marketplaceRatingsService');
const marketplaceRouter = require('../backend/src/routes/marketplace');

const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeApp(roleKey, permissions) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = {
            email: `${roleKey}@example.test`,
            crmUser: { id: USER },
        };
        req.authz = {
            scope: 'tenant',
            platform_role: 'none',
            company: { id: COMPANY, status: 'active' },
            membership: { role_key: roleKey },
            permissions,
        };
        req.requestId = 'req-rbac';
        req.traceId = 'trace-rbac';
        next();
    });
    app.use(
        '/api/marketplace',
        requirePermission('tenant.integrations.manage'),
        requireCompanyAccess,
        marketplaceRouter
    );
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    ratingsService.submitReview.mockResolvedValue({
        status: 'posted',
        review: { id: 1, app_key: 'vapi-ai', status: 'posted' },
    });
    ratingsService.getPublicReviews.mockResolvedValue([]);
    ratingsService.deleteMyReview.mockResolvedValue({ deleted: true });
});

describe('Marketplace ratings inherited tenant.integrations.manage R-matrix', () => {
    test('production mount declares the existing catalog permission and company guard', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
        expect(source).toContain(
            "app.use('/api/marketplace', authenticate, requirePermission('tenant.integrations.manage'), requireCompanyAccess, marketplaceRouter);"
        );
    });

    test.each([
        ['manager'],
        ['dispatcher'],
        ['provider'],
    ])('%s is denied on every ratings route', async roleKey => {
        const app = makeApp(roleKey, []);
        const [submit, list, remove] = await Promise.all([
            request(app).post('/api/marketplace/apps/vapi-ai/rating').send({ stars: 5 }),
            request(app).get('/api/marketplace/apps/vapi-ai/reviews'),
            request(app).delete('/api/marketplace/apps/vapi-ai/rating'),
        ]);

        expect([submit.status, list.status, remove.status]).toEqual([403, 403, 403]);
        expect(ratingsService.submitReview).not.toHaveBeenCalled();
        expect(ratingsService.getPublicReviews).not.toHaveBeenCalled();
        expect(ratingsService.deleteMyReview).not.toHaveBeenCalled();
    });

    test('tenant_admin with tenant.integrations.manage can use all three routes', async () => {
        const app = makeApp('tenant_admin', ['tenant.integrations.manage']);
        const [submit, list, remove] = await Promise.all([
            request(app).post('/api/marketplace/apps/vapi-ai/rating').send({ stars: 5 }),
            request(app).get('/api/marketplace/apps/vapi-ai/reviews'),
            request(app).delete('/api/marketplace/apps/vapi-ai/rating'),
        ]);

        expect([submit.status, list.status, remove.status]).toEqual([200, 200, 200]);
        expect(ratingsService.submitReview)
            .toHaveBeenCalledWith(COMPANY, USER, 'vapi-ai', 5, undefined);
        expect(ratingsService.getPublicReviews)
            .toHaveBeenCalledWith(COMPANY, USER, 'vapi-ai');
        expect(ratingsService.deleteMyReview)
            .toHaveBeenCalledWith(COMPANY, USER, 'vapi-ai');
    });
});
