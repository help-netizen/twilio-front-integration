'use strict';

const { randomUUID } = require('crypto');

jest.mock('../backend/src/services/zenbookerSyncService', () => ({
    FEATURE_ENABLED: false,
    handleWebhookPayload: jest.fn(),
}));
jest.mock('../backend/src/services/zenbookerActivityService', () => ({
    logZenbookerEntity: jest.fn(),
}));
jest.mock('../backend/src/services/zenbookerClient', () => ({
    getClientForCompany: jest.fn(),
}));
jest.mock('../backend/src/middleware/keycloakAuth', () => ({
    authenticate: (_req, _res, next) => next(),
    requireCompanyAccess: (_req, _res, next) => next(),
}));

const db = require('../backend/src/db/connection');
const { processWebhookPayload } = require('../backend/src/routes/integrations-zenbooker');

jest.setTimeout(60000);

describe('Zenbooker webhook writes against migration-226 inbox keys', () => {
    test('same event key inserts once per resolved company and absent company fails closed', async () => {
        const client = await db.pool.connect();
        const schema = `zenbooker_inbox_${randomUUID().replaceAll('-', '')}`;
        const companyA = randomUUID();
        const companyB = randomUUID();
        let querySpy;

        try {
            await client.query(`CREATE SCHEMA "${schema}"`);
            await client.query(`SET search_path TO "${schema}"`);
            await client.query(`
                CREATE TABLE webhook_inbox (
                    id BIGSERIAL PRIMARY KEY,
                    provider TEXT NOT NULL,
                    event_key TEXT NOT NULL,
                    source TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    call_sid TEXT,
                    payload JSONB NOT NULL,
                    headers JSONB NOT NULL,
                    company_id UUID NOT NULL,
                    status TEXT NOT NULL DEFAULT 'received',
                    processed_at TIMESTAMPTZ,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    error_text TEXT,
                    UNIQUE (company_id, event_key)
                )
            `);
            querySpy = jest.spyOn(db, 'query').mockImplementation(
                (text, params) => client.query(text, params)
            );

            const payload = { event: 'system.ping', data: { id: 'shared' } };
            await processWebhookPayload('same-request', payload, {}, companyA);
            await processWebhookPayload('same-request', payload, {}, companyB);

            const inserted = await client.query(
                `SELECT company_id, event_key, payload
                 FROM webhook_inbox
                 ORDER BY company_id`
            );
            expect(inserted.rows).toHaveLength(2);
            expect(inserted.rows.map(row => row.company_id)).toEqual(
                [companyA, companyB].sort()
            );
            expect(new Set(inserted.rows.map(row => row.event_key)).size).toBe(1);
            expect(inserted.rows.every(row => row.payload.event === 'system.ping')).toBe(true);

            const callsBeforeMissingTenant = querySpy.mock.calls.length;
            await expect(processWebhookPayload('missing-company', payload, {}, null))
                .rejects.toMatchObject({ code: 'ZENBOOKER_TENANT_UNRESOLVED' });
            expect(querySpy).toHaveBeenCalledTimes(callsBeforeMissingTenant);
        } finally {
            querySpy?.mockRestore();
            try { await client.query('SET search_path TO public'); } catch { /* cleanup best effort */ }
            try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch { /* cleanup best effort */ }
            client.release();
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch { /* already closed */ }
});
