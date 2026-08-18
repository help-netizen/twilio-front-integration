'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

require('dotenv').config();

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const FORWARD = fs.readFileSync(path.join(MIGRATIONS, '284_timeline_numbering.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(MIGRATIONS, 'rollback_284_timeline_numbering.sql'), 'utf8');
const DATABASE_URL = process.env.TIMELINE_NUMBERING_TEST_DB_URL
    || process.env.DATABASE_URL
    || 'postgresql://localhost/twilio_calls';
const SCHEMA = `timeline_numbering_${Date.now().toString(36)}_${process.pid}`;
const FEISTEL_KEY = '987654321';
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();

jest.setTimeout(30000);

let pool;
let client;
let referencedTimelineId;

async function configure(connection) {
    await connection.query(`SET search_path TO ${SCHEMA}, public`);
    await connection.query(`SET app.job_code_feistel_key = '${FEISTEL_KEY}'`);
}

beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await configure(client);
    await client.query(`
        CREATE TABLE timelines (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE calls (
            id BIGSERIAL PRIMARY KEY,
            timeline_id BIGINT REFERENCES timelines(id)
        );
    `);
    const seeded = await client.query(
        `INSERT INTO timelines (company_id)
         VALUES ($1), ($1), ($2)
         RETURNING id`,
        [COMPANY_A, COMPANY_B]
    );
    referencedTimelineId = seeded.rows[0].id;
    await client.query(
        'INSERT INTO calls (timeline_id) VALUES ($1)',
        [referencedTimelineId]
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

test('timeline_public_code is a five-character base62 bijection using the jobs GUC key', async () => {
    const { rows } = await client.query(`
        SELECT COUNT(*)::INTEGER AS generated,
               COUNT(DISTINCT code)::INTEGER AS distinct_codes,
               BOOL_AND(code ~ '^[0-9A-Za-z]{5}$') AS all_base62
        FROM (
            SELECT timeline_public_code(id) AS code
            FROM generate_series(1, 20000) AS ids(id)
        ) generated_codes
    `);

    expect(rows[0]).toEqual({
        generated: 20000,
        distinct_codes: 20000,
        all_base62: true,
    });
    await expect(client.query('SELECT timeline_public_code(916132832)')).rejects.toThrow(
        /outside the 5-character public-code domain/
    );
});

test('the idempotent migration backfills a unique public_code for every existing Timeline', async () => {
    const { rows } = await client.query(
        `SELECT id, company_id, public_code
         FROM timelines
         ORDER BY id`
    );

    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(row => row.public_code)).size).toBe(rows.length);
    expect(rows.every(row => /^[0-9A-Za-z]{5}$/.test(row.public_code))).toBe(true);
});

test('new Timelines receive globally unique codes while an explicit code is preserved', async () => {
    const generated = await client.query(
        `INSERT INTO timelines (company_id)
         VALUES ($1), ($2)
         RETURNING id, company_id, public_code`,
        [COMPANY_A, COMPANY_B]
    );
    const manual = await client.query(
        `INSERT INTO timelines (company_id, public_code)
         VALUES ($1, 'Qw7Er')
         RETURNING id, public_code`,
        [COMPANY_A]
    );

    expect(generated.rows.every(row => /^[0-9A-Za-z]{5}$/.test(row.public_code))).toBe(true);
    expect(new Set(generated.rows.map(row => row.public_code)).size).toBe(2);
    expect(manual.rows[0].public_code).toBe('Qw7Er');
    await expect(client.query(
        `INSERT INTO timelines (company_id, public_code)
         VALUES ($1, 'Qw7Er')`,
        [COMPANY_B]
    )).rejects.toMatchObject({ code: '23505' });
});

test('timelines.id and calls.timeline_id remain BIGINT with the existing FK intact', async () => {
    const columns = await client.query(
        `SELECT table_name, column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = $1
           AND (table_name, column_name) IN (('timelines', 'id'), ('calls', 'timeline_id'))
         ORDER BY table_name`,
        [SCHEMA]
    );
    const fk = await client.query(
        `SELECT pg_get_constraintdef(constraint_row.oid) AS definition
         FROM pg_constraint constraint_row
         JOIN pg_class relation ON relation.oid = constraint_row.conrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = $1
           AND relation.relname = 'calls'
           AND constraint_row.contype = 'f'`,
        [SCHEMA]
    );
    const call = await client.query('SELECT timeline_id FROM calls');

    expect(columns.rows).toEqual([
        { table_name: 'calls', column_name: 'timeline_id', data_type: 'bigint' },
        { table_name: 'timelines', column_name: 'id', data_type: 'bigint' },
    ]);
    expect(fk.rows.map(row => row.definition)).toContain(
        'FOREIGN KEY (timeline_id) REFERENCES timelines(id)'
    );
    expect(call.rows).toEqual([{ timeline_id: referencedTimelineId }]);
});
