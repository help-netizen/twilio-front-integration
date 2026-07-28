'use strict';

const fs = require('fs');
const path = require('path');

const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
};

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
    pool: {
        connect: jest.fn(async () => mockClient),
    },
}));
jest.mock('../backend/src/db/marketplaceQueries', () => ({
    ensureMarketplaceSchema: jest.fn(),
    reconcileRevokedInstallations: jest.fn(),
    listPublishedAppsWithInstallation: jest.fn(),
    getPublishedAppByKey: jest.fn(),
    findActiveInstallation: jest.fn(),
    findLatestInstallation: jest.fn(),
    listInstallations: jest.fn(),
    getInstallationById: jest.fn(),
    createInstallation: jest.fn(),
    updateInstallationCredential: jest.fn(),
    setInstallationSettings: jest.fn(),
    setInstallationInstructionText: jest.fn(),
    revokeCredentialById: jest.fn(),
    countOtherActiveInstallationsOnCredential: jest.fn(),
    markInstallationConnected: jest.fn(),
    markProvisioningFailed: jest.fn(),
    markDisconnected: jest.fn(),
    writeEvent: jest.fn(),
}));
jest.mock('../backend/src/db/emailQueries', () => ({ getMailboxByCompany: jest.fn() }));
jest.mock('../backend/src/services/emailMailboxService', () => ({ getMailboxStatus: jest.fn() }));
jest.mock('../backend/src/services/integrationsService', () => ({
    createIntegration: jest.fn(),
}));
jest.mock('../backend/src/services/marketplaceProvisioningService', () => ({
    pushCredentials: jest.fn(),
    sanitizeErrorMessage: (message) => message,
}));

const express = require('express');
const request = require('supertest');
const queries = require('../backend/src/db/marketplaceQueries');
const {
    DEFAULT_INSTRUCTION,
    MAX_INSTRUCTION_CHARS,
} = require('../backend/src/services/aiEstimateService');
const marketplaceService = require('../backend/src/services/marketplaceService');
const marketplaceRouter = require('../backend/src/routes/marketplace');
const { requirePermission } = require('../backend/src/middleware/authorization');
const { requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');

const COMPANY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTOR_A = '11111111-1111-4111-8111-111111111111';
const APP = {
    id: 212,
    app_key: 'report-to-estimate',
    name: 'Report → Estimate',
    provider_name: 'Albusto',
    category: 'ai',
    requested_scopes: [],
    provisioning_mode: 'none',
    status: 'published',
};

function installation(overrides = {}) {
    return {
        id: 700,
        company_id: COMPANY_A,
        app_id: APP.id,
        status: 'connected',
        metadata: { seeded_by: 'REPORT-TO-ESTIMATE-001' },
        ...overrides,
    };
}

function rbacApp(roleKey, permissions) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            email: `${roleKey}@example.test`,
            crmUser: { id: ACTOR_A },
        };
        req.authz = {
            scope: 'tenant',
            platform_role: 'none',
            company: { id: COMPANY_A, status: 'active' },
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

function scopedApp(companyId) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.companyFilter = { company_id: companyId };
        req.user = { crmUser: { id: ACTOR_A } };
        req.requestId = 'req-scope';
        next();
    });
    app.use('/api/marketplace', marketplaceRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockClient.query.mockResolvedValue({ rows: [] });
    queries.getPublishedAppByKey.mockResolvedValue(APP);
    queries.findActiveInstallation.mockResolvedValue(installation());
    queries.findLatestInstallation.mockResolvedValue(installation());
    queries.setInstallationInstructionText.mockImplementation(
        async (companyId, id, _appKey, instructionText) => installation({
            id,
            company_id: companyId,
            metadata: {
                seeded_by: 'REPORT-TO-ESTIMATE-001',
                sibling: true,
                instruction_text: instructionText,
            },
        })
    );
    queries.writeEvent.mockResolvedValue({});
    queries.countOtherActiveInstallationsOnCredential.mockResolvedValue(0);
});

describe('REPORT-TO-ESTIMATE-001 marketplace settings', () => {
    test('instruction SQL is a top-level metadata merge with company, id, and app guards', () => {
        const source = fs.readFileSync(
            path.join(
                __dirname,
                '..',
                'backend',
                'src',
                'db',
                'marketplaceQueries.js'
            ),
            'utf8'
        );
        const start = source.indexOf('async function setInstallationInstructionText');
        const end = source.indexOf('async function revokeCredentialById', start);
        const query = source.slice(start, end);

        expect(query).toContain(
            "COALESCE(installation.metadata, '{}'::jsonb)"
        );
        expect(query).toContain(
            "|| jsonb_build_object('instruction_text', $4::text)"
        );
        expect(query).toContain('installation.company_id = $1');
        expect(query).toContain('installation.id = $2');
        expect(query).toContain('app.app_key = $3');
        expect(query).not.toContain('jsonb_set');
    });

    test('APP key is stable and GET uses the single JS default without writing it', async () => {
        expect(marketplaceService.REPORT_TO_ESTIMATE_APP_KEY).toBe('report-to-estimate');

        const result = await marketplaceService.getReportToEstimateSettings(COMPANY_A);

        expect(result).toEqual({
            app_key: 'report-to-estimate',
            enabled: true,
            installation_id: 700,
            instruction_text: DEFAULT_INSTRUCTION,
        });
        expect(queries.findLatestInstallation).toHaveBeenCalledWith(COMPANY_A, APP.id);
        expect(queries.setInstallationInstructionText).not.toHaveBeenCalled();
        expect(queries.writeEvent).not.toHaveBeenCalled();
    });

    test('GET returns a disconnected company custom instruction and a no-row company default', async () => {
        queries.findLatestInstallation.mockResolvedValueOnce(installation({
            status: 'disconnected',
            metadata: {
                seeded_by: 'REPORT-TO-ESTIMATE-001',
                instruction_text: '  Keep diagnostic labor separate.  ',
            },
        }));

        await expect(marketplaceService.getReportToEstimateSettings(COMPANY_A))
            .resolves.toEqual({
                app_key: 'report-to-estimate',
                enabled: false,
                installation_id: 700,
                instruction_text: 'Keep diagnostic labor separate.',
            });

        queries.findLatestInstallation.mockResolvedValueOnce(null);
        await expect(marketplaceService.getReportToEstimateSettings(COMPANY_B))
            .resolves.toEqual({
                app_key: 'report-to-estimate',
                enabled: false,
                installation_id: null,
                instruction_text: DEFAULT_INSTRUCTION,
            });
    });

    test('PATCH top-level-merges the custom instruction and audits no prompt text', async () => {
        const custom = 'Prefer the complete service group when the report names a standard repair.';
        const result = await marketplaceService.updateReportToEstimateInstruction(
            COMPANY_A,
            ACTOR_A,
            { instruction_text: `  ${custom}  ` },
            { requestId: 'req-patch' }
        );

        expect(queries.setInstallationInstructionText).toHaveBeenCalledWith(
            COMPANY_A,
            700,
            'report-to-estimate',
            custom
        );
        expect(result).toEqual({
            app_key: 'report-to-estimate',
            enabled: true,
            installation_id: 700,
            instruction_text: custom,
        });
        expect(queries.writeEvent).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            installationId: 700,
            appId: APP.id,
            actorId: ACTOR_A,
            eventType: 'settings_updated',
            requestId: 'req-patch',
            payload: {
                app_key: 'report-to-estimate',
                instruction_length: custom.length,
            },
        });
        expect(JSON.stringify(queries.writeEvent.mock.calls[0][0])).not.toContain(custom);
    });

    test.each([
        [{}, 'instruction_text must be a string.'],
        [{ instruction_text: null }, 'instruction_text must be a string.'],
        [{ instruction_text: '   ' }, 'instruction_text cannot be empty.'],
        [
            { instruction_text: 'x'.repeat(MAX_INSTRUCTION_CHARS + 1) },
            `instruction_text must be ${MAX_INSTRUCTION_CHARS} characters or fewer.`,
        ],
    ])('PATCH rejects invalid instruction without writes or events', async (body, message) => {
        await expect(marketplaceService.updateReportToEstimateInstruction(
            COMPANY_A,
            ACTOR_A,
            body
        )).rejects.toMatchObject({
            code: 'INVALID_INSTRUCTION',
            httpStatus: 400,
            message,
        });
        expect(queries.setInstallationInstructionText).not.toHaveBeenCalled();
        expect(queries.writeEvent).not.toHaveBeenCalled();
    });

    test('PATCH without any company installation returns 404 before write', async () => {
        queries.findLatestInstallation.mockResolvedValue(null);

        await expect(marketplaceService.updateReportToEstimateInstruction(
            COMPANY_A,
            ACTOR_A,
            { instruction_text: 'Valid custom instruction.' }
        )).rejects.toMatchObject({
            code: 'APP_NOT_INSTALLED',
            httpStatus: 404,
        });
        expect(queries.setInstallationInstructionText).not.toHaveBeenCalled();
    });

    test('reconnect copies only the previous custom instruction into the new installation', async () => {
        const custom = 'Preserve this company-specific instruction.';
        queries.findActiveInstallation.mockResolvedValue(null);
        queries.findLatestInstallation.mockResolvedValue(installation({
            status: 'disconnected',
            metadata: {
                seeded_by: 'REPORT-TO-ESTIMATE-001',
                instruction_text: custom,
            },
        }));
        queries.createInstallation.mockResolvedValue({
            id: 701,
            status: 'provisioning_failed',
            metadata: { instruction_text: custom },
        });
        queries.markInstallationConnected.mockResolvedValue({
            id: 701,
            status: 'connected',
            metadata: { instruction_text: custom },
        });

        const result = await marketplaceService.installApp(
            COMPANY_A,
            ACTOR_A,
            'report-to-estimate',
            { requestId: 'req-reconnect' }
        );

        expect(queries.findLatestInstallation).toHaveBeenCalledWith(
            COMPANY_A,
            APP.id,
            mockClient
        );
        expect(queries.createInstallation).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            appId: APP.id,
            actorId: ACTOR_A,
            status: 'provisioning_failed',
            metadata: { instruction_text: custom },
        }, mockClient);
        expect(result).toMatchObject({ id: 701, status: 'connected' });
    });

    test('reconnect keeps instruction_text absent when the company never edited the default', async () => {
        queries.findActiveInstallation.mockResolvedValue(null);
        queries.findLatestInstallation.mockResolvedValue(installation({
            status: 'disconnected',
            metadata: { seeded_by: 'REPORT-TO-ESTIMATE-001' },
        }));
        queries.createInstallation.mockResolvedValue({ id: 702, status: 'provisioning_failed' });
        queries.markInstallationConnected.mockResolvedValue({ id: 702, status: 'connected' });

        await marketplaceService.installApp(
            COMPANY_A,
            ACTOR_A,
            'report-to-estimate'
        );

        expect(queries.createInstallation).toHaveBeenCalledWith(
            expect.objectContaining({ metadata: {} }),
            mockClient
        );
    });

    test('T-foreign: poisoned company and installation ids cannot address another tenant', async () => {
        queries.findLatestInstallation.mockImplementation(async (companyId) => (
            companyId === COMPANY_B ? null : installation()
        ));

        const response = await request(scopedApp(COMPANY_B))
            .patch('/api/marketplace/apps/report-to-estimate/settings')
            .send({
                company_id: COMPANY_A,
                installation_id: 700,
                instruction_text: 'Attempted cross-tenant overwrite.',
            });

        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({
            success: false,
            code: 'APP_NOT_INSTALLED',
            request_id: 'req-scope',
        });
        expect(queries.findLatestInstallation).toHaveBeenCalledWith(COMPANY_B, APP.id);
        expect(queries.setInstallationInstructionText).not.toHaveBeenCalled();
    });
});

describe('Report → Estimate settings inherited RBAC', () => {
    test.each(['manager', 'dispatcher', 'provider'])(
        'R-matrix %s without tenant.integrations.manage is denied on GET and PATCH',
        async (roleKey) => {
            const app = rbacApp(roleKey, []);
            const getResponse = await request(app)
                .get('/api/marketplace/apps/report-to-estimate/settings');
            const patchResponse = await request(app)
                .patch('/api/marketplace/apps/report-to-estimate/settings')
                .send({ instruction_text: 'Denied.' });

            expect([getResponse.status, patchResponse.status]).toEqual([403, 403]);
            expect(queries.getPublishedAppByKey).not.toHaveBeenCalled();
            expect(queries.setInstallationInstructionText).not.toHaveBeenCalled();
        }
    );

    test('tenant_admin with tenant.integrations.manage can GET and PATCH', async () => {
        const app = rbacApp('tenant_admin', ['tenant.integrations.manage']);
        const getResponse = await request(app)
            .get('/api/marketplace/apps/report-to-estimate/settings');
        const patchResponse = await request(app)
            .patch('/api/marketplace/apps/report-to-estimate/settings')
            .send({ instruction_text: 'Use company service groups.' });

        expect([getResponse.status, patchResponse.status]).toEqual([200, 200]);
        expect(queries.findLatestInstallation).toHaveBeenCalledWith(COMPANY_A, APP.id);
        expect(queries.setInstallationInstructionText).toHaveBeenCalledWith(
            COMPANY_A,
            700,
            'report-to-estimate',
            'Use company service groups.'
        );
    });
});
