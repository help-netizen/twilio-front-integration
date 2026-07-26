'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/estimatesService', () => ({}));
jest.mock('../backend/src/services/aiEstimateService', () => ({
    generateDraft: jest.fn(),
}));
jest.mock('../backend/src/services/documentSendNoteService', () => ({
    actorFromRequest: jest.fn(),
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn(async () => {}),
}));

const aiEstimateService = require('../backend/src/services/aiEstimateService');
const router = require('../backend/src/routes/estimates');

const COMPANY_A = '00000000-0000-0000-0000-0000000000a1';
const ACTOR_A = '10000000-0000-0000-0000-0000000000a1';

function app({
    permissions = [],
    roleKey = 'provider',
    companyId = COMPANY_A,
} = {}) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
        req.companyFilter = companyId ? { company_id: companyId } : undefined;
        req.user = { crmUser: { id: ACTOR_A } };
        req.authz = {
            permissions,
            company: companyId ? { id: companyId } : null,
            membership: { role_key: roleKey },
        };
        next();
    });
    server.use('/api/estimates', router);
    return server;
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('POST /api/estimates/ai-draft', () => {
    test.each(['tenant_admin', 'manager', 'dispatcher', 'provider'])(
        'R-matrix %s without estimates.create is denied before extraction',
        async (roleKey) => {
            const response = await request(app({
                permissions: ['estimates.view', 'price_book.manage'],
                roleKey,
            }))
                .post('/api/estimates/ai-draft')
                .send({ report_text: 'Replace inlet valve.' });

            expect(response.status).toBe(403);
            expect(aiEstimateService.generateDraft).not.toHaveBeenCalled();
        },
    );

    test('returns the exact draft shape and passes tenant, actor, job, and manage capability', async () => {
        const draft = {
            summary: 'Replace inlet valve.',
            line_items: [{
                title: 'Inlet valve',
                qty: 1,
                unit_price: 95,
                price_source: 'price_book',
                price_book_item_id: 7,
                created: false,
                category_path: ['Washer Repair'],
            }],
        };
        aiEstimateService.generateDraft.mockResolvedValue(draft);

        const response = await request(app({
            permissions: ['estimates.create', 'price_book.manage'],
            roleKey: 'manager',
        }))
            .post('/api/estimates/ai-draft')
            .send({ report_text: 'Replace inlet valve.', job_id: 42 });

        expect(response.status).toBe(200);
        expect(response.body).toEqual(draft);
        expect(aiEstimateService.generateDraft).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            actorId: ACTOR_A,
            reportText: 'Replace inlet valve.',
            jobId: 42,
            canManagePriceBook: true,
        });
    });

    test('permission degrade reaches the service with canManagePriceBook false, not a 403', async () => {
        const draft = {
            summary: 'Custom work.',
            line_items: [{
                title: 'Custom bracket',
                qty: 1,
                unit_price: 0,
                price_source: 'report',
                price_book_item_id: null,
                created: false,
            }],
        };
        aiEstimateService.generateDraft.mockResolvedValue(draft);

        const response = await request(app({
            permissions: ['estimates.create', 'price_book.view'],
            roleKey: 'provider',
        }))
            .post('/api/estimates/ai-draft')
            .send({ report_text: 'Fabricate custom bracket.' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual(draft);
        expect(aiEstimateService.generateDraft).toHaveBeenCalledWith(expect.objectContaining({
            companyId: COMPANY_A,
            actorId: ACTOR_A,
            canManagePriceBook: false,
        }));
    });

    test('missing tenant context is rejected before extraction', async () => {
        const response = await request(app({
            permissions: ['estimates.create', 'price_book.manage'],
            companyId: null,
        }))
            .post('/api/estimates/ai-draft')
            .send({ report_text: 'Replace inlet valve.' });

        expect(response.status).toBe(403);
        expect(aiEstimateService.generateDraft).not.toHaveBeenCalled();
    });

    test('toastable service errors preserve status, code, and message', async () => {
        aiEstimateService.generateDraft.mockRejectedValue(Object.assign(
            new Error('AI draft generation is temporarily unavailable. Please try again.'),
            { code: 'ai_draft_unavailable', httpStatus: 503 },
        ));

        const response = await request(app({ permissions: ['estimates.create'] }))
            .post('/api/estimates/ai-draft')
            .send({ report_text: 'Replace inlet valve.' });

        expect(response.status).toBe(503);
        expect(response.body).toEqual({
            ok: false,
            error: {
                code: 'ai_draft_unavailable',
                message: 'AI draft generation is temporarily unavailable. Please try again.',
            },
        });
    });
});
