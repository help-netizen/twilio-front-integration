'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const registry = require('../backend/src/services/nativeVoiceRegistration');

const MIGRATION = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/232_native_voice_push.sql'),
    'utf8'
);

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
    return { ready: result.status === 0, reason: String(result.stderr || result.error?.message || '').trim() };
}

const DATABASE = probeDatabase();
const databaseTest = DATABASE.ready ? test : test.skip;
if (!DATABASE.ready) {
    test('SOFTPHONE-NATIVE-001 DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`Native Voice registry DB tests are pending: ${DATABASE.reason}`);
    });
}

jest.setTimeout(30000);

describe('native Voice registration real PostgreSQL isolation', () => {
    databaseTest('T-own/T-foreign/T-blast: CRUD and active lookup preserve the other tenant byte-for-byte', async () => {
        const client = await db.pool.connect();
        const originalQuery = db.query;
        const schema = `native_voice_${randomUUID().replaceAll('-', '')}`;
        const companyA = randomUUID();
        const companyB = randomUUID();
        const sharedUser = randomUUID();
        try {
            await client.query('BEGIN');
            await client.query(`CREATE SCHEMA "${schema}"`);
            await client.query(`SET LOCAL search_path TO "${schema}", public`);
            await client.query(`
                CREATE TABLE companies (id UUID PRIMARY KEY);
                CREATE TABLE crm_users (id UUID PRIMARY KEY);
                CREATE TABLE company_memberships (
                    user_id UUID NOT NULL REFERENCES crm_users(id) ON DELETE CASCADE,
                    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                    UNIQUE (user_id, company_id)
                );
                CREATE TABLE company_telephony (
                    company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            `);
            await client.query(MIGRATION);
            await client.query('INSERT INTO companies (id) VALUES ($1), ($2)', [companyA, companyB]);
            await client.query('INSERT INTO crm_users (id) VALUES ($1)', [sharedUser]);
            await client.query(
                `INSERT INTO company_memberships (user_id, company_id)
                 VALUES ($1, $2), ($1, $3)`,
                [sharedUser, companyA, companyB]
            );
            db.query = (text, params) => client.query(text, params);

            await expect(registry.upsertNativeRegistration(sharedUser, companyA))
                .resolves.toMatchObject({ inserted: true });
            await expect(registry.upsertNativeRegistration(sharedUser, companyA))
                .resolves.toMatchObject({ inserted: false });
            await expect(registry.upsertNativeRegistration(sharedUser, companyB))
                .resolves.toMatchObject({ inserted: true });

            const foreignBefore = JSON.stringify((await client.query(
                `SELECT to_jsonb(r) AS snapshot
                 FROM native_voice_registrations r
                 WHERE company_id = $1 AND user_id = $2`,
                [companyB, sharedUser]
            )).rows[0].snapshot);

            await expect(registry.getActiveNativeUserIds([sharedUser], companyA))
                .resolves.toEqual(new Set([sharedUser]));
            await expect(registry.deleteNativeRegistration(sharedUser, companyA)).resolves.toBe(true);
            await expect(registry.getActiveNativeUserIds([sharedUser], companyA))
                .resolves.toEqual(new Set());
            await expect(registry.getActiveNativeUserIds([sharedUser], companyB))
                .resolves.toEqual(new Set([sharedUser]));

            const foreignAfter = JSON.stringify((await client.query(
                `SELECT to_jsonb(r) AS snapshot
                 FROM native_voice_registrations r
                 WHERE company_id = $1 AND user_id = $2`,
                [companyB, sharedUser]
            )).rows[0].snapshot);
            expect(foreignAfter).toBe(foreignBefore);

            await client.query(
                `UPDATE native_voice_registrations
                 SET updated_at = NOW() - INTERVAL '31 days', expires_at = NOW() - INTERVAL '1 day'
                 WHERE company_id = $1 AND user_id = $2`,
                [companyB, sharedUser]
            );
            await expect(registry.getActiveNativeUserIds([sharedUser], companyB))
                .resolves.toEqual(new Set());
        } finally {
            db.query = originalQuery;
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch { /* already closed */ }
});
