'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

require('dotenv').config();

const jobsService = require('../backend/src/services/jobsService');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const FORWARD = fs.readFileSync(path.join(MIGRATIONS, '271_job_numbering.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(MIGRATIONS, 'rollback_271_job_numbering.sql'), 'utf8');
const DATABASE_URL = process.env.JOB_NUMBERING_TEST_DB_URL
    || process.env.DATABASE_URL
    || 'postgresql://localhost/twilio_calls';
const SCHEMA = `job_numbering_${Date.now().toString(36)}_${process.pid}`;
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const COMPANY_C = randomUUID();
const COMPANY_D = randomUUID();
const COMPANY_E = randomUUID();

jest.setTimeout(30000);

let pool;
let client;

beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}, public`);
    await client.query(`
        CREATE TABLE leads (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID,
            serial_id BIGINT
        );
        CREATE TABLE contacts (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID,
            full_name TEXT,
            phone_e164 TEXT,
            email TEXT
        );
        CREATE TABLE jobs (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID,
            lead_id BIGINT,
            contact_id BIGINT,
            job_number TEXT,
            customer_name TEXT,
            customer_phone TEXT,
            customer_email TEXT,
            assigned_provider_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE job_tags (
            id BIGSERIAL PRIMARY KEY,
            name TEXT,
            color TEXT,
            is_active BOOLEAN,
            sort_order INTEGER
        );
        CREATE TABLE job_tag_assignments (job_id BIGINT, tag_id BIGINT);
    `);
    await client.query(
        `INSERT INTO jobs (company_id, created_at)
         VALUES
            ($1, '2026-08-03T12:00:00Z'),
            ($1, '2026-08-01T12:00:00Z'),
            ($1, '2026-08-02T12:00:00Z'),
            ($2, '2026-08-02T12:00:00Z'),
            ($2, '2026-08-01T12:00:00Z')`,
        [COMPANY_A, COMPANY_B]
    );

    await client.query(FORWARD);
    await client.query(FORWARD);
});

afterAll(async () => {
    if (client) {
        try {
            await client.query('ROLLBACK').catch(() => {});
            await client.query(`SET search_path TO ${SCHEMA}, public`);
            await client.query(ROLLBACK);
        } finally {
            await client.query('RESET search_path').catch(() => {});
            await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
            client.release();
        }
    }
    if (pool) await pool.end();
});

test('job_public_code is a five-character base62 bijection across ids 1..20000', async () => {
    const { rows } = await client.query(`
        SELECT COUNT(*)::INTEGER AS generated,
               COUNT(DISTINCT code)::INTEGER AS distinct_codes,
               BOOL_AND(code ~ '^[0-9A-Za-z]{5}$') AS all_base62
        FROM (
            SELECT job_public_code(id) AS code
            FROM generate_series(1, 20000) AS ids(id)
        ) generated_codes
    `);

    expect(rows[0]).toEqual({
        generated: 20000,
        distinct_codes: 20000,
        all_base62: true,
    });
    await expect(client.query('SELECT job_public_code(916132832)')).rejects.toThrow(
        /outside the 5-character public-code domain/
    );
});

test('backfill assigns clean 1..N by created_at and seeds next_seq to max + 1', async () => {
    const { rows } = await client.query(
        `SELECT company_id, job_seq, public_code
         FROM jobs
         WHERE company_id = ANY($1::uuid[])
         ORDER BY company_id, created_at, id`,
        [[COMPANY_A, COMPANY_B]]
    );
    const seqsFor = companyId => rows
        .filter(row => row.company_id === companyId)
        .map(row => row.job_seq);

    expect(seqsFor(COMPANY_A)).toEqual([1, 2, 3]);
    expect(seqsFor(COMPANY_B)).toEqual([1, 2]);
    expect(rows.every(row => /^[0-9A-Za-z]{5}$/.test(row.public_code))).toBe(true);

    const counters = await client.query(
        `SELECT company_id, next_seq
         FROM company_job_counters
         WHERE company_id = ANY($1::uuid[])
         ORDER BY company_id`,
        [[COMPANY_A, COMPANY_B]]
    );
    expect(Object.fromEntries(counters.rows.map(row => [row.company_id, row.next_seq]))).toEqual({
        [COMPANY_A]: 4,
        [COMPANY_B]: 3,
    });
});

test('job_seq starts at 1 and increments independently for each new company', async () => {
    const { rows } = await client.query(
        `INSERT INTO jobs (company_id)
         VALUES ($1), ($1), ($1), ($2), ($2), ($2)
         RETURNING company_id, job_seq`,
        [COMPANY_C, COMPANY_D]
    );
    const seqsFor = companyId => rows
        .filter(row => row.company_id === companyId)
        .map(row => row.job_seq);

    expect(seqsFor(COMPANY_C)).toEqual([1, 2, 3]);
    expect(seqsFor(COMPANY_D)).toEqual([1, 2, 3]);
});

test('concurrent inserts in one company receive distinct sequences', async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    try {
        await Promise.all([
            first.query(`SET search_path TO ${SCHEMA}, public`),
            second.query(`SET search_path TO ${SCHEMA}, public`),
        ]);
        const inserts = await Promise.all([
            first.query('INSERT INTO jobs (company_id) VALUES ($1) RETURNING job_seq', [COMPANY_E]),
            second.query('INSERT INTO jobs (company_id) VALUES ($1) RETURNING job_seq', [COMPANY_E]),
        ]);
        expect(inserts.map(result => result.rows[0].job_seq).sort((a, b) => a - b)).toEqual([1, 2]);
    } finally {
        first.release();
        second.release();
    }
});

test('getJobBySeq is tenant-scoped while getJobByCode resolves globally', async () => {
    const ownRow = (await client.query(
        `SELECT id, job_seq, public_code
         FROM jobs
         WHERE company_id = $1 AND job_seq = 3`,
        [COMPANY_A]
    )).rows[0];

    await expect(jobsService.getJobBySeq(
        COMPANY_A,
        ownRow.job_seq,
        null,
        { client }
    )).resolves.toMatchObject({
        id: ownRow.id,
        company_id: COMPANY_A,
        job_seq: 3,
        public_code: ownRow.public_code,
    });
    await expect(jobsService.getJobBySeq(
        COMPANY_B,
        ownRow.job_seq,
        null,
        { client }
    )).resolves.toBeNull();
    await expect(jobsService.getJobByCode(
        ownRow.public_code,
        { client }
    )).resolves.toMatchObject({
        id: ownRow.id,
        company_id: COMPANY_A,
        job_seq: 3,
        public_code: ownRow.public_code,
    });
});
