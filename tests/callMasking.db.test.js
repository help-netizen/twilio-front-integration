'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const callMaskingService = require('../backend/src/services/callMaskingService');

const MIGRATION = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/204_call_masking.sql'),
    'utf8'
);

jest.setTimeout(60000);

function probeDatabase() {
    const probeEnv = { ...process.env };
    delete probeEnv.NODE_USE_SYSTEM_CA;
    const pgModule = require.resolve('pg');
    const script = `
        const { Client } = require(${JSON.stringify(pgModule)});
        const client = new Client({
            connectionString: process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls',
            connectionTimeoutMillis: 2000,
        });
        (async () => {
            try { await client.connect(); await client.query('SELECT 1'); await client.end(); process.exit(0); }
            catch (error) { process.stderr.write(String(error.message || error)); try { await client.end(); } catch {} process.exit(2); }
        })();`;
    const result = spawnSync(process.execPath, ['--use-bundled-ca', '-e', script], {
        env: probeEnv,
        encoding: 'utf8',
        timeout: 6000,
    });
    return {
        ready: result.status === 0,
        reason: String(result.stderr || result.error?.message || `probe exit ${result.status}`).trim(),
    };
}

const DATABASE = probeDatabase();
const databaseTest = DATABASE.ready ? test : test.skip;
if (!DATABASE.ready) {
    test('CALL-MASKING DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`CALL-MASKING DB tests are pending: ${DATABASE.reason}`);
    });
}

afterAll(async () => {
    try { await db.pool.end(); } catch (_) { /* already closed */ }
});

describe('CALL-MASKING real PostgreSQL code isolation', () => {
    databaseTest('stable allocation is collision-free per company and T-foreign/T-blast safe', async () => {
        const client = await db.pool.connect();
        const schema = `call_masking_${randomUUID().replaceAll('-', '')}`;
        const companyA = randomUUID();
        const companyB = randomUUID();
        try {
            await client.query('BEGIN');
            await client.query(`CREATE SCHEMA "${schema}"`);
            await client.query(`SET LOCAL search_path TO "${schema}", public`);
            await client.query(`
                CREATE TABLE companies (id UUID PRIMARY KEY);
                CREATE TABLE crm_users (id UUID PRIMARY KEY);
                CREATE TABLE contacts (
                    id BIGSERIAL PRIMARY KEY,
                    company_id UUID NOT NULL REFERENCES companies(id),
                    phone_e164 TEXT,
                    secondary_phone TEXT
                );
                CREATE TABLE company_telephony (
                    company_id UUID PRIMARY KEY REFERENCES companies(id),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                );
                CREATE TABLE phone_number_settings (
                    id BIGSERIAL PRIMARY KEY,
                    company_id UUID NOT NULL REFERENCES companies(id),
                    phone_number TEXT NOT NULL
                );
                CREATE TABLE company_user_profiles (
                    id UUID PRIMARY KEY,
                    phone TEXT
                );
                CREATE TABLE company_role_configs (
                    id UUID PRIMARY KEY,
                    company_id UUID NOT NULL REFERENCES companies(id),
                    role_key TEXT NOT NULL
                );
                CREATE TABLE company_role_permissions (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    role_config_id UUID NOT NULL REFERENCES company_role_configs(id),
                    permission_key TEXT NOT NULL,
                    is_allowed BOOLEAN NOT NULL,
                    UNIQUE (role_config_id, permission_key)
                );
            `);
            await client.query(MIGRATION);
            await client.query(
                `INSERT INTO companies (id) VALUES ($1), ($2)`,
                [companyA, companyB]
            );
            const contacts = await client.query(
                `INSERT INTO contacts (company_id, phone_e164)
                 VALUES
                    ($1, '+16175550123'),
                    ($1, '+16175550124'),
                    ($2, '+16175550123')
                 RETURNING id, company_id`,
                [companyA, companyB]
            );
            const aContacts = contacts.rows.filter(row => row.company_id === companyA);
            const bContact = contacts.rows.find(row => row.company_id === companyB);
            await client.query(
                `INSERT INTO company_telephony
                    (company_id, call_masking_enabled, call_masking_number)
                 VALUES
                    ($1, true, '+16174044425'),
                    ($2, true, '+16174044425')`,
                [companyA, companyB]
            );
            await client.query(
                `INSERT INTO phone_number_settings (company_id, phone_number)
                 VALUES ($1, '+16174044425'), ($2, '+16174044425')`,
                [companyA, companyB]
            );

            const beforeB = await client.query(
                `SELECT
                    (SELECT to_jsonb(ct.*) FROM company_telephony ct WHERE company_id = $1) AS settings,
                    (SELECT COALESCE(jsonb_agg(to_jsonb(code.*)), '[]'::jsonb)
                     FROM contact_call_masking_codes code WHERE company_id = $1) AS codes`,
                [companyB]
            );

            const disabled = await callMaskingService.saveSettings(
                companyA,
                {
                    call_masking_enabled: false,
                    call_masking_number: '+16174044425',
                },
                null,
                client
            );
            expect(disabled).toMatchObject({
                call_masking_enabled: false,
                call_masking_number: '+16174044425',
            });
            await expect(callMaskingService.getSettings(companyA, client)).resolves.toEqual(disabled);

            await callMaskingService.saveSettings(
                companyA,
                {
                    call_masking_enabled: true,
                    call_masking_number: '+16174044425',
                },
                null,
                client
            );

            const aFirst = await callMaskingService.getMaskedDialForContact(
                companyA, aContacts[0].id, { assignedOnly: false }, client
            );
            const aStable = await callMaskingService.getMaskedDialForContact(
                companyA, aContacts[0].id, { assignedOnly: false }, client
            );
            const aSecond = await callMaskingService.getMaskedDialForContact(
                companyA, aContacts[1].id, { assignedOnly: false }, client
            );

            expect(aFirst.code).toBe('000001');
            expect(aStable.code).toBe('000001');
            expect(aSecond.code).toBe('000002');
            expect(new Set([aFirst.code, aSecond.code]).size).toBe(2);

            const afterB = await client.query(
                `SELECT
                    (SELECT to_jsonb(ct.*) FROM company_telephony ct WHERE company_id = $1) AS settings,
                    (SELECT COALESCE(jsonb_agg(to_jsonb(code.*)), '[]'::jsonb)
                     FROM contact_call_masking_codes code WHERE company_id = $1) AS codes`,
                [companyB]
            );
            expect(afterB.rows[0]).toStrictEqual(beforeB.rows[0]);

            await expect(callMaskingService.getMaskedDialForContact(
                companyA, bContact.id, { assignedOnly: false }, client
            )).resolves.toBeNull();

            const bFirst = await callMaskingService.getMaskedDialForContact(
                companyB, bContact.id, { assignedOnly: false }, client
            );
            expect(bFirst.code).toBe('000001');

            await expect(client.query(
                `UPDATE contact_call_masking_codes
                 SET code = 1
                 WHERE company_id = $1 AND contact_id = $2`,
                [companyA, aContacts[1].id]
            )).rejects.toMatchObject({ code: '23505' });
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});
