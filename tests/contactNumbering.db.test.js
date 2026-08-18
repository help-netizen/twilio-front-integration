'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

require('dotenv').config();

const contactsService = require('../backend/src/services/contactsService');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const FORWARD = fs.readFileSync(path.join(MIGRATIONS, '283_contact_numbering.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(MIGRATIONS, 'rollback_283_contact_numbering.sql'), 'utf8');
const DATABASE_URL = process.env.CONTACT_NUMBERING_TEST_DB_URL
    || process.env.DATABASE_URL
    || 'postgresql://localhost/twilio_calls';
const SCHEMA = `contact_numbering_${Date.now().toString(36)}_${process.pid}`;
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

beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await configure(client);
    await client.query(`
        CREATE TABLE contacts (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID NOT NULL,
            full_name TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    await client.query(
        `INSERT INTO contacts (company_id, full_name)
         VALUES ($1, 'A One'), ($1, 'A Two'), ($2, 'B One')`,
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

test('contact_public_code is a five-character base62 bijection using the jobs GUC key', async () => {
    const { rows } = await client.query(`
        SELECT COUNT(*)::INTEGER AS generated,
               COUNT(DISTINCT code)::INTEGER AS distinct_codes,
               BOOL_AND(code ~ '^[0-9A-Za-z]{5}$') AS all_base62
        FROM (
            SELECT contact_public_code(id) AS code
            FROM generate_series(1, 20000) AS ids(id)
        ) generated_codes
    `);

    expect(rows[0]).toEqual({
        generated: 20000,
        distinct_codes: 20000,
        all_base62: true,
    });
    await expect(client.query('SELECT contact_public_code(916132832)')).rejects.toThrow(
        /outside the 5-character public-code domain/
    );
});

test('the idempotent migration backfills a unique public_code for every existing Contact', async () => {
    const { rows } = await client.query(
        `SELECT id, company_id, public_code
         FROM contacts
         ORDER BY id`
    );

    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(row => row.public_code)).size).toBe(rows.length);
    expect(rows.every(row => /^[0-9A-Za-z]{5}$/.test(row.public_code))).toBe(true);
    expect(rows.every(row => row.id !== null)).toBe(true);
});

test('new Contacts receive globally unique codes while an explicit code is preserved', async () => {
    const generated = await client.query(
        `INSERT INTO contacts (company_id, full_name)
         VALUES ($1, 'A Three'), ($2, 'B Two')
         RETURNING id, company_id, public_code`,
        [COMPANY_A, COMPANY_B]
    );
    const manual = await client.query(
        `INSERT INTO contacts (company_id, full_name, public_code)
         VALUES ($1, 'Manual', 'Qw7Er')
         RETURNING id, public_code`,
        [COMPANY_A]
    );

    expect(generated.rows.every(row => /^[0-9A-Za-z]{5}$/.test(row.public_code))).toBe(true);
    expect(new Set(generated.rows.map(row => row.public_code)).size).toBe(2);
    expect(manual.rows[0].public_code).toBe('Qw7Er');
    await expect(client.query(
        `INSERT INTO contacts (company_id, full_name, public_code)
         VALUES ($1, 'Duplicate', 'Qw7Er')`,
        [COMPANY_B]
    )).rejects.toMatchObject({ code: '23505' });
});

test('getContactByCode globally resolves the stored Contact DTO with id and public_code', async () => {
    const source = (await client.query(
        `SELECT id, public_code
         FROM contacts
         WHERE company_id = $1
         ORDER BY id
         LIMIT 1`,
        [COMPANY_A]
    )).rows[0];

    await expect(contactsService.getContactByCode(source.public_code, { client }))
        .resolves.toMatchObject({
            id: source.id,
            public_code: source.public_code,
            company_id: COMPANY_A,
        });
});
