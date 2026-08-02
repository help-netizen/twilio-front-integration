'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/estimatesService', () => ({}));
jest.mock('../backend/src/services/aiEstimateService', () => ({
    generateDraft: jest.fn(),
}));
jest.mock('../backend/src/services/reportPolishService', () => ({
    polishReport: jest.fn(),
}));
jest.mock('../backend/src/services/marketplaceService', () => ({
    REPORT_TO_ESTIMATE_APP_KEY: 'report-to-estimate',
    isAppConnected: jest.fn(),
}));
jest.mock('../backend/src/services/documentSendNoteService', () => ({
    actorFromRequest: jest.fn(),
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn(async () => {}),
}));

const reportPolishService = require('../backend/src/services/reportPolishService');
const marketplaceService = require('../backend/src/services/marketplaceService');
const router = require('../backend/src/routes/estimates');

const COMPANY_A = '00000000-0000-0000-0000-0000000000a1';
const ACTOR_A = '10000000-0000-0000-0000-0000000000a1';

function app({ roleKey = 'provider', companyId = COMPANY_A, membership } = {}) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
        req.companyFilter = companyId ? { company_id: companyId } : undefined;
        req.user = { crmUser: { id: ACTOR_A } };
        req.authz = {
            permissions: [],
            company: companyId ? { id: companyId } : null,
            // `undefined` keeps the default provider membership; pass `null` to
            // model an authenticated caller with no resolved tenant membership.
            membership: membership === undefined ? { role_key: roleKey } : membership,
        };
        next();
    });
    server.use('/api/estimates', router);
    return server;
}

beforeEach(() => {
    jest.clearAllMocks();
    marketplaceService.isAppConnected.mockResolvedValue(true);
    reportPolishService.polishReport.mockResolvedValue(
        'Technician Report\nFindings:\nThe inlet valve failed.'
    );
});

describe('POST /api/estimates/polish-report', () => {
    test('provider succeeds without estimates.create and receives the report envelope', async () => {
        const response = await request(app())
            .post('/api/estimates/polish-report')
            .send({ text: 'Washer no fill. Valve bad.' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            ok: true,
            data: {
                report: 'Technician Report\nFindings:\nThe inlet valve failed.',
            },
        });
        expect(marketplaceService.isAppConnected).toHaveBeenCalledWith(
            COMPANY_A,
            'report-to-estimate'
        );
        expect(reportPolishService.polishReport).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            text: 'Washer no fill. Valve bad.',
        });
    });

    test('tenant scope comes from companyFilter and ignores poisoned body company ids', async () => {
        const response = await request(app())
            .post('/api/estimates/polish-report')
            .send({
                company_id: '00000000-0000-0000-0000-0000000000b2',
                text: 'Oven does not ignite.',
            });

        expect(response.status).toBe(200);
        expect(marketplaceService.isAppConnected).toHaveBeenCalledWith(
            COMPANY_A,
            'report-to-estimate'
        );
        expect(reportPolishService.polishReport).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            text: 'Oven does not ignite.',
        });
    });

    test.each(['tenant_admin', 'manager', 'dispatcher'])(
        '%s is denied with provider_only before app or LLM access',
        async (roleKey) => {
            const response = await request(app({ roleKey }))
                .post('/api/estimates/polish-report')
                .send({ text: 'Dryer does not heat.' });

            expect(response.status).toBe(403);
            expect(response.body).toEqual({
                ok: false,
                error: {
                    code: 'provider_only',
                    message: 'Only providers can polish reports.',
                },
            });
            expect(marketplaceService.isAppConnected).not.toHaveBeenCalled();
            expect(reportPolishService.polishReport).not.toHaveBeenCalled();
        }
    );

    test('an authenticated caller with no resolved tenant membership is rejected before app or LLM access', async () => {
        // The runtime mount only guarantees authenticate + requireCompanyAccess,
        // so a plain authenticated user (no provider role) must not reach the
        // feature: the route owns a fail-closed provider gate, not open access.
        const response = await request(app({ membership: null }))
            .post('/api/estimates/polish-report')
            .send({ text: 'Garbage disposal jammed.' });

        expect(response.status).toBe(403);
        expect(response.body).toEqual({
            ok: false,
            error: {
                code: 'provider_only',
                message: 'Only providers can polish reports.',
            },
        });
        expect(marketplaceService.isAppConnected).not.toHaveBeenCalled();
        expect(reportPolishService.polishReport).not.toHaveBeenCalled();
    });

    test('an unrecognized custom role is denied like any other non-provider role', async () => {
        const response = await request(app({ roleKey: 'estimator' }))
            .post('/api/estimates/polish-report')
            .send({ text: 'Ice maker leaking.' });

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('provider_only');
        expect(marketplaceService.isAppConnected).not.toHaveBeenCalled();
        expect(reportPolishService.polishReport).not.toHaveBeenCalled();
    });

    test('disconnected app returns app_disabled before LLM access', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(false);

        const response = await request(app())
            .post('/api/estimates/polish-report')
            .send({ text: 'Refrigerator not cooling.' });

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            ok: false,
            error: {
                code: 'app_disabled',
                message: 'Report → Estimate is disabled for this company.',
            },
        });
        expect(reportPolishService.polishReport).not.toHaveBeenCalled();
    });

    test('missing company context is rejected before provider/app access', async () => {
        const response = await request(app({ companyId: null }))
            .post('/api/estimates/polish-report')
            .send({ text: 'Dishwasher does not drain.' });

        expect(response.status).toBe(403);
        expect(response.body).toEqual({
            ok: false,
            error: { code: 'FORBIDDEN', message: 'Company context is required' },
        });
        expect(marketplaceService.isAppConnected).not.toHaveBeenCalled();
        expect(reportPolishService.polishReport).not.toHaveBeenCalled();
    });
});
