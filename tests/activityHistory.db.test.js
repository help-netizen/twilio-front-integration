'use strict';

const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const { logActivity } = require('../backend/src/services/activityLogService');
const eventService = require('../backend/src/services/eventService');

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
    test('ACTIVITY-LOG-001 P1 DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`ACTIVITY-LOG-001 P1 DB tests are pending: ${DATABASE.reason}`);
    });
}

let client;
let originalQuery;

beforeAll(async () => {
    if (!DATABASE.ready) return;

    originalQuery = db.query;
    client = await db.pool.connect();
    db.query = (text, params) => client.query(text, params);
    await client.query(`
        CREATE TEMP TABLE audit_log (
            id BIGSERIAL PRIMARY KEY,
            actor_id UUID,
            actor_email VARCHAR(255),
            actor_ip INET,
            action VARCHAR(100) NOT NULL,
            target_type VARCHAR(50),
            target_id VARCHAR(255),
            company_id UUID,
            details JSONB NOT NULL DEFAULT '{}',
            trace_id VARCHAR(64),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TEMP TABLE crm_users (
            id UUID PRIMARY KEY,
            full_name TEXT,
            email TEXT
        );
        CREATE TEMP TABLE company_memberships (
            user_id UUID NOT NULL,
            company_id UUID NOT NULL,
            status TEXT NOT NULL
        );
        CREATE TEMP TABLE leads (
            id BIGINT PRIMARY KEY,
            serial_id BIGINT,
            company_id UUID NOT NULL
        );
        CREATE TEMP TABLE estimates (
            id BIGINT PRIMARY KEY,
            company_id UUID NOT NULL,
            contact_id BIGINT,
            lead_id BIGINT,
            job_id BIGINT
        );
        CREATE TEMP TABLE invoices (
            id BIGINT PRIMARY KEY,
            company_id UUID NOT NULL,
            contact_id BIGINT,
            lead_id BIGINT,
            job_id BIGINT,
            estimate_id BIGINT
        );
        CREATE TEMP TABLE payment_transactions (
            id BIGINT PRIMARY KEY,
            company_id UUID NOT NULL,
            contact_id BIGINT,
            estimate_id BIGINT,
            invoice_id BIGINT,
            job_id BIGINT
        );
        CREATE TEMP TABLE domain_events (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID NOT NULL,
            aggregate_type VARCHAR(50) NOT NULL,
            aggregate_id VARCHAR(255) NOT NULL,
            event_type VARCHAR(100) NOT NULL,
            event_data JSONB NOT NULL DEFAULT '{}',
            actor_type VARCHAR(20) NOT NULL DEFAULT 'system',
            actor_id VARCHAR(255),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TEMP TABLE activity_mutations (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID NOT NULL,
            value TEXT NOT NULL
        );
        CREATE TEMP TABLE activity_log_config (
            key TEXT PRIMARY KEY,
            value TIMESTAMPTZ NOT NULL
        );
        INSERT INTO activity_log_config (key, value)
        VALUES ('cutover_at', '2026-07-26T08:00:00Z');
    `);
    eventService.resetActivityLogCutoverCache();
});

afterAll(async () => {
    if (originalQuery) db.query = originalQuery;
    if (client) client.release();
    try { await db.pool.end(); } catch (_) { /* already closed */ }
});

databaseTest('transaction failure rolls back the mutation and canonical activity row together', async () => {
    const companyId = randomUUID();
    const action = 'job.updated';
    const mutationValue = randomUUID();

    await client.query('BEGIN');
    await client.query(
        'INSERT INTO activity_mutations (company_id, value) VALUES ($1, $2)',
        [companyId, mutationValue]
    );
    await expect(logActivity({
        action,
        target_type: 'job',
        target_id: 42,
        company_id: companyId,
        details: {
            actor_type: 'system',
            actor_label: 'Albusto',
            source: 'crm',
        },
    }, { client })).resolves.toMatchObject({ ok: true });

    await expect(client.query('SELECT 1 / 0')).rejects.toThrow();
    await client.query('ROLLBACK');

    await expect(client.query(
        'SELECT id FROM activity_mutations WHERE company_id = $1 AND value = $2',
        [companyId, mutationValue]
    )).resolves.toMatchObject({ rows: [] });
    await expect(client.query(
        'SELECT id FROM audit_log WHERE company_id = $1 AND action = $2',
        [companyId, action]
    )).resolves.toMatchObject({ rows: [] });
});

databaseTest('History unions own, snapshot, current-child, note, and legacy rows without duplicates', async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const jobId = '42';

    await client.query(
        `INSERT INTO estimates (id, company_id, contact_id, lead_id, job_id)
         VALUES
            (100, $1, 900, 800, 42),
            (777, $2, NULL, NULL, 42)`,
        [companyA, companyB]
    );
    await client.query(
        `INSERT INTO invoices (id, company_id, contact_id, lead_id, job_id, estimate_id)
         VALUES (200, $1, 900, NULL, NULL, 100)`,
        [companyA]
    );
    await client.query(
        `INSERT INTO payment_transactions (
            id, company_id, contact_id, estimate_id, invoice_id, job_id
         ) VALUES (300, $1, 999, NULL, 200, NULL)`,
        [companyA]
    );

    const activities = [
        ['job.updated', 'job', 42, { actor_type: 'system', actor_label: 'Albusto' }, '2026-07-26T12:00:00Z'],
        ['estimate.sent', 'estimate', 100, { actor_type: 'integration', actor_label: 'Zenbooker', parent_type: 'job', parent_id: 42 }, '2026-07-26T11:00:00Z'],
        ['invoice.sent', 'invoice', 200, { actor_type: 'system', actor_label: 'Albusto', parent_type: 'lead', parent_id: 999 }, '2026-07-26T10:00:00Z'],
        ['payment.recorded', 'payment', 300, { actor_type: 'system', actor_label: 'Stripe', parent_type: 'contact', parent_id: 999 }, '2026-07-26T09:00:00Z'],
        ['payment.refunded', 'payment', 301, { actor_type: 'system', actor_label: 'Stripe', parent_type: 'job', parent_id: 42 }, '2026-07-26T08:00:00Z'],
    ];
    const activityIds = {};
    for (const [action, targetType, targetId, details, createdAt] of activities) {
        const { rows } = await client.query(
            `INSERT INTO audit_log (
                action, target_type, target_id, company_id, details, created_at
             ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
             RETURNING id`,
            [action, targetType, String(targetId), companyA, JSON.stringify(details), createdAt]
        );
        activityIds[action] = rows[0].id;
    }
    await client.query(
        `INSERT INTO audit_log (
            action, target_type, target_id, company_id, details, created_at
         ) VALUES
            ('estimate.foreign', 'estimate', '777', $1, $2::jsonb, '2026-07-26T13:00:00Z')`,
        [
            companyB,
            JSON.stringify({
                actor_type: 'system',
                actor_label: 'Foreign',
                parent_type: 'job',
                parent_id: 42,
            }),
        ]
    );
    await client.query(
        `INSERT INTO domain_events (
            company_id, aggregate_type, aggregate_id, event_type,
            event_data, actor_type, created_at
         ) VALUES
            ($1, 'job', $2, 'rescheduled', '{"actor_name":"Alex"}', 'user', '2026-07-26T07:00:00Z'),
            ($1, 'job', $2, 'note_added', '{}', 'user', '2026-07-26T06:00:00Z'),
            ($1, 'job', $2, 'note_edited', '{}', 'user', '2026-07-26T05:00:00Z'),
            ($1, 'job', $2, 'note_deleted', '{}', 'user', '2026-07-26T04:00:00Z'),
            ($3, 'job', $2, 'foreign_event', '{}', 'system', '2026-07-26T14:00:00Z')`,
        [companyA, jobId, companyB]
    );

    const notes = [
        { id: 'active', text: 'Visible note', author: 'Alex', created: '2026-07-26T06:30:00Z' },
        { id: 'deleted', text: 'Hidden note', created: '2026-07-26T06:00:00Z', deleted_at: '2026-07-26T06:01:00Z' },
    ];
    const history = await eventService.getEntityHistory(companyA, 'job', jobId, notes);
    const eventTypes = history.filter(item => item.type === 'event').map(item => item.event_type);

    expect(eventTypes).toEqual(expect.arrayContaining([
        'job.updated',
        'estimate.sent',
        'invoice.sent',
        'payment.recorded',
        'payment.refunded',
        'rescheduled',
    ]));
    expect(eventTypes).not.toEqual(expect.arrayContaining([
        'estimate.foreign',
        'foreign_event',
        'note_added',
        'note_edited',
        'note_deleted',
    ]));

    // estimate.sent matches both its stored snapshot and its current relation.
    // UNION on audit_log.id must still return exactly one item.
    expect(history.filter(item => item.id === `audit_${activityIds['estimate.sent']}`)).toHaveLength(1);
    // invoice.sent and payment.recorded have mismatching snapshots, so these
    // prove the current Invoice/Payment relationship legs.
    expect(history).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: `audit_${activityIds['invoice.sent']}` }),
        expect.objectContaining({ id: `audit_${activityIds['payment.recorded']}` }),
    ]));
    // payment.refunded has no current child row, so this proves snapshot rollup.
    expect(history).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: `audit_${activityIds['payment.refunded']}` }),
    ]));
    expect(history.filter(item => item.type === 'note').map(item => item.text)).toEqual(['Visible note']);

    const page = await eventService.getEntityHistory(
        companyA,
        'job',
        jobId,
        notes,
        { limit: 2, offset: 1 }
    );
    expect(page.map(item => item.id)).toEqual(history.slice(1, 3).map(item => item.id));
});

databaseTest('History reads legacy events only before the global audit-log cutover', async () => {
    const companyId = randomUUID();
    const jobId = '314';

    await client.query(
        `INSERT INTO domain_events (
            company_id, aggregate_type, aggregate_id, event_type,
            event_data, actor_type, created_at
         ) VALUES
            ($1, 'job', $2, 'status_changed', '{"from":"New","to":"Scheduled"}', 'system',
                '2026-07-26T07:00:00Z'),
            ($1, 'job', $2, 'status_changed', '{"from":"Scheduled","to":"Complete"}', 'system',
                '2026-07-26T09:00:00Z')`,
        [companyId, jobId]
    );
    await client.query(
        `INSERT INTO audit_log (
            action, target_type, target_id, company_id, details, created_at
         ) VALUES (
            'job.status_changed', 'job', $1, $2,
            '{"actor_type":"integration","actor_label":"Zenbooker","summary":{"status":"Complete"}}',
            '2026-07-26T09:00:00Z'
         )`,
        [jobId, companyId]
    );

    const history = await eventService.getEntityHistory(companyId, 'job', jobId);
    const events = history.filter(item => item.type === 'event');

    expect(events.filter(item => item.action === 'status_changed')).toHaveLength(1);
    expect(events.filter(item => item.action === 'job.status_changed')).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(events.map(item => item.created_at)).toEqual([
        '2026-07-26T09:00:00.000Z',
        '2026-07-26T07:00:00.000Z',
    ]);
});
