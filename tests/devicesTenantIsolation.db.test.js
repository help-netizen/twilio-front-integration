'use strict';

const { randomUUID } = require('crypto');
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('../backend/src/db/connection');

const migration = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '221_notification_security_core.sql'),
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

    test('T-blast: a shared APNs token registration cannot rebind another tenant/user row', async () => {
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
            expect(afterA.rows[0].snapshot).toStrictEqual(beforeA.rows[0].snapshot);

            const bothOwners = await db.query(
                `SELECT company_id, crm_user_id, app_version
                 FROM device_tokens
                 WHERE apns_token = $1
                 ORDER BY company_id`,
                [sharedToken]
            );
            expect(bothOwners.rows).toEqual(expect.arrayContaining([
                { company_id: companyA, crm_user_id: userA, app_version: 'tenant-a-version' },
                { company_id: companyB, crm_user_id: userB, app_version: 'tenant-b-version' },
            ]));
            expect(bothOwners.rows).toHaveLength(2);
        } finally {
            await db.query('DELETE FROM device_tokens WHERE apns_token = $1', [sharedToken]);
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch { /* already closed */ }
});
