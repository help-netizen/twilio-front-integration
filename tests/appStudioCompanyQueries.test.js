'use strict';

const fs = require('fs');
const path = require('path');

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
};
const mockDbQuery = jest.fn();
const mockDefaultInstallation = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    query: mockDbQuery,
    pool: { connect: jest.fn(async () => mockClient) },
}));
jest.mock('../backend/src/db/marketplaceQueries', () => ({
    ensureDefaultReportToEstimateInstallation: mockDefaultInstallation,
}));

const companyQueries = require('../backend/src/db/companyQueries');

beforeEach(() => {
    jest.clearAllMocks();
    mockDefaultInstallation.mockResolvedValue(undefined);
});

describe('APP-STUDIO-GATE-002 company data access', () => {
    test('migration adds a non-null false default and rollback removes only the column', () => {
        const migrations = path.join(__dirname, '..', 'backend', 'db', 'migrations');
        const forward = fs.readFileSync(
            path.join(migrations, '239_app_studio_per_company_gate.sql'),
            'utf8'
        );
        const rollback = fs.readFileSync(
            path.join(migrations, 'rollback_239_app_studio_per_company_gate.sql'),
            'utf8'
        );

        expect(forward).toContain(
            'ADD COLUMN IF NOT EXISTS app_studio_enabled BOOLEAN NOT NULL DEFAULT false'
        );
        expect(forward).not.toMatch(/UPDATE\s+companies/i);
        expect(rollback).toContain('DROP COLUMN IF EXISTS app_studio_enabled');
    });

    test('createCompany leaves App Studio to the database default false', async () => {
        mockClient.query.mockImplementation(async sql => {
            const text = String(sql);
            if (text.includes('SELECT id FROM companies WHERE slug')) return { rows: [] };
            if (text.includes('INSERT INTO companies')) {
                return {
                    rows: [{
                        id: COMPANY_ID,
                        name: 'New Tenant',
                        slug: 'new-tenant',
                        app_studio_enabled: false,
                    }],
                };
            }
            return { rows: [] };
        });

        const company = await companyQueries.createCompany({
            name: 'New Tenant',
            slug: 'new-tenant',
        });

        expect(company.app_studio_enabled).toBe(false);
        const insertSql = String(mockClient.query.mock.calls.find(
            ([sql]) => String(sql).includes('INSERT INTO companies')
        )[0]);
        expect(insertSql).not.toContain('app_studio_enabled');
        expect(mockDefaultInstallation).toHaveBeenCalledWith(COMPANY_ID, {
            seededBy: 'REPORT-TO-ESTIMATE-001-ADMIN',
            client: mockClient,
        });
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    test('getCompanyById and listCompanies include app_studio_enabled', async () => {
        mockDbQuery
            .mockResolvedValueOnce({ rows: [{ id: COMPANY_ID, app_studio_enabled: false }] })
            .mockResolvedValueOnce({ rows: [{ total: '1' }] })
            .mockResolvedValueOnce({ rows: [{ id: COMPANY_ID, app_studio_enabled: false }] });

        await companyQueries.getCompanyById(COMPANY_ID);
        await companyQueries.listCompanies();

        expect(String(mockDbQuery.mock.calls[0][0])).toContain('app_studio_enabled');
        expect(String(mockDbQuery.mock.calls[2][0])).toContain('app_studio_enabled');
    });

    test('updateCompany accepts a parameterized app_studio_enabled update by company id', async () => {
        mockDbQuery.mockResolvedValueOnce({
            rows: [{ id: COMPANY_ID, app_studio_enabled: true }],
        });

        const updated = await companyQueries.updateCompany(COMPANY_ID, {
            app_studio_enabled: true,
        });

        expect(updated.app_studio_enabled).toBe(true);
        expect(String(mockDbQuery.mock.calls[0][0])).toContain('app_studio_enabled = $1');
        expect(mockDbQuery.mock.calls[0][1]).toEqual([true, COMPANY_ID]);
    });
});
