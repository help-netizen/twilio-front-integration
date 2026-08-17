'use strict';

const mockQuery = jest.fn();

jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const queries = require('../backend/src/db/chatgptMcpQueries');
const {
    generateSandboxFixtures,
    projectSandboxTool,
} = require('../apps-runtime/src/sandboxFixtures');

function asDate(value) {
    return value == null ? null : new Date(value);
}

function withTotal(rows) {
    return rows.map(row => ({ ...row, _total: rows.length }));
}

describe('APP-DATA-001 Phase H production/sandbox projection parity', () => {
    beforeEach(() => jest.clearAllMocks());

    test('all four read tools return exact live/sandbox shapes and Lead list is PII-lean', async () => {
        const fixtures = generateSandboxFixtures('phase-h-projection-parity', '2026-08-03');
        const leadRows = fixtures.leads.map(lead => ({
            ...lead,
            created_at: asDate(lead.created_at),
            converted_at: asDate(lead.converted_at),
        })).sort((left, right) => right.created_at - left.created_at || right.id - left.id);
        mockQuery.mockResolvedValueOnce({ rows: withTotal(leadRows) });
        const liveLeads = await queries.listAppLeads(fixtures.company.id, {
            companyTimezone: fixtures.company.timezone,
            limit: 100,
            offset: 0,
        });
        const sandboxLeads = projectSandboxTool(fixtures, 'svc.list_leads', {
            limit: 100,
            offset: 0,
        });
        expect(sandboxLeads).toEqual(liveLeads);
        expect(sandboxLeads.results.length).toBeGreaterThan(0);
        expect(sandboxLeads.results.every(row => (
            !Object.prototype.hasOwnProperty.call(row, 'phone')
            && !Object.prototype.hasOwnProperty.call(row, 'email')
        ))).toBe(true);
        expect(sandboxLeads.results.every(row => (
            Number.isInteger(row.lead_seq)
            && /^[0-9A-Za-z]{5}$/.test(row.public_code)
            && Object.prototype.hasOwnProperty.call(row, 'serial_id')
        ))).toBe(true);
        expect(mockQuery.mock.calls[0][0]).toContain('l.lead_seq');
        expect(mockQuery.mock.calls[0][0]).toContain('l.public_code');

        const selectedLead = fixtures.leads[0];
        mockQuery.mockResolvedValueOnce({
            rows: [{
                ...selectedLead,
                created_at: asDate(selectedLead.created_at),
                converted_at: asDate(selectedLead.converted_at),
            }],
        });
        const liveLead = await queries.getAppLead(fixtures.company.id, selectedLead.id);
        const sandboxLead = projectSandboxTool(fixtures, 'svc.get_lead', {
            lead_id: selectedLead.id,
        });
        expect(sandboxLead).toEqual(liveLead);
        expect(sandboxLead).toEqual(expect.objectContaining({
            phone: expect.stringMatching(/^\+161755501/),
            email: expect.stringMatching(/@example\.com$/),
        }));

        const invoiceRows = fixtures.invoices.map(invoice => ({
            ...invoice,
            created_at: asDate(invoice.created_at),
            due_at: asDate(invoice.due_at),
        })).sort((left, right) => right.created_at - left.created_at || right.id - left.id);
        mockQuery.mockResolvedValueOnce({ rows: withTotal(invoiceRows) });
        const liveInvoices = await queries.listAppInvoices(fixtures.company.id, {
            companyTimezone: fixtures.company.timezone,
            limit: 100,
            offset: 0,
        });
        const sandboxInvoices = projectSandboxTool(fixtures, 'svc.list_invoices', {
            limit: 100,
            offset: 0,
        });
        expect(sandboxInvoices).toEqual(liveInvoices);

        const paymentRows = fixtures.payments.map(payment => ({
            ...payment,
            paid_at: asDate(payment.paid_at),
        })).sort((left, right) => right.paid_at - left.paid_at || right.id - left.id);
        mockQuery.mockResolvedValueOnce({ rows: withTotal(paymentRows) });
        const livePayments = await queries.listAppPayments(fixtures.company.id, {
            companyTimezone: fixtures.company.timezone,
            limit: 100,
            offset: 0,
        });
        const sandboxPayments = projectSandboxTool(fixtures, 'svc.list_payments', {
            limit: 100,
            offset: 0,
        });
        expect(sandboxPayments).toEqual(livePayments);
    });

    test.each([
        ['svc.list_leads', 'leads', 'created_at', 'created_from', 'created_to'],
        ['svc.list_invoices', 'invoices', 'created_at', 'created_from', 'created_to'],
        ['svc.list_payments', 'payments', 'paid_at', 'paid_from', 'paid_to'],
    ])('%s includes the company evening and excludes the next company day', (
        toolName,
        collection,
        timestampField,
        fromField,
        toField
    ) => {
        const fixtures = generateSandboxFixtures(`phase-h-timezone-${toolName}`, '2026-08-03');
        const row = {
            ...fixtures[collection][0],
            id: 990000 + fixtures[collection][0].id,
            [timestampField]: '2026-08-04T03:30:00.000Z',
        };
        fixtures[collection].push(row);
        const localDay = projectSandboxTool(fixtures, toolName, {
            [fromField]: '2026-08-03',
            [toField]: '2026-08-03',
            limit: 100,
            offset: 0,
        });
        const nextDay = projectSandboxTool(fixtures, toolName, {
            [fromField]: '2026-08-04',
            [toField]: '2026-08-04',
            limit: 100,
            offset: 0,
        });
        expect(localDay.results.map(candidate => candidate.id)).toContain(row.id);
        expect(nextDay.results.map(candidate => candidate.id)).not.toContain(row.id);
    });

    test('live Lead, Invoice, and Payment queries receive company-local date boundaries', async () => {
        mockQuery.mockResolvedValue({ rows: [] });
        const common = {
            companyTimezone: 'America/New_York',
            limit: 10,
            offset: 0,
        };
        await queries.listAppLeads('company-a', {
            ...common, created_from: '2026-08-03', created_to: '2026-08-03',
        });
        await queries.listAppInvoices('company-a', {
            ...common, created_from: '2026-08-03', created_to: '2026-08-03',
        });
        await queries.listAppPayments('company-a', {
            ...common, paid_from: '2026-08-03', paid_to: '2026-08-03',
        });
        for (const [, params] of mockQuery.mock.calls) {
            expect(params).toEqual(expect.arrayContaining([
                '2026-08-03T04:00:00.000Z',
                '2026-08-04T04:00:00.000Z',
            ]));
        }
    });

    test('Lead search matches both the new per-company number and legacy serial_id', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        await queries.listAppLeads('company-a', {
            companyTimezone: 'America/New_York',
            search: '31',
            limit: 10,
            offset: 0,
        });

        const [sql] = mockQuery.mock.calls[0];
        expect(sql).toContain('l.lead_seq::text ILIKE');
        expect(sql).toContain('l.serial_id::text ILIKE');
    });
});
