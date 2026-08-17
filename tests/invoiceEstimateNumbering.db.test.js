'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

require('dotenv').config();

const estimatesQueries = require('../backend/src/db/estimatesQueries');
const invoicesQueries = require('../backend/src/db/invoicesQueries');
const estimatesService = require('../backend/src/services/estimatesService');
const invoicesService = require('../backend/src/services/invoicesService');
const estimatesRouter = require('../backend/src/routes/estimates');
const invoicesRouter = require('../backend/src/routes/invoices');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const FORWARD = fs.readFileSync(
    path.join(MIGRATIONS, '282_invoice_estimate_numbering.sql'),
    'utf8'
);
const ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_282_invoice_estimate_numbering.sql'),
    'utf8'
);
const DATABASE_URL = process.env.INVOICE_ESTIMATE_NUMBERING_TEST_DB_URL
    || process.env.DATABASE_URL
    || 'postgresql://localhost/twilio_calls';
const SCHEMA = `invoice_estimate_numbering_${Date.now().toString(36)}_${process.pid}`;
const FEISTEL_KEY = '987654321';
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();

jest.setTimeout(30000);

let pool;
let client;

async function configure(connection) {
    await connection.query(`SET search_path TO ${SCHEMA}, public`);
    await connection.query(`SET app.job_code_feistel_key = '${FEISTEL_KEY}'`);
}

async function invokeForeignCodeRoute(router, code, companyId) {
    const layer = router.stack.find(candidate => (
        candidate.route?.path === '/by-code/:code' && candidate.route.methods.get
    ));
    const req = {
        method: 'GET',
        originalUrl: `/by-code/${code}`,
        params: { code },
        user: { crmUser: { id: randomUUID() } },
        authz: { permissions: ['estimates.view', 'invoices.view'] },
        companyFilter: { company_id: companyId },
    };
    const res = {
        statusCode: 200,
        body: undefined,
        status(statusCode) {
            this.statusCode = statusCode;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
    const handlers = layer.route.stack.map(candidate => candidate.handle);
    async function dispatch(index) {
        if (index >= handlers.length) return;
        let nextPromise = null;
        const next = (error) => {
            if (error) throw error;
            nextPromise = dispatch(index + 1);
            return nextPromise;
        };
        await handlers[index](req, res, next);
        if (nextPromise) await nextPromise;
    }
    await dispatch(0);
    return res;
}

beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await configure(client);
    await client.query(`
        CREATE TABLE estimates (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID NOT NULL,
            estimate_number VARCHAR(50) NOT NULL,
            estimate_sequence INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'draft',
            lead_id BIGINT,
            job_id BIGINT,
            public_token TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(company_id, estimate_number)
        );
        CREATE TABLE invoices (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID NOT NULL,
            invoice_number VARCHAR(50) NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            lead_id BIGINT,
            job_id BIGINT,
            estimate_id BIGINT,
            public_token TEXT,
            total NUMERIC(12,2) NOT NULL DEFAULT 0,
            amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
            balance_due NUMERIC(12,2) NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(company_id, invoice_number)
        );
        CREATE TABLE jobs (
            id BIGINT PRIMARY KEY,
            company_id UUID NOT NULL,
            contact_id BIGINT,
            job_number TEXT,
            customer_name TEXT,
            customer_email TEXT,
            customer_phone TEXT
        );
        CREATE TABLE contacts (
            id BIGINT PRIMARY KEY,
            company_id UUID NOT NULL,
            full_name TEXT,
            email TEXT,
            phone_e164 TEXT
        );
        CREATE TABLE leads (
            id BIGINT PRIMARY KEY,
            company_id UUID NOT NULL,
            serial_id BIGINT
        );
    `);
    await client.query(
        `INSERT INTO estimates (
            company_id, estimate_number, estimate_sequence, job_id
         ) VALUES ($1, 'ESTIMATE L-900-3', 3, 101),
                  ($2, 'ESTIMATE L-900-8', 8, 202);
         INSERT INTO invoices (
            company_id, invoice_number, status, job_id, public_token
         ) VALUES ($1, 'INVOICE J-101-3', 'draft', 101, NULL),
                  ($1, 'INVOICE LEGACY-LIVE-1', 'sent', NULL, 'live-token'),
                  ($2, 'INVOICE J-101-9', 'draft', 101, NULL)`,
        [COMPANY_A, COMPANY_B]
    );

    await client.query(FORWARD);
    await client.query(FORWARD);
});

afterAll(async () => {
    if (client) {
        try {
            await configure(client);
            await client.query(ROLLBACK);
        } finally {
            await client.query('RESET search_path').catch(() => {});
            await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
            client.release();
        }
    }
    if (pool) await pool.end();
});

test('public-code functions are five-character base62 bijections for both document types', async () => {
    const { rows } = await client.query(`
        SELECT COUNT(DISTINCT estimate_public_code(id))::INTEGER AS estimate_codes,
               COUNT(DISTINCT invoice_public_code(id))::INTEGER AS invoice_codes,
               BOOL_AND(estimate_public_code(id) ~ '^[0-9A-Za-z]{5}$') AS estimates_base62,
               BOOL_AND(invoice_public_code(id) ~ '^[0-9A-Za-z]{5}$') AS invoices_base62
        FROM generate_series(1, 20000) ids(id)
    `);

    expect(rows[0]).toEqual({
        estimate_codes: 20000,
        invoice_codes: 20000,
        estimates_base62: true,
        invoices_base62: true,
    });
});

test('backfill and insert triggers assign unique stored codes without rewriting issued numbers', async () => {
    const before = await client.query(
        `SELECT estimate_number FROM estimates WHERE company_id = $1 ORDER BY id`,
        [COMPANY_A]
    );
    const insertedEstimate = await client.query(
        `INSERT INTO estimates (company_id, estimate_number, estimate_sequence)
         VALUES ($1, 'ESTIMATE L31-4', 4)
         RETURNING public_code`,
        [COMPANY_A]
    );
    const insertedInvoice = await client.query(
        `INSERT INTO invoices (company_id, invoice_number)
         VALUES ($1, 'INVOICE L31-4')
         RETURNING public_code`,
        [COMPANY_A]
    );
    const after = await client.query(
        `SELECT estimate_number FROM estimates WHERE company_id = $1 AND job_id = 101`,
        [COMPANY_A]
    );

    expect(insertedEstimate.rows[0].public_code).toMatch(/^[0-9A-Za-z]{5}$/);
    expect(insertedInvoice.rows[0].public_code).toMatch(/^[0-9A-Za-z]{5}$/);
    expect(after.rows[0].estimate_number).toBe(before.rows[0].estimate_number);
    const counts = await client.query(`
        SELECT
          (SELECT COUNT(*) = COUNT(DISTINCT public_code) FROM estimates) AS unique_estimates,
          (SELECT COUNT(*) = COUNT(DISTINCT public_code) FROM invoices) AS unique_invoices
    `);
    expect(counts.rows[0]).toEqual({ unique_estimates: true, unique_invoices: true });
});

test('new-format sequences continue from the matching parent legacy MAX and copied invoices reserve suffixes', async () => {
    await expect(estimatesQueries.nextEstimateSequence(COMPANY_A, {
        jobSeq: 7,
        legacyLeadSerialId: 900,
        jobId: 101,
    }, client)).resolves.toBe(4);
    await expect(invoicesQueries.nextInvoiceSequence(COMPANY_A, {
        jobSeq: 7,
        legacyJobId: 101,
        jobId: 101,
    }, client)).resolves.toBe(4);

    await client.query(
        `INSERT INTO invoices (company_id, invoice_number, job_id, estimate_id)
         VALUES ($1, 'INVOICE 7-4', 101, 1)`,
        [COMPANY_A]
    );
    await expect(invoicesQueries.nextInvoiceSequence(COMPANY_A, {
        jobSeq: 7,
        legacyJobId: 101,
        jobId: 101,
    }, client)).resolves.toBe(5);
});

test('global code resolvers return identifiers, while both routes hide a foreign tenant', async () => {
    const estimateSource = (await client.query(
        `SELECT id, public_code FROM estimates WHERE company_id = $1 ORDER BY id LIMIT 1`,
        [COMPANY_A]
    )).rows[0];
    const invoiceSource = (await client.query(
        `SELECT id, public_code FROM invoices WHERE company_id = $1 ORDER BY id LIMIT 1`,
        [COMPANY_A]
    )).rows[0];
    const estimate = await estimatesService.getEstimateByCode(
        estimateSource.public_code,
        { client }
    );
    const invoice = await invoicesService.getInvoiceByCode(
        invoiceSource.public_code,
        { client }
    );

    expect(estimate).toMatchObject({
        id: estimateSource.id,
        company_id: COMPANY_A,
        public_code: estimateSource.public_code,
    });
    expect(invoice).toMatchObject({
        id: invoiceSource.id,
        company_id: COMPANY_A,
        public_code: invoiceSource.public_code,
    });

    const estimateResolver = jest.spyOn(estimatesService, 'getEstimateByCode')
        .mockResolvedValueOnce(estimate);
    const invoiceResolver = jest.spyOn(invoicesService, 'getInvoiceByCode')
        .mockResolvedValueOnce(invoice);
    try {
        await expect(invokeForeignCodeRoute(
            estimatesRouter,
            estimateSource.public_code,
            COMPANY_B
        )).resolves.toMatchObject({ statusCode: 404 });
        await expect(invokeForeignCodeRoute(
            invoicesRouter,
            invoiceSource.public_code,
            COMPANY_B
        )).resolves.toMatchObject({ statusCode: 404 });
    } finally {
        estimateResolver.mockRestore();
        invoiceResolver.mockRestore();
    }
});

test('invoice tokens are seeded live, then fail closed on expiry and non-public statuses', async () => {
    const seeded = await client.query(
        `SELECT public_token_expires_at > NOW() + INTERVAL '17 months' AS sufficiently_future
         FROM invoices WHERE public_token = 'live-token'`
    );
    expect(seeded.rows[0].sufficiently_future).toBe(true);
    await expect(invoicesQueries.getInvoiceByPublicToken('live-token', client))
        .resolves.toMatchObject({ status: 'sent' });

    await client.query(
        `UPDATE invoices SET public_token_expires_at = NOW() - INTERVAL '1 second'
         WHERE public_token = 'live-token'`
    );
    await expect(invoicesQueries.getInvoiceByPublicToken('live-token', client))
        .resolves.toBeNull();

    await client.query(
        `UPDATE invoices
         SET public_token_expires_at = NOW() + INTERVAL '18 months', status = 'draft'
         WHERE public_token = 'live-token'`
    );
    await expect(invoicesQueries.getInvoiceByPublicToken('live-token', client))
        .resolves.toBeNull();
});
