'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

const fallback = require('../backend/src/services/vapiFallbackRatingService');
const coverageFixture = require('./fixtures/vapiFallbackCoverage93');

const COMPANY_ID = randomUUID();
const COMPANY_B_ID = randomUUID();
const TAG = `${Date.now()}-${process.pid}`;
const MIGRATIONS = [
    '266_vapi_call_identity_and_usage.sql',
    '267_vapi_provisional_usage_ingest.sql',
    '269_vapi_usage_reconcile_and_finalization.sql',
    '270_vapi_provider_message_quarantine.sql',
    '272_vapi_loss_protection.sql',
].map((filename) => fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', filename),
    'utf8',
));

let pool;
let client;

function runRating(options) {
    return fallback.processCompanyWithClient({
        ...options,
        companyId: COMPANY_ID,
    }, client);
}

async function seedStaleSession({
    companyId = COMPANY_ID,
    callId = `fallback-${randomUUID()}`,
    admittedAt = new Date('2026-08-15T10:00:00.000Z'),
    durationSeconds = '10',
    timestamps = true,
} = {}) {
    const startedAt = timestamps ? new Date('2026-08-15T10:01:00.000Z') : null;
    const endedAt = timestamps && durationSeconds !== null
        ? new Date(startedAt.getTime() + Number(durationSeconds) * 1000)
        : null;
    const session = await client.query(
        `INSERT INTO vapi_call_sessions (
             company_id, direction, purpose, environment, provider_account_key,
             expected_vapi_assistant_id, vapi_call_id, bind_source,
             bound_at, admitted_at, state, started_at, ended_at
         ) VALUES (
             $1, 'outbound', 'outbound_parts_call', 'prod', 'vapi:platform',
             'assistant-a', $2, 'post_call_response',
             $3, $3, 'cost_pending', $4, $5
         ) RETURNING id`,
        [companyId, callId, admittedAt, startedAt, endedAt],
    );
    await client.query(
        `INSERT INTO vapi_call_usage (
             company_id, vapi_call_session_id, state, duration_seconds,
             first_pending_at, next_reconcile_at
         ) VALUES ($1, $2, 'stale_pending', $3::numeric, $4, $4)`,
        [companyId, session.rows[0].id, durationSeconds, admittedAt],
    );
    return session.rows[0].id;
}

async function insertFinalSnapshot({ sessionId, supplierCost, durationSeconds = '10' }) {
    const observed = await client.query(
        `INSERT INTO vapi_call_usage_observations (
             company_id, vapi_call_session_id, source, payload_hash,
             supplier_cost, breakdown_total, provider_updated_at,
             started_at, ended_at, ended_reason, validation_state
         ) VALUES (
             $1, $2, 'get_call', $3, $4::numeric, $4::numeric,
             '2026-08-16T10:00:00Z', '2026-08-15T10:01:00Z',
             '2026-08-15T10:02:00Z', 'customer-ended-call', 'accepted'
         ) RETURNING id`,
        [COMPANY_ID, sessionId, `snapshot-${randomUUID()}`, supplierCost],
    );
    await client.query(
        `INSERT INTO vapi_call_usage_final_snapshots (
             company_id, vapi_call_session_id, snapshot_version,
             observation_id, snapshot_hash, supplier_cost,
             normalized_breakdown, ended_reason, duration_seconds,
             provider_updated_at, snapshot_kind, previous_snapshot_version,
             supplier_cost_delta, finalized_at
         ) VALUES (
             $1, $2, 1, $3, $4, $5::numeric,
             '{}'::jsonb, 'customer-ended-call', $6::numeric,
             '2026-08-16T10:00:00Z', 'initial', NULL,
             $5::numeric, '2026-08-16T10:05:00Z'
         )`,
        [COMPANY_ID, sessionId, observed.rows[0].id, `hash-${randomUUID()}`, supplierCost, durationSeconds],
    );
}

beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query('BEGIN');
    for (const migration of MIGRATIONS) await client.query(migration);
    await client.query(
        `INSERT INTO companies (id, name, slug, status)
         VALUES ($1, $2, $3, 'active'), ($4, $5, $6, 'active')`,
        [
            COMPANY_ID,
            `Vapi fallback ${TAG}`,
            `vapi-fallback-${TAG}`,
            COMPANY_B_ID,
            `Vapi fallback B ${TAG}`,
            `vapi-fallback-b-${TAG}`,
        ],
    );
});

beforeEach(async () => {
    await client.query(
        `TRUNCATE vapi_usage_alert_delivery_items,
                  vapi_usage_alert_delivery_runs,
                  vapi_usage_alerts, vapi_call_cost_input_events,
                  vapi_fallback_rate_policies,
                  vapi_usage_audit_runs, vapi_call_usage_adjustments,
                  vapi_call_usage_final_snapshots, vapi_call_usage,
                  vapi_call_usage_observations, vapi_call_sessions
         RESTART IDENTITY`,
    );
    await client.query(
        `INSERT INTO vapi_fallback_rate_policies (
             rate_per_started_minute, effective_from, source
         ) VALUES (0.20, '-infinity', 'migration_default')`,
    );
});

afterAll(async () => {
    if (client) {
        await client.query('ROLLBACK');
        client.release();
    }
    if (pool) await pool.end();
});

describe('VAPI-AGENCY-001 fallback supplier rating', () => {
    test('10 seconds is one started minute and a repeated run is idempotent', async () => {
        const sessionId = await seedStaleSession({ durationSeconds: '10' });
        const now = new Date('2026-08-16T12:00:00.000Z');

        await runRating({ now, rate: '0.20' });
        await runRating({ now, rate: '0.20' });

        const stored = await client.query(
            `SELECT input_version, event_kind, duration_seconds::text,
                    billed_started_minutes::text, rate_per_started_minute::text,
                    amount_delta::text, effective_supplier_cost::text, is_estimate
             FROM vapi_call_cost_input_events
             WHERE vapi_call_session_id = $1`,
            [sessionId],
        );
        expect(stored.rows).toEqual([{
            input_version: 1,
            event_kind: 'fallback_estimate',
            duration_seconds: '10.000000',
            billed_started_minutes: '1',
            rate_per_started_minute: '0.200000000000',
            amount_delta: '0.200000000000',
            effective_supplier_cost: '0.200000000000',
            is_estimate: true,
        }]);
    });

    test('actual supplier cost appends a correction and never rewrites the estimate', async () => {
        const sessionId = await seedStaleSession({ durationSeconds: '10' });
        const now = new Date('2026-08-16T12:00:00.000Z');
        await runRating({ now, rate: '0.20' });
        await insertFinalSnapshot({ sessionId, supplierCost: '0.0565' });

        await runRating({
            now: new Date('2026-08-16T12:06:00.000Z'),
            rate: '0.20',
        });

        const stored = await client.query(
            `SELECT input_version, event_kind, supplier_snapshot_version,
                    amount_delta::text, effective_supplier_cost::text, is_estimate
             FROM vapi_call_cost_input_events
             WHERE vapi_call_session_id = $1
             ORDER BY input_version`,
            [sessionId],
        );
        expect(stored.rows).toEqual([
            {
                input_version: 1,
                event_kind: 'fallback_estimate',
                supplier_snapshot_version: null,
                amount_delta: '0.200000000000',
                effective_supplier_cost: '0.200000000000',
                is_estimate: true,
            },
            {
                input_version: 2,
                event_kind: 'supplier_actual_correction',
                supplier_snapshot_version: 1,
                amount_delta: '-0.143500000000',
                effective_supplier_cost: '0.056500000000',
                is_estimate: false,
            },
        ]);
        await client.query('SAVEPOINT immutable_check');
        await expect(client.query(
            `UPDATE vapi_call_cost_input_events
             SET effective_supplier_cost = 0
             WHERE vapi_call_session_id = $1 AND input_version = 1`,
            [sessionId],
        )).rejects.toThrow(/VAPI_COST_INPUT_IMMUTABLE/);
        await client.query('ROLLBACK TO SAVEPOINT immutable_check');
    });

    test('supplier final present before rating prevents any fallback estimate', async () => {
        const sessionId = await seedStaleSession({ durationSeconds: '61' });
        await insertFinalSnapshot({ sessionId, supplierCost: '0.42', durationSeconds: '61' });

        const result = await runRating({
            now: new Date('2026-08-16T12:00:00.000Z'),
            rate: '0.20',
        });

        expect(result.estimatesCreated).toBe(0);
        const count = await client.query(
            `SELECT count(*)::int AS count
             FROM vapi_call_cost_input_events
             WHERE vapi_call_session_id = $1`,
            [sessionId],
        );
        expect(count.rows[0].count).toBe(0);
    });

    test('a provisional supplier cost also takes precedence over fallback estimation', async () => {
        const sessionId = await seedStaleSession({ durationSeconds: '61' });
        await client.query(
            `UPDATE vapi_call_usage
             SET supplier_cost = 0.31
             WHERE company_id = $1 AND vapi_call_session_id = $2`,
            [COMPANY_ID, sessionId],
        );

        const result = await runRating({
            now: new Date('2026-08-16T12:00:00.000Z'),
            rate: '0.20',
        });

        expect(result.estimatesCreated).toBe(0);
        await expect(fallback.listDueCompanies(new Date(), client)).resolves.toEqual([]);
    });

    test('missing duration remains unestimated and rate changes pin by admitted_at', async () => {
        const unknownSession = await seedStaleSession({
            durationSeconds: null,
            timestamps: false,
        });
        const oldSession = await seedStaleSession({
            admittedAt: new Date('2026-08-15T10:00:00.000Z'),
            durationSeconds: '61',
        });
        const changeAt = new Date('2026-08-16T00:00:00.000Z');
        await fallback.ensureConfiguredRateWithClient({
            now: changeAt,
            rate: '0.24',
        }, client);
        const newSession = await seedStaleSession({
            admittedAt: new Date('2026-08-17T10:00:00.000Z'),
            durationSeconds: '61',
        });

        await runRating({
            now: new Date('2026-08-18T00:00:00.000Z'),
            rate: '0.24',
        });

        const stored = await client.query(
            `SELECT vapi_call_session_id, rate_per_started_minute::text,
                    effective_supplier_cost::text
             FROM vapi_call_cost_input_events
             WHERE event_kind = 'fallback_estimate'
             ORDER BY vapi_call_session_id`,
        );
        const bySession = new Map(stored.rows.map((row) => [row.vapi_call_session_id, row]));
        expect(bySession.has(unknownSession)).toBe(false);
        expect(bySession.get(oldSession)).toMatchObject({
            rate_per_started_minute: '0.200000000000',
            effective_supplier_cost: '0.400000000000',
        });
        expect(bySession.get(newSession)).toMatchObject({
            rate_per_started_minute: '0.240000000000',
            effective_supplier_cost: '0.480000000000',
        });
    });

    test('dispatcher enumerates companies but one company worker cannot rate a foreign row', async () => {
        const ownSession = await seedStaleSession({ companyId: COMPANY_ID });
        const foreignSession = await seedStaleSession({ companyId: COMPANY_B_ID });

        await expect(fallback.listDueCompanies(new Date(), client)).resolves.toEqual(
            [COMPANY_ID, COMPANY_B_ID].sort(),
        );
        await runRating({
            now: new Date('2026-08-16T12:00:00.000Z'),
            rate: '0.20',
        });

        const stored = await client.query(
            `SELECT vapi_call_session_id, company_id
             FROM vapi_call_cost_input_events
             ORDER BY company_id`,
        );
        expect(stored.rows).toEqual([{
            vapi_call_session_id: ownSession,
            company_id: COMPANY_ID,
        }]);
        expect(stored.rows.some((row) => row.vapi_call_session_id === foreignSession)).toBe(false);
    });

    test('93-call fixture reproduces owner measurement without JS float money math', async () => {
        const result = await client.query(
            `WITH sample AS (
                 SELECT *
                 FROM jsonb_to_recordset($1::jsonb) AS row(
                     "durationSeconds" numeric,
                     "estimatedCost" numeric,
                     "actualCost" numeric
                 )
             )
             SELECT
                 round(sum(CEIL("durationSeconds" / 60) * 0.25), 2)::text
                     AS calculated_estimate,
                 round(sum("estimatedCost"), 2)::text AS fixture_estimate,
                 round(sum("actualCost"), 2)::text AS actual,
                 count(*) FILTER (WHERE "estimatedCost" < "actualCost")::int AS below,
                 count(*) FILTER (WHERE "estimatedCost" > "actualCost")::int AS above,
                 round(sum("estimatedCost") / sum("actualCost") * 100)::int AS coverage,
                 round(sum("actualCost") / sum(CEIL("durationSeconds" / 60)), 2)::text
                     AS break_even_rate
             FROM sample`,
            [JSON.stringify(coverageFixture)],
        );
        expect(result.rows[0]).toEqual({
            calculated_estimate: '48.00',
            fixture_estimate: '48.00',
            actual: '45.34',
            below: 43,
            above: 50,
            coverage: 106,
            break_even_rate: '0.24',
        });
    });
});
