'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');

const migration = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/264_machine_credentials_and_vapi_org.sql'),
    'utf8'
);

jest.setTimeout(30000);

afterAll(async () => {
    await db.pool.end();
});

test('migration 264 is idempotent and enforces same-company Sales MCP actors', async () => {
    const client = await db.getClient();
    const companyA = randomUUID();
    const companyB = randomUUID();
    const userA = randomUUID();
    const userB = randomUUID();
    const suffix = randomUUID();
    try {
        await client.query('BEGIN');
        await expect(client.query(migration)).resolves.toBeDefined();
        await expect(client.query(migration)).resolves.toBeDefined();

        await client.query(
            `INSERT INTO companies (id, name, slug)
             VALUES ($1, 'Machine Credential A', $3),
                    ($2, 'Machine Credential B', $4)`,
            [companyA, companyB, `machine-a-${suffix}`, `machine-b-${suffix}`]
        );
        await client.query(
            `INSERT INTO crm_users (id, keycloak_sub, email, company_id)
             VALUES ($1, $3, 'actor-a@example.test', $5),
                    ($2, $4, 'actor-b@example.test', $6)`,
            [userA, userB, `machine-a-${suffix}`, `machine-b-${suffix}`, companyA, companyB]
        );
        await client.query(
            `INSERT INTO company_memberships (user_id, company_id, role, status)
             VALUES ($1, $3, 'company_member', 'active'),
                    ($2, $4, 'company_member', 'active')`,
            [userA, userB, companyA, companyB]
        );

        await expect(client.query(
            `INSERT INTO api_integrations
                (client_name, key_id, secret_hash, scopes, company_id, machine_surface, actor_user_id)
             VALUES ('sales-a', $1, $2, '["sales_mcp_public:access"]', $3,
                     'sales_mcp_public', $4)`,
            [`machine-key-a-${suffix}`, `hash-a-${suffix}`, companyA, userA]
        )).resolves.toBeDefined();

        await client.query('SAVEPOINT foreign_actor');
        await expect(client.query(
            `INSERT INTO api_integrations
                (client_name, key_id, secret_hash, scopes, company_id, machine_surface, actor_user_id)
             VALUES ('sales-cross', $1, $2, '["sales_mcp_public:access"]', $3,
                     'sales_mcp_public', $4)`,
            [`machine-key-cross-${suffix}`, `hash-cross-${suffix}`, companyA, userB]
        )).rejects.toMatchObject({ code: '23503' });
        await client.query('ROLLBACK TO SAVEPOINT foreign_actor');

        await client.query('SAVEPOINT missing_actor');
        await expect(client.query(
            `INSERT INTO api_integrations
                (client_name, key_id, secret_hash, scopes, company_id, machine_surface)
             VALUES ('sales-no-actor', $1, $2, '["sales_mcp_public:access"]', $3,
                     'sales_mcp_public')`,
            [`machine-key-no-actor-${suffix}`, `hash-no-actor-${suffix}`, companyA]
        )).rejects.toMatchObject({ code: '23514' });
        await client.query('ROLLBACK TO SAVEPOINT missing_actor');

        const columns = await client.query(
            `SELECT column_name
             FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'api_integrations'
               AND column_name = ANY($1::text[])`,
            [['machine_surface', 'actor_user_id']]
        );
        expect(columns.rows.map(row => row.column_name).sort()).toEqual([
            'actor_user_id',
            'machine_surface',
        ]);

        await client.query('ROLLBACK');
    } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
    }
});
