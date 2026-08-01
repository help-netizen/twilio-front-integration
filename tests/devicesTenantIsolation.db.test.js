'use strict';

const { randomUUID } = require('crypto');
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('../backend/src/db/connection');
const { sendNativePushToUser } = require('../backend/src/services/pushService');

const migration = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '225_notification_security_core.sql'),
    'utf8'
);

jest.setTimeout(60000);

function makeApp(companyId, userId) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.authz = { company: { id: companyId } };
        req.companyFilter = { company_id: companyId };
        req.user = { crmUser: { id: userId } };
        next();
    });
    app.use('/', require('../backend/src/routes/devices'));
    return app;
}

function postDevice(app, body) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            const request = http.request(
                {
                    hostname: '127.0.0.1',
                    port,
                    path: '/',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                },
                response => {
                    let data = '';
                    response.on('data', chunk => { data += chunk; });
                    response.on('end', () => {
                        server.close();
                        resolve({ status: response.statusCode, body: JSON.parse(data) });
                    });
                }
            );
            request.on('error', error => { server.close(); reject(error); });
            request.end(JSON.stringify(body));
        });
        server.on('error', reject);
    });
}

describe('native device registration real PostgreSQL isolation', () => {
    beforeAll(async () => {
        await db.query(migration);
    });

    test('T-blast: the latest APNs registration removes the stale owner and only the new owner is targetable', async () => {
        const companyA = randomUUID();
        const companyB = randomUUID();
        const userA = randomUUID();
        const userB = randomUUID();
        const sharedToken = `shared-apns-${randomUUID()}`;

        try {
            const index = await db.query(
                `SELECT to_regclass('uq_device_tokens_company_user_apns_token') AS name`
            );
            expect(index.rows[0].name).toBe('uq_device_tokens_company_user_apns_token');
            const globalConstraint = await db.query(
                `SELECT conname
                 FROM pg_constraint
                 WHERE conrelid = 'device_tokens'::regclass
                   AND conname = 'device_tokens_apns_token_key'`
            );
            expect(globalConstraint.rows).toHaveLength(1);

            await expect(postDevice(makeApp(companyA, userA), {
                apns_token: sharedToken,
                app_version: 'tenant-a-version',
            })).resolves.toMatchObject({ status: 201, body: { ok: true } });

            const beforeA = await db.query(
                `SELECT to_jsonb(d) AS snapshot
                 FROM device_tokens d
                 WHERE company_id = $1 AND crm_user_id = $2 AND apns_token = $3`,
                [companyA, userA, sharedToken]
            );
            expect(beforeA.rows).toHaveLength(1);
            const staleDestinationId = beforeA.rows[0].snapshot.id;

            await expect(postDevice(makeApp(companyB, userB), {
                apns_token: sharedToken,
                app_version: 'tenant-b-version',
            })).resolves.toMatchObject({ status: 201, body: { ok: true } });

            const afterA = await db.query(
                `SELECT to_jsonb(d) AS snapshot
                 FROM device_tokens d
                 WHERE company_id = $1 AND crm_user_id = $2 AND apns_token = $3`,
                [companyA, userA, sharedToken]
            );
            expect(afterA.rows).toHaveLength(0);

            const currentOwner = await db.query(
                `SELECT id, company_id, crm_user_id, app_version
                 FROM device_tokens
                 WHERE apns_token = $1`,
                [sharedToken]
            );
            expect(currentOwner.rows).toHaveLength(1);
            expect(currentOwner.rows[0]).toMatchObject({
                company_id: companyB,
                crm_user_id: userB,
                app_version: 'tenant-b-version',
            });

            const apnsEnvKeys = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID', 'APNS_PRIVATE_KEY'];
            const savedEnv = Object.fromEntries(apnsEnvKeys.map(key => [key, process.env[key]]));
            try {
                for (const key of apnsEnvKeys) delete process.env[key];
                await expect(sendNativePushToUser(
                    companyA,
                    userA,
                    { title: 'Generic update', body: 'Open Albusto.' },
                    { destinationIds: [String(staleDestinationId)] }
                )).resolves.toMatchObject({ targeted: 0, sent: 0 });
                await expect(sendNativePushToUser(
                    companyB,
                    userB,
                    { title: 'Generic update', body: 'Open Albusto.' },
                    { destinationIds: [String(currentOwner.rows[0].id)] }
                )).resolves.toMatchObject({
                    targeted: 1,
                    error_code: 'APNS_NOT_CONFIGURED',
                });
            } finally {
                for (const key of apnsEnvKeys) {
                    if (savedEnv[key] === undefined) delete process.env[key];
                    else process.env[key] = savedEnv[key];
                }
            }
        } finally {
            await db.query('DELETE FROM device_tokens WHERE apns_token = $1', [sharedToken]);
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch { /* already closed */ }
});
