'use strict';

const fs = require('fs');
const path = require('path');

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: (...args) => mockQuery(...args) }));

const estimatesQueries = require('../backend/src/db/estimatesQueries');
const invoicesQueries = require('../backend/src/db/invoicesQueries');
const migration = fs.readFileSync(path.join(
    __dirname,
    '..',
    'backend',
    'db',
    'migrations',
    '282_invoice_estimate_numbering.sql'
), 'utf8');

beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
});

test('Estimate code resolution is deliberately global and projects redirect identifiers', async () => {
    await estimatesQueries.getEstimateByCode('E3a9Z');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('e.id, e.company_id, e.public_code, e.estimate_number');
    expect(sql).toContain('WHERE e.public_code = $1');
    expect(sql).not.toContain('company_id = $2');
    expect(params).toEqual(['E3a9Z']);
});

test('Invoice code resolution is deliberately global and projects redirect identifiers', async () => {
    await invoicesQueries.getInvoiceByCode('I7b2Q');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('i.id, i.company_id, i.public_code, i.invoice_number');
    expect(sql).toContain('WHERE i.public_code = $1');
    expect(sql).not.toContain('company_id = $2');
    expect(params).toEqual(['I7b2Q']);
});

test('migration adds both durable-code triggers and never rewrites issued document numbers', () => {
    expect(migration).toContain('current_setting(\'app.job_code_feistel_key\')::BIGINT');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION estimates_assign_public_code()');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION invoices_assign_public_code()');
    expect(migration).toContain("SET public_token_expires_at = NOW() + INTERVAL '18 months'");
    expect(migration).not.toMatch(/SET\s+estimate_number\s*=/i);
    expect(migration).not.toMatch(/SET\s+invoice_number\s*=/i);
});
