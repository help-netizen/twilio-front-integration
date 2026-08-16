'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

const audit = require('../backend/src/services/vapiUsageAuditService');

const COMPANY_A = randomUUID();
const TAG = `${Date.now()}-${process.pid}`;
const MIGRATION_FILES = [
    '266_vapi_call_identity_and_usage.sql',
    '267_vapi_provisional_usage_ingest.sql',
    '269_vapi_usage_reconcile_and_finalization.sql',
];

let pool;
let client;

async function seedSession({ callId, admittedAt, usage } = {}) {
    const inserted = await client.query(
        `INSERT INTO vapi_call_sessions (
             company_id, direction, purpose, environment,
             provider_account_key, expected_vapi_assistant_id, vapi_call_id,
             bind_source, bound_at, admitted_at, state, started_at, ended_at
         ) VALUES (
             $1, 'outbound', 'outbound_parts_call', 'prod',
             'vapi:platform', 'assistant-a', $2, 'post_call_response',
             $3, $3, 'cost_pending', $3, $3
         ) RETURNING id`,
        [COMPANY_A, callId, admittedAt],
    );
    if (usage) {
        await client.query(
            `INSERT INTO vapi_call_usage (
                 company_id, vapi_call_session_id, state,
                 supplier_cost, snapshot_hash, stable_count,
                 last_provider_updated_at, first_pending_at,
                 next_reconcile_at, final_snapshot_version, finalized_at
             ) VALUES (
                 $1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10, $11
             )`,
            [
                COMPANY_A,
                inserted.rows[0].id,
                usage.state,
                usage.supplierCost ?? null,
                usage.snapshotHash ?? null,
                usage.stableCount ?? 0,
                usage.lastProviderUpdatedAt ?? null,
                usage.firstPendingAt ?? admittedAt,
                usage.nextReconcileAt ?? null,
                usage.finalSnapshotVersion ?? 0,
                usage.finalizedAt ?? null,
            ],
        );
    }
    return inserted.rows[0].id;
}

beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query('BEGIN');
    for (const filename of MIGRATION_FILES) {
        await client.query(fs.readFileSync(
            path.join(__dirname, '..', 'backend', 'db', 'migrations', filename),
            'utf8',
        ));
    }
    await client.query(
        `INSERT INTO companies (id, name, slug, status)
         VALUES ($1, $2, $3, 'active')`,
        [COMPANY_A, `Vapi audit ${TAG}`, `vapi-audit-${TAG}`],
    );
});

beforeEach(async () => {
    await client.query(
        `TRUNCATE vapi_usage_alerts, vapi_usage_audit_runs,
                  vapi_call_usage_adjustments, vapi_call_usage_final_snapshots,
                  vapi_call_usage, vapi_call_usage_observations, vapi_call_sessions`,
    );
});

afterAll(async () => {
    if (client) {
        await client.query('ROLLBACK');
        client.release();
    }
    if (pool) await pool.end();
});

describe('VAPI-AGENCY-001 T4 nightly provider audit', () => {
    test('counts provider orphans, local misses and stuck rows, then enqueues late repair', async () => {
        const now = new Date('2026-08-16T06:00:00.000Z');
        const admittedAt = new Date('2026-08-15T12:00:00.000Z');
        const matchedId = await seedSession({
            callId: 'provider-matched',
            admittedAt,
            usage: {
                state: 'final',
                supplierCost: '0.05',
                snapshotHash: 'final-hash',
                stableCount: 2,
                lastProviderUpdatedAt: new Date('2026-08-15T12:05:00.000Z'),
                firstPendingAt: admittedAt,
                finalSnapshotVersion: 1,
                finalizedAt: new Date('2026-08-15T12:10:00.000Z'),
            },
        });
        await seedSession({
            callId: 'provider-local-missing',
            admittedAt,
            usage: {
                state: 'stale_pending',
                firstPendingAt: new Date('2026-08-14T01:00:00.000Z'),
                nextReconcileAt: new Date('2026-08-17T01:00:00.000Z'),
            },
        });
        const run = await audit.claimAuditRunWithClient({ now }, client);
        const providerResult = {
            pages: 1,
            calls: new Map([
                ['provider-matched', {
                    id: 'provider-matched',
                    createdAt: '2026-08-15T12:00:00.000Z',
                    updatedAt: '2026-08-15T13:00:00.000Z',
                }],
                ['provider-orphan', {
                    id: 'provider-orphan',
                    createdAt: '2026-08-15T11:00:00.000Z',
                    updatedAt: '2026-08-15T11:05:00.000Z',
                }],
            ]),
        };

        const completed = await audit.completeAuditWithClient({
            run,
            providerResult,
            now,
        }, client);

        expect(completed).toMatchObject({
            status: 'succeeded',
            pages_scanned: 1,
            provider_calls_scanned: 2,
            orphan_count: 1,
            missing_count: 1,
            stuck_count: 1,
            repair_enqueued_count: 1,
        });
        expect(completed.sample_evidence).toEqual({
            providerOrphanIds: ['provider-orphan'],
            localMissingIds: ['provider-local-missing'],
            stuckSessionIds: expect.any(Array),
        });
        const repaired = await client.query(
            `SELECT state, reconcile_source, next_reconcile_at
             FROM vapi_call_usage
             WHERE company_id = $1 AND vapi_call_session_id = $2`,
            [COMPANY_A, matchedId],
        );
        expect(repaired.rows[0]).toMatchObject({
            state: 'final',
            reconcile_source: 'audit_repair',
            next_reconcile_at: now,
        });
        const alerts = await client.query(
            `SELECT kind FROM vapi_usage_alerts ORDER BY kind`,
        );
        expect(alerts.rows).toEqual([
            { kind: 'local_missing' },
            { kind: 'provider_orphan' },
        ]);
    });

    test('paginates by a progressing time cursor without treating a full page as complete', async () => {
        const firstPage = Array.from({ length: audit.PAGE_LIMIT }, (_unused, index) => ({
            id: `provider-${index}`,
            createdAt: new Date(Date.parse('2026-08-15T23:59:59.000Z') - index * 1000)
                .toISOString(),
            updatedAt: '2026-08-15T23:59:59.000Z',
        }));
        const secondPage = [{
            id: 'provider-last',
            createdAt: '2026-08-15T00:00:01.000Z',
            updatedAt: '2026-08-15T00:00:02.000Z',
        }];
        const listCalls = jest.fn()
            .mockResolvedValueOnce(firstPage)
            .mockResolvedValueOnce(secondPage);

        const result = await audit.fetchProviderWindow({
            listCalls,
            start: new Date('2026-08-15T00:00:00.000Z'),
            end: new Date('2026-08-16T00:00:00.000Z'),
        });

        expect(result.pages).toBe(2);
        expect(result.calls.size).toBe(1001);
        expect(listCalls).toHaveBeenNthCalledWith(2, {
            createdAtGe: '2026-08-15T00:00:00.000Z',
            createdAtLt: firstPage[firstPage.length - 1].createdAt,
            limit: audit.PAGE_LIMIT,
        });
    });

    test('updatedAt review enqueues a correction for a call created before the identity window', async () => {
        const now = new Date('2026-08-16T06:00:00.000Z');
        const sessionId = await seedSession({
            callId: 'provider-old-corrected',
            admittedAt: new Date('2026-08-10T12:00:00.000Z'),
            usage: {
                state: 'final',
                supplierCost: '0.05',
                snapshotHash: 'old-final-hash',
                stableCount: 2,
                lastProviderUpdatedAt: new Date('2026-08-10T12:05:00.000Z'),
                firstPendingAt: new Date('2026-08-10T12:00:00.000Z'),
                finalSnapshotVersion: 1,
                finalizedAt: new Date('2026-08-10T12:10:00.000Z'),
            },
        });
        const run = await audit.claimAuditRunWithClient({ now }, client);

        const completed = await audit.completeAuditWithClient({
            run,
            providerResult: {
                pages: 2,
                calls: new Map(),
                updatedCalls: new Map([['provider-old-corrected', {
                    id: 'provider-old-corrected',
                    createdAt: '2026-08-10T12:00:00.000Z',
                    updatedAt: '2026-08-15T13:00:00.000Z',
                }]]),
            },
            now,
        }, client);

        expect(completed).toMatchObject({
            provider_calls_scanned: 1,
            orphan_count: 0,
            missing_count: 0,
            repair_enqueued_count: 1,
        });
        const usage = await client.query(
            `SELECT state, reconcile_source, next_reconcile_at
             FROM vapi_call_usage
             WHERE company_id = $1 AND vapi_call_session_id = $2`,
            [COMPANY_A, sessionId],
        );
        expect(usage.rows[0]).toMatchObject({
            state: 'final',
            reconcile_source: 'audit_repair',
            next_reconcile_at: now,
        });
    });

    test('updatedAt pagination uses its own provider filter and cursor field', async () => {
        const listCalls = jest.fn().mockResolvedValue([{
            id: 'provider-old-corrected',
            createdAt: '2026-08-10T12:00:00.000Z',
            updatedAt: '2026-08-15T13:00:00.000Z',
        }]);

        const result = await audit.fetchProviderWindow({
            listCalls,
            start: new Date('2026-08-15T00:00:00.000Z'),
            end: new Date('2026-08-16T00:00:00.000Z'),
            timeField: 'updatedAt',
        });

        expect(result.calls.size).toBe(1);
        expect(listCalls).toHaveBeenCalledWith({
            updatedAtGe: '2026-08-15T00:00:00.000Z',
            updatedAtLt: '2026-08-16T00:00:00.000Z',
            limit: audit.PAGE_LIMIT,
        });
    });

    test('cursor ambiguity fails the audit and persists an idempotent platform alert', async () => {
        const now = new Date('2026-08-16T06:00:00.000Z');
        const run = await audit.claimAuditRunWithClient({ now }, client);
        const ambiguous = Array.from({ length: audit.PAGE_LIMIT }, (_unused, index) => ({
            id: `provider-${index}`,
            createdAt: index < audit.PAGE_LIMIT - 2
                ? new Date(Date.parse('2026-08-15T23:59:59.000Z') - index * 1000).toISOString()
                : '2026-08-15T01:00:00.000Z',
            updatedAt: '2026-08-15T23:59:59.000Z',
        }));
        let failure;
        try {
            await audit.fetchProviderWindow({
                listCalls: jest.fn().mockResolvedValue(ambiguous),
                start: new Date(run.window_start),
                end: new Date(run.window_end),
            });
        } catch (error) {
            failure = error;
        }
        expect(failure).toMatchObject({ code: 'VAPI_AUDIT_CURSOR_AMBIGUOUS' });

        await audit.failAuditWithClient({ run, error: failure, now }, client);
        await audit.failAuditWithClient({ run, error: failure, now }, client);
        const stored = await client.query(
            `SELECT audit.status, audit.last_error,
                    (SELECT count(*)::int FROM vapi_usage_alerts
                     WHERE audit_run_id = audit.id) AS alerts
             FROM vapi_usage_audit_runs audit
             WHERE audit.id = $1`,
            [run.id],
        );
        expect(stored.rows).toEqual([{
            status: 'failed',
            last_error: 'VAPI_AUDIT_CURSOR_AMBIGUOUS',
            alerts: 1,
        }]);
    });
});
