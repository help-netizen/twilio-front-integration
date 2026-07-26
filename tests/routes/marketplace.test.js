const express = require('express');
const request = require('supertest');

jest.mock('../../backend/src/services/marketplaceService', () => {
    class MarketplaceServiceError extends Error {
        constructor(message, code, httpStatus = 400) {
            super(message);
            this.code = code;
            this.httpStatus = httpStatus;
        }
    }
    return {
        MarketplaceServiceError,
        listApps: jest.fn(),
        listInstallations: jest.fn(),
        installApp: jest.fn(),
        disconnectInstallation: jest.fn(),
        retryProvisioning: jest.fn(),
    };
});

jest.mock('../../backend/src/services/marketplaceRatingsService', () => {
    class MarketplaceRatingsError extends Error {
        constructor(message, code, httpStatus = 400) {
            super(message);
            this.code = code;
            this.httpStatus = httpStatus;
        }
    }
    return {
        MarketplaceRatingsError,
        submitReview: jest.fn(),
        getPublicReviews: jest.fn(),
        deleteMyReview: jest.fn(),
    };
});

const marketplaceService = require('../../backend/src/services/marketplaceService');
const marketplaceRatingsService = require('../../backend/src/services/marketplaceRatingsService');
const router = require('../../backend/src/routes/marketplace');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.requestId = 'req_test';
        req.companyFilter = { company_id: 'company-1' };
        req.user = { crmUser: { id: 'user-1' } };
        next();
    });
    app.use('/api/marketplace', router);
    return app;
}

describe('marketplace routes', () => {
    let app;
    beforeEach(() => {
        jest.clearAllMocks();
        app = makeApp();
    });

    test('GET /apps returns catalog', async () => {
        marketplaceService.listApps.mockResolvedValue([{
            app_key: 'call-qa-agent',
            avg_rating: 4.5,
            rating_count: 2,
        }]);
        const res = await request(app).get('/api/marketplace/apps');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.apps).toEqual([{
            app_key: 'call-qa-agent',
            avg_rating: 4.5,
            rating_count: 2,
        }]);
        expect(marketplaceService.listApps).toHaveBeenCalledWith('company-1');
    });

    test('POST /apps/:appKey/rating returns the moderation status and owner review', async () => {
        marketplaceRatingsService.submitReview.mockResolvedValue({
            status: 'pending',
            review: {
                id: 12,
                app_key: 'vapi-ai',
                stars: 4,
                comment: 'Needs review',
                status: 'pending',
                moderation_reason: 'Manual review required.',
                moderation_source: 'llm',
                created_at: '2026-07-26T12:00:00.000Z',
                updated_at: '2026-07-26T12:00:00.000Z',
            },
        });

        const res = await request(app)
            .post('/api/marketplace/apps/vapi-ai/rating')
            .send({ stars: 4, comment: 'Needs review' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            status: 'pending',
            review: { app_key: 'vapi-ai', status: 'pending' },
            request_id: 'req_test',
        });
        expect(marketplaceRatingsService.submitReview).toHaveBeenCalledWith(
            'company-1',
            'user-1',
            'vapi-ai',
            4,
            'Needs review'
        );
    });

    test('POST rating maps REVIEW_LINKS_NOT_ALLOWED to the documented 422', async () => {
        marketplaceRatingsService.submitReview.mockRejectedValue(
            new marketplaceRatingsService.MarketplaceRatingsError(
                'Links are not allowed.',
                'REVIEW_LINKS_NOT_ALLOWED',
                422
            )
        );

        const res = await request(app)
            .post('/api/marketplace/apps/vapi-ai/rating')
            .send({ stars: 1, comment: 'https://example.test' });

        expect(res.status).toBe(422);
        expect(res.body).toEqual({
            success: false,
            code: 'REVIEW_LINKS_NOT_ALLOWED',
            message: 'Links are not allowed.',
            request_id: 'req_test',
        });
    });

    test('GET reviews returns posted reviews plus the viewer review envelope', async () => {
        marketplaceRatingsService.getPublicReviews.mockResolvedValue([{
            id: 12,
            app_key: 'vapi-ai',
            stars: 5,
            comment: 'Great',
            status: 'posted',
            reviewer_first_name: 'Alex',
            is_mine: false,
            created_at: '2026-07-26T12:00:00.000Z',
            updated_at: '2026-07-26T12:00:00.000Z',
        }]);

        const res = await request(app).get('/api/marketplace/apps/vapi-ai/reviews');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            app_key: 'vapi-ai',
            reviews: expect.any(Array),
            request_id: 'req_test',
        });
        expect(marketplaceRatingsService.getPublicReviews)
            .toHaveBeenCalledWith('company-1', 'user-1', 'vapi-ai');
    });

    test('DELETE rating removes only the current actor review', async () => {
        marketplaceRatingsService.deleteMyReview.mockResolvedValue({ deleted: true });

        const res = await request(app).delete('/api/marketplace/apps/vapi-ai/rating');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            deleted: true,
            request_id: 'req_test',
        });
        expect(marketplaceRatingsService.deleteMyReview)
            .toHaveBeenCalledWith('company-1', 'user-1', 'vapi-ai');
    });

    test('POST /apps/:appKey/install does not expose secret', async () => {
        marketplaceService.installApp.mockResolvedValue({
            id: 42,
            app_key: 'call-qa-agent',
            status: 'connected',
            key_id: 'blanc_test',
        });
        const res = await request(app).post('/api/marketplace/apps/call-qa-agent/install');
        expect(res.status).toBe(201);
        expect(res.body.installation.key_id).toBe('blanc_test');
        expect(JSON.stringify(res.body)).not.toContain('secret');
        expect(marketplaceService.installApp).toHaveBeenCalledWith(
            'company-1',
            'user-1',
            'call-qa-agent',
            expect.objectContaining({ requestId: 'req_test' })
        );
    });

    test('service errors map to documented code/status', async () => {
        marketplaceService.installApp.mockRejectedValue(
            new marketplaceService.MarketplaceServiceError('Already installed', 'APP_ALREADY_INSTALLED', 409)
        );
        const res = await request(app).post('/api/marketplace/apps/call-qa-agent/install');
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('APP_ALREADY_INSTALLED');
    });

    test('disconnect passes company and actor context', async () => {
        marketplaceService.disconnectInstallation.mockResolvedValue({
            id: 42,
            status: 'disconnected',
        });
        const res = await request(app).post('/api/marketplace/installations/42/disconnect');
        expect(res.status).toBe(200);
        expect(marketplaceService.disconnectInstallation).toHaveBeenCalledWith(
            'company-1',
            'user-1',
            '42',
            { requestId: 'req_test' }
        );
    });
});
