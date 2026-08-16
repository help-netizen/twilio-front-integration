'use strict';

const express = require('express');
const request = require('supertest');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const CRM_USER_ID = '22222222-2222-4222-8222-222222222222';
const KEYCLOAK_SUB = '11111111-1111-4111-8111-111111111111';
const mockTxClient = { query: jest.fn() };

const mockEstimatesService = {
    listEstimates: jest.fn(),
    getEstimate: jest.fn(),
    createEstimate: jest.fn(),
    updateEstimate: jest.fn(),
    archiveEstimate: jest.fn(),
    restoreEstimate: jest.fn(),
    sendEstimate: jest.fn(),
    ensurePublicLink: jest.fn(),
    approveEstimate: jest.fn(),
    declineEstimate: jest.fn(),
    convertToInvoice: jest.fn(),
    undoInvoiceConversion: jest.fn(),
    linkJob: jest.fn(),
    getRevisions: jest.fn(),
    getEvents: jest.fn(),
    addItem: jest.fn(),
    addItems: jest.fn(),
    updateItem: jest.fn(),
    removeItem: jest.fn(),
    generatePdf: jest.fn(),
};

jest.mock('../backend/src/services/estimatesService', () => mockEstimatesService);
jest.mock('../backend/src/services/aiEstimateService', () => ({ generateDraft: jest.fn() }));
jest.mock('../backend/src/services/aiGenerationLogService', () => ({
    linkFinal: jest.fn(),
    record: jest.fn(),
    renderMarkdown: jest.fn(),
}));
jest.mock('../backend/src/services/reportPolishService', () => ({ polishReport: jest.fn() }));
jest.mock('../backend/src/services/marketplaceService', () => ({
    REPORT_TO_ESTIMATE_APP_KEY: 'report-to-estimate',
    isAppConnected: jest.fn(),
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/documentSendNoteService', () => ({
    actorFromRequest: jest.fn(() => ({ type: 'user', id: CRM_USER_ID })),
}));
jest.mock('../backend/src/services/financialActivityService', () => ({
    userActor: jest.fn(id => ({ id, type: 'user', label: null, source: 'crm' })),
}));
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: jest.fn(work => work(mockTxClient)),
}));

const estimatesRouter = require('../backend/src/routes/estimates');

function appWith({ permissions = [], roleKey = 'dispatcher', companyId = COMPANY_A } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            sub: KEYCLOAK_SUB,
            email: 'staff@example.com',
            crmUser: { id: CRM_USER_ID },
        };
        req.authz = {
            permissions,
            membership: { role_key: roleKey },
            company: { id: companyId },
        };
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/api/estimates', estimatesRouter);
    return app;
}

function invoke(app, method, path) {
    const call = request(app)[method.toLowerCase()](path);
    if (method === 'GET') return call;
    return call.send({
        invoice_id: 99,
        job_id: 77,
        channel: 'email',
        recipient: 'customer@example.com',
        reason: 'Customer request',
        items: [],
    });
}

const PERMISSIONED_ROUTES = [
    ['GET', '/api/estimates', 'estimates.view'],
    ['POST', '/api/estimates', 'estimates.create'],
    ['POST', '/api/estimates/ai-draft', 'estimates.create'],
    ['GET', '/api/estimates/ai-generation-log.md', 'estimates.view'],
    ['GET', '/api/estimates/42', 'estimates.view'],
    ['PUT', '/api/estimates/42', 'estimates.create'],
    ['POST', '/api/estimates/42/archive', 'estimates.create'],
    ['POST', '/api/estimates/42/restore', 'estimates.create'],
    ['DELETE', '/api/estimates/42', 'estimates.create'],
    ['POST', '/api/estimates/42/send', 'estimates.send'],
    ['POST', '/api/estimates/42/public-link', 'estimates.send'],
    ['POST', '/api/estimates/42/approve', 'estimates.send'],
    ['POST', '/api/estimates/42/decline', 'estimates.send'],
    ['POST', '/api/estimates/42/convert', 'invoices.create'],
    ['POST', '/api/estimates/42/convert/undo', 'invoices.create'],
    ['POST', '/api/estimates/42/link-job', 'estimates.create'],
    ['POST', '/api/estimates/42/copy-to-invoice', 'invoices.create'],
    ['GET', '/api/estimates/42/revisions', 'estimates.view'],
    ['GET', '/api/estimates/42/events', 'estimates.view'],
    ['GET', '/api/estimates/42/payments', 'payments.view'],
    ['POST', '/api/estimates/42/items', 'estimates.create'],
    ['POST', '/api/estimates/42/items/bulk', 'estimates.create'],
    ['PUT', '/api/estimates/42/items/7', 'estimates.create'],
    ['DELETE', '/api/estimates/42/items/7', 'estimates.create'],
    ['GET', '/api/estimates/42/attachments', 'estimates.view'],
    ['POST', '/api/estimates/42/attachments', 'estimates.create'],
    ['GET', '/api/estimates/42/pdf', 'estimates.view'],
];

beforeEach(() => {
    jest.clearAllMocks();
    mockEstimatesService.convertToInvoice.mockResolvedValue({
        id: 99,
        already_converted: false,
    });
    mockEstimatesService.undoInvoiceConversion.mockResolvedValue({
        invoice_id: 99,
        undone: true,
        estimate: { id: 42, status: 'sent', invoice_id: null },
    });
});

describe('estimate route permission matrix', () => {
    test.each(PERMISSIONED_ROUTES)(
        '%s %s declares %s and returns a clean 403 when it is absent',
        async (method, path) => {
            const response = await invoke(appWith({ permissions: [] }), method, path);

            expect(response.status).toBe(403);
            expect(response.body).toMatchObject({
                code: 'ACCESS_DENIED',
                message: 'Insufficient permissions',
            });
        }
    );

    test.each(['tenant_admin', 'manager', 'dispatcher', 'provider'])(
        'R-matrix: %s without invoices.create cannot convert or undo',
        async roleKey => {
            const app = appWith({
                roleKey,
                permissions: ['estimates.view', 'estimates.create', 'estimates.send', 'invoices.view'],
            });
            const converted = await invoke(app, 'POST', '/api/estimates/42/convert');
            const undone = await invoke(app, 'POST', '/api/estimates/42/convert/undo');

            expect(converted.status).toBe(403);
            expect(undone.status).toBe(403);
            expect(mockEstimatesService.convertToInvoice).not.toHaveBeenCalled();
            expect(mockEstimatesService.undoInvoiceConversion).not.toHaveBeenCalled();
        }
    );

    test('conversion and Undo require invoices.create without also requiring invoices.view', async () => {
        const app = appWith({ permissions: ['invoices.create'] });

        const converted = await invoke(app, 'POST', '/api/estimates/42/convert');
        const undone = await invoke(app, 'POST', '/api/estimates/42/convert/undo');

        expect(converted.status).toBe(201);
        expect(undone.status).toBe(200);
        expect(mockEstimatesService.convertToInvoice).toHaveBeenCalled();
        expect(mockEstimatesService.undoInvoiceConversion).toHaveBeenCalled();
    });

    test('invoices.view without invoices.create cannot convert or undo', async () => {
        const app = appWith({ permissions: ['invoices.view'] });

        expect((await invoke(app, 'POST', '/api/estimates/42/convert')).status).toBe(403);
        expect((await invoke(app, 'POST', '/api/estimates/42/convert/undo')).status).toBe(403);
    });

    test('T-own/T-blast: route uses companyFilter and crmUser.id, ignoring forged body tenant and Keycloak sub', async () => {
        const response = await request(appWith({ permissions: ['invoices.create'] }))
            .post('/api/estimates/42/convert/undo')
            .send({ invoice_id: 99, company_id: '00000000-0000-0000-0000-00000000000b' });

        expect(response.status).toBe(200);
        expect(mockEstimatesService.undoInvoiceConversion).toHaveBeenCalledWith(
            COMPANY_A,
            CRM_USER_ID,
            '42',
            99,
            mockTxClient,
            { id: CRM_USER_ID, type: 'user', label: null, source: 'crm' }
        );
        expect(JSON.stringify(mockEstimatesService.undoInvoiceConversion.mock.calls))
            .not.toContain(KEYCLOAK_SUB);
    });

    test('standalone create uses companyFilter and crmUser.id, ignoring a forged body tenant', async () => {
        mockEstimatesService.createEstimate.mockResolvedValue({
            id: 43,
            estimate_number: 'ESTIMATE L-0-1',
        });
        const body = {
            company_id: '00000000-0000-0000-0000-00000000000b',
            summary: 'Standalone diagnostic',
        };

        const response = await request(appWith({ permissions: ['estimates.create'] }))
            .post('/api/estimates')
            .send(body);

        expect(response.status).toBe(201);
        expect(mockEstimatesService.createEstimate).toHaveBeenCalledWith(
            COMPANY_A,
            CRM_USER_ID,
            body,
            mockTxClient,
            { id: CRM_USER_ID, type: 'user', label: null, source: 'crm' }
        );
        expect(JSON.stringify(mockEstimatesService.createEstimate.mock.calls))
            .not.toContain(KEYCLOAK_SUB);
    });

    test('T-foreign: service 404 is preserved and no success body is returned', async () => {
        mockEstimatesService.undoInvoiceConversion.mockRejectedValue(Object.assign(
            new Error('Estimate 42 not found'),
            { code: 'NOT_FOUND', httpStatus: 404 }
        ));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        const response = await invoke(
            appWith({ permissions: ['invoices.create'] }),
            'POST',
            '/api/estimates/42/convert/undo'
        );

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
            ok: false,
            error: { code: 'NOT_FOUND', message: 'Estimate 42 not found' },
        });
        error.mockRestore();
    });

    test('polish-report remains provider/app-gated and returns a clean 403 to other roles', async () => {
        const response = await request(appWith({ roleKey: 'manager' }))
            .post('/api/estimates/polish-report')
            .send({ text: 'Replace valve' });

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('provider_only');
    });
});
