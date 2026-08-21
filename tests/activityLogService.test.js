'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const {
    logActivity,
    sanitizeDetails,
} = require('../backend/src/services/activityLogService');

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const CRM_USER_ID = '22222222-2222-4222-8222-222222222222';
const KEYCLOAK_SUB = '33333333-3333-4333-8333-333333333333';

function systemEvent(overrides = {}) {
    return {
        action: 'job.updated',
        target_type: 'job',
        target_id: 42,
        company_id: COMPANY_ID,
        details: {
            actor_type: 'system',
            actor_label: 'Albusto',
            source: 'crm',
        },
        ...overrides,
    };
}

describe('activityLogService', () => {
    beforeEach(() => db.query.mockReset());

    test('logActivity throws before querying when company_id is missing', async () => {
        const event = systemEvent();
        delete event.company_id;

        await expect(logActivity(event)).rejects.toThrow('company_id is required');
        expect(db.query).not.toHaveBeenCalled();
    });

    test('Keycloak sub is never promoted into actor_id', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 9 }] });

        const result = await logActivity({
            ...systemEvent(),
            sub: KEYCLOAK_SUB,
            details: {
                actor_type: 'integration',
                actor_label: 'Zenbooker',
                source: 'sync',
            },
        });

        expect(result).toEqual({ ok: true, id: 9 });
        const insertParams = db.query.mock.calls[0][1];
        expect(insertParams[0]).toBeNull();
        expect(insertParams).not.toContain(KEYCLOAK_SUB);
    });

    test('a user event with only a Keycloak sub fails instead of using it as actor_id', async () => {
        const client = { query: jest.fn() };
        await expect(logActivity({
            ...systemEvent(),
            sub: KEYCLOAK_SUB,
            details: {
                actor_type: 'user',
                source: 'crm',
            },
        }, { client })).rejects.toThrow('actor_id for user actors is required');
        expect(client.query).not.toHaveBeenCalled();
    });

    test('user actor must resolve through an active company membership', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: CRM_USER_ID }] })
            .mockResolvedValueOnce({ rows: [{ id: 10 }] });

        const result = await logActivity({
            ...systemEvent(),
            actor_id: CRM_USER_ID,
            details: {
                actor_type: 'user',
                actor_label: 'must be removed',
                source: 'crm',
            },
        });

        expect(result).toEqual({ ok: true, id: 10 });
        expect(db.query.mock.calls[0][0]).toContain('m.company_id = $2');
        const insertParams = db.query.mock.calls[1][1];
        expect(insertParams[0]).toBe(CRM_USER_ID);
        expect(JSON.parse(insertParams[7])).toMatchObject({
            actor_type: 'user',
            actor_label: null,
            parent_type: null,
            parent_id: null,
        });
    });

    test('parent snapshots are company-validated and normalized before insert', async () => {
        const client = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [{ id: '42' }] })
                .mockResolvedValueOnce({ rows: [{ id: 11 }] }),
        };

        await expect(logActivity(systemEvent({
            details: {
                actor_type: 'system',
                actor_label: 'Albusto',
                source: 'crm',
                parent_type: 'job',
                parent_id: ' 42 ',
            },
        }), { client })).resolves.toEqual({ ok: true, id: 11 });

        expect(client.query.mock.calls[0][0]).toContain('WHERE company_id = $1');
        expect(client.query.mock.calls[0][1]).toEqual([COMPANY_ID, '42']);
        expect(JSON.parse(client.query.mock.calls[1][1][7])).toMatchObject({
            parent_type: 'job',
            parent_id: '42',
        });
    });

    test('sanitizeDetails strips bodies, credentials, PII, URLs, and raw provider data', () => {
        expect(sanitizeDetails({
            status: 'sent',
            amount: 125.50,
            currency: 'USD',
            count: 2,
            channel: 'sms',
            source: 'webhook',
            message_body: 'secret message',
            note_text: 'private note',
            access_token: 'tok_secret',
            public_url: 'https://example.test/pay/token',
            email: 'client@example.test',
            phone: '+14155552671',
            provider_payload: { anything: true },
            counts: {
                created: 2,
                'client@example.test': 1,
                phone_number: 1,
            },
            summary: {
                invoice_id: 88,
                status: 'paid',
                phone: '+14155552671',
                message: 'private',
            },
        })).toEqual({
            status: 'sent',
            amount: 125.50,
            currency: 'USD',
            count: 2,
            channel: 'sms',
            source: 'webhook',
            counts: {
                created: 2,
            },
            summary: {
                invoice_id: 88,
                status: 'paid',
            },
        });
    });

    test('sanitizeDetails bounds and scrubs summary string arrays', () => {
        const longName = `Long ${'x'.repeat(100)}`;
        const names = Array.from({ length: 13 }, (_, index) =>
            index === 0 ? longName : `Technician ${index}`
        );

        const sanitized = sanitizeDetails({
            summary: {
                from: [
                    ' Alice ',
                    'tech@example.test',
                    '+14155552671',
                    'https://example.test/tech',
                    '',
                ],
                to: names,
            },
        });

        expect(sanitized.summary.from).toEqual(['Alice']);
        expect(sanitized.summary.to).toHaveLength(12);
        expect(sanitized.summary.to[0]).toHaveLength(80);
        expect(sanitized.summary.to[0]).toBe(longName.slice(0, 80));
    });

    test('transaction clients receive insert failures while standalone callers get a failure result', async () => {
        const failure = new Error('audit insert failed');
        const client = { query: jest.fn().mockRejectedValue(failure) };
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

        try {
            await expect(logActivity(systemEvent(), { client })).rejects.toThrow('audit insert failed');

            db.query.mockRejectedValueOnce(failure);
            await expect(logActivity(systemEvent())).resolves.toMatchObject({
                ok: false,
                error: failure,
            });
        } finally {
            consoleError.mockRestore();
        }
    });
});

describe('migration 209', () => {
    test('adds and rolls back both required audit_log indexes', () => {
        const migrations = path.join(__dirname, '../backend/db/migrations');
        const migration = fs.readFileSync(
            path.join(migrations, '209_activity_log_history_indexes.sql'),
            'utf8'
        );
        const rollback = fs.readFileSync(
            path.join(migrations, 'rollback_209_activity_log_history_indexes.sql'),
            'utf8'
        );

        expect(migration).toMatch(
            /CREATE INDEX IF NOT EXISTS[\s\S]*company_id,\s*target_type,\s*target_id,\s*created_at DESC/
        );
        expect(migration).toMatch(
            /CREATE INDEX IF NOT EXISTS[\s\S]*details->>'parent_type'[\s\S]*details->>'parent_id'[\s\S]*created_at DESC/
        );
        expect(migration).toContain(
            "WHERE details ? 'parent_type' AND details ? 'parent_id'"
        );
        expect(rollback).toContain('DROP INDEX IF EXISTS idx_audit_log_company_parent_created');
        expect(rollback).toContain('DROP INDEX IF EXISTS idx_audit_log_company_target_created');
    });
});
