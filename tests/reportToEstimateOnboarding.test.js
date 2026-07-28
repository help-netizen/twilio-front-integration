'use strict';

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
    ensureDefaultReportToEstimateInstallation: jest.fn(),
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/billingService', () => ({
    startTrial: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/rulesSeed', () => ({
    seedDefaultRules: jest.fn(async () => {}),
}));

const fs = require('fs');
const path = require('path');
const marketplaceQueries = require('../backend/src/db/marketplaceQueries');
const platformCompanyService = require('../backend/src/services/platformCompanyService');
const companyQueries = require('../backend/src/db/companyQueries');

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
    jest.clearAllMocks();
    marketplaceQueries.ensureDefaultReportToEstimateInstallation.mockResolvedValue({
        id: 900,
        company_id: COMPANY_ID,
        status: 'connected',
        metadata: { seeded_by: 'REPORT-TO-ESTIMATE-001' },
    });
});

describe('Report → Estimate default-ON company onboarding', () => {
    test('self-signup creates the default installation in the company transaction', async () => {
        mockClient.query.mockImplementation(async (sql) => {
            const text = String(sql);
            if (text.includes('FROM companies') && text.includes('created_by_user_id')) {
                return { rows: [] };
            }
            if (text.includes('SELECT 1 FROM companies WHERE slug')) {
                return { rows: [] };
            }
            if (text.includes('INSERT INTO companies')) {
                return {
                    rows: [{
                        id: COMPANY_ID,
                        name: 'Acme Service',
                        slug: 'acme-service',
                        timezone: 'America/New_York',
                        status: 'active',
                    }],
                };
            }
            if (text.includes('INSERT INTO company_memberships')) {
                return { rows: [{ id: 81 }] };
            }
            return { rows: [] };
        });

        const result = await platformCompanyService.bootstrapCompany({
            userId: USER_ID,
            name: 'Acme Service',
            geo: { timezone: 'America/New_York' },
            phone: '+15551234567',
            email: 'owner@example.test',
        });

        expect(result).toMatchObject({
            created: true,
            company: { id: COMPANY_ID, name: 'Acme Service' },
        });
        expect(marketplaceQueries.ensureDefaultReportToEstimateInstallation)
            .toHaveBeenCalledWith(COMPANY_ID, {
                seededBy: 'REPORT-TO-ESTIMATE-001-SELF-SIGNUP',
                client: mockClient,
            });
        expect(JSON.stringify(
            marketplaceQueries.ensureDefaultReportToEstimateInstallation.mock.calls[0]
        )).not.toContain('instruction_text');
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
        expect(mockClient.release).toHaveBeenCalled();
    });

    test('self-signup retry repairs a missing default installation without duplicating company', async () => {
        mockClient.query.mockImplementation(async (sql) => {
            const text = String(sql);
            if (text.includes('FROM companies') && text.includes('created_by_user_id')) {
                return {
                    rows: [{
                        id: COMPANY_ID,
                        name: 'Acme Service',
                        timezone: 'America/New_York',
                        status: 'active',
                    }],
                };
            }
            return { rows: [] };
        });

        const result = await platformCompanyService.bootstrapCompany({
            userId: USER_ID,
            name: 'Acme Service',
            phone: '+15551234567',
            email: 'owner@example.test',
        });

        expect(result).toMatchObject({ created: false, company: { id: COMPANY_ID } });
        expect(marketplaceQueries.ensureDefaultReportToEstimateInstallation)
            .toHaveBeenCalledTimes(1);
        expect(mockClient.query.mock.calls.some(
            ([sql]) => String(sql).includes('INSERT INTO companies')
        )).toBe(false);
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    test('legacy admin company creation uses the same helper atomically', async () => {
        mockClient.query.mockImplementation(async (sql) => {
            const text = String(sql);
            if (text.includes('SELECT id FROM companies WHERE slug')) {
                return { rows: [] };
            }
            if (text.includes('INSERT INTO companies')) {
                return {
                    rows: [{
                        id: COMPANY_ID,
                        name: 'Admin Created',
                        slug: 'admin-created',
                    }],
                };
            }
            return { rows: [] };
        });

        const company = await companyQueries.createCompany({
            name: 'Admin Created',
            slug: 'admin-created',
            contact_email: 'admin@example.test',
        });

        expect(company.id).toBe(COMPANY_ID);
        expect(marketplaceQueries.ensureDefaultReportToEstimateInstallation)
            .toHaveBeenCalledWith(COMPANY_ID, {
                seededBy: 'REPORT-TO-ESTIMATE-001-ADMIN',
                client: mockClient,
            });
        expect(JSON.stringify(
            marketplaceQueries.ensureDefaultReportToEstimateInstallation.mock.calls[0]
        )).not.toContain('instruction_text');
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');

        const routeSource = fs.readFileSync(
            path.join(__dirname, '..', 'backend', 'src', 'routes', 'admin-companies.js'),
            'utf8'
        );
        expect(routeSource).toContain('companyQueries.createCompany({');
    });

    test('legacy admin company creation rolls back if default enablement fails', async () => {
        mockClient.query.mockImplementation(async (sql) => {
            const text = String(sql);
            if (text.includes('SELECT id FROM companies WHERE slug')) return { rows: [] };
            if (text.includes('INSERT INTO companies')) {
                return { rows: [{ id: COMPANY_ID, name: 'Broken', slug: 'broken' }] };
            }
            return { rows: [] };
        });
        marketplaceQueries.ensureDefaultReportToEstimateInstallation
            .mockRejectedValueOnce(new Error('marketplace seed missing'));

        await expect(companyQueries.createCompany({
            name: 'Broken',
            slug: 'broken',
        })).rejects.toThrow('marketplace seed missing');

        expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
        expect(mockClient.release).toHaveBeenCalled();
    });
});
