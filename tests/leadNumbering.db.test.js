'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

require('dotenv').config();

const leadsService = require('../backend/src/services/leadsService');
const leadsRouter = require('../backend/src/routes/leads');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const FORWARD = fs.readFileSync(path.join(MIGRATIONS, '279_lead_numbering.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(MIGRATIONS, 'rollback_279_lead_numbering.sql'), 'utf8');
const DATABASE_URL = process.env.LEAD_NUMBERING_TEST_DB_URL
    || process.env.DATABASE_URL
    || 'postgresql://localhost/twilio_calls';
const SCHEMA = `lead_numbering_${Date.now().toString(36)}_${process.pid}`;
const FEISTEL_KEY = '987654321';
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const COMPANY_C = randomUUID();
const COMPANY_D = randomUUID();
const COMPANY_E = randomUUID();

jest.setTimeout(30000);

let pool;
let client;

async function configure(connection) {
    await connection.query(`SET search_path TO ${SCHEMA}, public`);
    await connection.query(`SET app.job_code_feistel_key = '${FEISTEL_KEY}'`);
}

async function invokeCodeRoute(code, companyId) {
    const layer = leadsRouter.stack.find(candidate => (
        candidate.route?.path === '/by-code/:code' && candidate.route.methods.get
    ));
    const req = {
        method: 'GET',
        originalUrl: `/by-code/${code}`,
        params: { code },
        user: { sub: 'db-test', crmUser: { id: 1 } },
        authz: { permissions: ['leads.view'] },
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
        CREATE TABLE leads (
            id BIGSERIAL PRIMARY KEY,
            uuid VARCHAR(20) NOT NULL UNIQUE,
            serial_id SERIAL NOT NULL,
            company_id UUID,
            status TEXT NOT NULL DEFAULT 'Submitted',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE lead_team_assignments (
            id BIGSERIAL PRIMARY KEY,
            lead_id BIGINT NOT NULL,
            company_id UUID NOT NULL,
            user_name TEXT
        );
    `);
    await client.query(
        `INSERT INTO leads (uuid, company_id, created_at)
         VALUES
            ('A-LATE', $1, '2026-08-03T12:00:00Z'),
            ('A-EARLY', $1, '2026-08-01T12:00:00Z'),
            ('A-MIDDLE', $1, '2026-08-02T12:00:00Z'),
            ('B-LATE', $2, '2026-08-02T12:00:00Z'),
            ('B-EARLY', $2, '2026-08-01T12:00:00Z')`,
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

test('lead_public_code is a five-character base62 bijection using the jobs GUC key', async () => {
    const { rows } = await client.query(`
        SELECT COUNT(*)::INTEGER AS generated,
               COUNT(DISTINCT code)::INTEGER AS distinct_codes,
               BOOL_AND(code ~ '^[0-9A-Za-z]{5}$') AS all_base62
        FROM (
            SELECT lead_public_code(id) AS code
            FROM generate_series(1, 20000) AS ids(id)
        ) generated_codes
    `);

    expect(rows[0]).toEqual({
        generated: 20000,
        distinct_codes: 20000,
        all_base62: true,
    });
    await expect(client.query('SELECT lead_public_code(916132832)')).rejects.toThrow(
        /outside the 5-character public-code domain/
    );
});

test('backfill assigns clean per-company sequences, unique codes, and next counters', async () => {
    const { rows } = await client.query(
        `SELECT id, uuid, serial_id, company_id, lead_seq, public_code, created_at
         FROM leads
         WHERE company_id = ANY($1::uuid[])
         ORDER BY company_id, created_at, id`,
        [[COMPANY_A, COMPANY_B]]
    );
    const seqsFor = companyId => rows
        .filter(row => row.company_id === companyId)
        .map(row => row.lead_seq);

    expect(seqsFor(COMPANY_A)).toEqual([1, 2, 3]);
    expect(seqsFor(COMPANY_B)).toEqual([1, 2]);
    expect(new Set(rows.map(row => row.public_code)).size).toBe(rows.length);
    expect(rows.every(row => /^[0-9A-Za-z]{5}$/.test(row.public_code))).toBe(true);
    expect(rows.every(row => Number.isInteger(row.serial_id))).toBe(true);
    expect(rows.map(row => row.uuid).sort()).toEqual([
        'A-EARLY', 'A-LATE', 'A-MIDDLE', 'B-EARLY', 'B-LATE',
    ]);

    const counters = await client.query(
        `SELECT company_id, next_seq
         FROM company_lead_counters
         WHERE company_id = ANY($1::uuid[])
         ORDER BY company_id`,
        [[COMPANY_A, COMPANY_B]]
    );
    expect(Object.fromEntries(counters.rows.map(row => [row.company_id, row.next_seq]))).toEqual({
        [COMPANY_A]: 4,
        [COMPANY_B]: 3,
    });
});

test('new leads receive independent per-company sequences and global unique codes', async () => {
    const { rows } = await client.query(
        `INSERT INTO leads (uuid, company_id)
         VALUES
            ('C-1', $1), ('C-2', $1), ('C-3', $1),
            ('D-1', $2), ('D-2', $2), ('D-3', $2)
         RETURNING id, uuid, company_id, lead_seq, public_code, serial_id`,
        [COMPANY_C, COMPANY_D]
    );
    const seqsFor = companyId => rows
        .filter(row => row.company_id === companyId)
        .map(row => row.lead_seq);

    expect(seqsFor(COMPANY_C)).toEqual([1, 2, 3]);
    expect(seqsFor(COMPANY_D)).toEqual([1, 2, 3]);
    expect(new Set(rows.map(row => row.public_code)).size).toBe(rows.length);
    expect(rows.every(row => row.public_code.length === 5)).toBe(true);
    expect(rows.every(row => Number.isInteger(row.serial_id))).toBe(true);
});

test('concurrent creates in one company receive distinct lead_seq values', async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    try {
        await Promise.all([configure(first), configure(second)]);
        const inserts = await Promise.all([
            first.query(
                `INSERT INTO leads (uuid, company_id)
                 VALUES ('E-1', $1)
                 RETURNING lead_seq, public_code`,
                [COMPANY_E]
            ),
            second.query(
                `INSERT INTO leads (uuid, company_id)
                 VALUES ('E-2', $1)
                 RETURNING lead_seq, public_code`,
                [COMPANY_E]
            ),
        ]);
        expect(inserts.map(result => result.rows[0].lead_seq).sort((a, b) => a - b)).toEqual([1, 2]);
        expect(new Set(inserts.map(result => result.rows[0].public_code)).size).toBe(2);
    } finally {
        first.release();
        second.release();
    }
});

test('the trigger safely skips lead_seq when company_id is null without touching uuid', async () => {
    const { rows } = await client.query(
        `INSERT INTO leads (uuid, company_id)
         VALUES ('NO-COMPANY', NULL)
         RETURNING uuid, lead_seq, public_code`,
    );
    expect(rows[0]).toMatchObject({
        uuid: 'NO-COMPANY',
        lead_seq: null,
    });
    expect(rows[0].public_code).toMatch(/^[0-9A-Za-z]{5}$/);
});

test('getLeadBySeq resolves the same sequence independently per tenant', async () => {
    const companyALead = await leadsService.getLeadBySeq(1, COMPANY_A, { client });
    const companyBLead = await leadsService.getLeadBySeq(1, COMPANY_B, { client });

    expect(companyALead).toMatchObject({
        UUID: 'A-EARLY',
        LeadSeq: 1,
        company_id: COMPANY_A,
    });
    expect(companyBLead).toMatchObject({
        UUID: 'B-EARLY',
        LeadSeq: 1,
        company_id: COMPANY_B,
    });
    expect(companyALead.ClientId).not.toBe(companyBLead.ClientId);

    await expect(leadsService.getLeadBySeq(3, COMPANY_B, { client })).rejects.toMatchObject({
        code: 'LEAD_NOT_FOUND',
        httpStatus: 404,
    });
});

test('getLeadByCode globally resolves the stored DTO and identifiers', async () => {
    const source = (await client.query(
        `SELECT id, public_code
         FROM leads
         WHERE company_id = $1 AND lead_seq = 2`,
        [COMPANY_A]
    )).rows[0];

    await expect(leadsService.getLeadByCode(source.public_code, { client })).resolves.toMatchObject({
        ClientId: source.id,
        UUID: 'A-MIDDLE',
        SerialId: expect.any(Number),
        LeadSeq: 2,
        PublicCode: source.public_code,
        company_id: COMPANY_A,
    });
});

test('the by-code route returns 404 when the global resolver finds another tenant', async () => {
    const source = (await client.query(
        `SELECT public_code
         FROM leads
         WHERE company_id = $1 AND lead_seq = 1`,
        [COMPANY_A]
    )).rows[0];
    const resolvedLead = await leadsService.getLeadByCode(source.public_code, { client });
    const resolver = jest.spyOn(leadsService, 'getLeadByCode').mockResolvedValueOnce(resolvedLead);

    try {
        const response = await invokeCodeRoute(source.public_code, COMPANY_B);
        expect(response.statusCode).toBe(404);
        expect(response.body.error.code).toBe('LEAD_NOT_FOUND');
        expect(response.body.data).toBeUndefined();
    } finally {
        resolver.mockRestore();
    }
});
