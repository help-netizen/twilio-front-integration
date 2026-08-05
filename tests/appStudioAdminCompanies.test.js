'use strict';

const express = require('express');
const request = require('supertest');

const COMPANY_A = '10000000-0000-4000-8000-000000000001';
const COMPANY_B = '10000000-0000-4000-8000-000000000002';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';

const mockCompanyQueries = {
    getCompanyById: jest.fn(),
    updateCompany: jest.fn(),
};
const mockAuditLog = jest.fn();

jest.mock('../backend/src/db/companyQueries', () => mockCompanyQueries);
jest.mock('../backend/src/services/auditService', () => ({ log: mockAuditLog }));

const router = require('../backend/src/routes/admin-companies');

let companies;

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            email: 'super-admin@albusto.test',
            crmUser: { id: ACTOR_ID },
        };
        req.traceId = 'trace-app-studio-toggle';
        next();
    });
    app.use('/api/admin/companies', router);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    companies = new Map([
        [COMPANY_A, {
            id: COMPANY_A,
            name: 'Tenant A',
            app_studio_enabled: false,
        }],
        [COMPANY_B, {
            id: COMPANY_B,
            name: 'Tenant B',
            app_studio_enabled: false,
        }],
    ]);
    mockCompanyQueries.getCompanyById.mockImplementation(async companyId => (
        companies.has(companyId) ? { ...companies.get(companyId) } : null
    ));
    mockCompanyQueries.updateCompany.mockImplementation(async (companyId, fields) => {
        const updated = { ...companies.get(companyId), ...fields };
        companies.set(companyId, updated);
        return { ...updated };
    });
    mockAuditLog.mockResolvedValue(undefined);
});

describe('APP-STUDIO-GATE-002 admin company toggle', () => {
    test('PATCH enables App Studio, persists it, and records the audit transition', async () => {
        const response = await request(buildApp())
            .patch(`/api/admin/companies/${COMPANY_A}/app-studio`)
            .send({ enabled: true });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            id: COMPANY_A,
            app_studio_enabled: true,
        });
        expect(mockCompanyQueries.updateCompany).toHaveBeenCalledWith(COMPANY_A, {
            app_studio_enabled: true,
        });
        expect(mockAuditLog).toHaveBeenCalledWith({
            actor_id: ACTOR_ID,
            actor_email: 'super-admin@albusto.test',
            action: 'company_app_studio_toggled',
            target_type: 'company',
            target_id: COMPANY_A,
            details: { previous: false, new: true },
            trace_id: 'trace-app-studio-toggle',
        });
    });

    test('non-boolean enabled is rejected before reads, writes, or audit', async () => {
        const response = await request(buildApp())
            .patch(`/api/admin/companies/${COMPANY_A}/app-studio`)
            .send({ enabled: 'true' });

        expect(response.status).toBe(400);
        expect(mockCompanyQueries.getCompanyById).not.toHaveBeenCalled();
        expect(mockCompanyQueries.updateCompany).not.toHaveBeenCalled();
        expect(mockAuditLog).not.toHaveBeenCalled();
    });

    test('missing company returns 404 without a write or audit', async () => {
        const response = await request(buildApp())
            .patch('/api/admin/companies/30000000-0000-4000-8000-000000000001/app-studio')
            .send({ enabled: true });

        expect(response.status).toBe(404);
        expect(mockCompanyQueries.updateCompany).not.toHaveBeenCalled();
        expect(mockAuditLog).not.toHaveBeenCalled();
    });

    test('T-blast: toggling one company leaves the other company byte-unchanged', async () => {
        const foreignBefore = JSON.stringify(companies.get(COMPANY_B));

        const response = await request(buildApp())
            .patch(`/api/admin/companies/${COMPANY_A}/app-studio`)
            .send({ enabled: true });

        expect(response.status).toBe(200);
        expect(JSON.stringify(companies.get(COMPANY_B))).toBe(foreignBefore);
        expect(mockCompanyQueries.updateCompany).toHaveBeenCalledTimes(1);
        expect(mockCompanyQueries.updateCompany).toHaveBeenCalledWith(
            COMPANY_A,
            { app_studio_enabled: true }
        );
    });
});
