'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

const reconcile = require('../backend/src/services/vapiUsageReconcileService');

const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const TAG = `${Date.now()}-${process.pid}`;
const MIGRATIONS = [266, 267, 269, 272].map((number) => fs.readFileSync(
    path.join(
        __dirname,
        '..',
        'backend',
        'db',
        'migrations',
        number === 266
            ? '266_vapi_call_identity_and_usage.sql'
            : number === 267
                ? '267_vapi_provisional_usage_ingest.sql'
                : number === 269
                    ? '269_vapi_usage_reconcile_and_finalization.sql'
                    : '272_vapi_loss_protection.sql',
    ),
    'utf8',
));

let pool;
let client;

function exactNumber(value) {
    return `__EXACT_NUMBER_${value}__`;
}

function exactJson(value) {
    return JSON.stringify(value).replace(
        /"__EXACT_NUMBER_([^"_]+)__"/g,
        (_match, lexeme) => lexeme,
    );
}

function breakdown(cost, analysis = '0') {
    return {
        transport: exactNumber('0'),
        stt: exactNumber('0.0052'),
        llm: exactNumber('0'),
        tts: exactNumber('0'),
        vapi: exactNumber(cost === '0.0565' ? '0.0503' : cost),
        chat: exactNumber('0'),
        total: exactNumber(cost),
        llmPromptTokens: exactNumber('0'),
        llmCompletionTokens: exactNumber('0'),
        llmCachedPromptTokens: exactNumber('0'),
        ttsCharacters: exactNumber('0'),
        analysisCostBreakdown: {
            summary: exactNumber(analysis),
            structuredData: exactNumber('0'),
            structuredOutput: exactNumber('0'),
            successEvaluation: exactNumber('0'),
            summaryPromptTokens: exactNumber('0'),
            summaryCompletionTokens: exactNumber('0'),
            summaryCachedPromptTokens: exactNumber('0'),
            structuredDataPromptTokens: exactNumber('0'),
            structuredDataCompletionTokens: exactNumber('0'),
            structuredDataCachedPromptTokens: exactNumber('0'),
            structuredOutputPromptTokens: exactNumber('0'),
            structuredOutputCompletionTokens: exactNumber('0'),
            structuredOutputCachedPromptTokens: exactNumber('0'),
            successEvaluationPromptTokens: exactNumber('0'),
            successEvaluationCompletionTokens: exactNumber('0'),
            successEvaluationCachedPromptTokens: exactNumber('0'),
        },
    };
}

function getCallRaw({
    callId = 'provider-call-a',
    assistantId = 'assistant-a',
    cost = '0.05',
    analysis = '0',
    updatedAt = '2026-08-16T05:55:02.208Z',
} = {}) {
    return exactJson({
        id: callId,
        orgId: 'platform-org',
        type: 'outboundPhoneCall',
        assistantId,
        status: 'ended',
        endedReason: 'customer-ended-call',
        createdAt: '2026-08-16T05:53:54.153Z',
        updatedAt,
        startedAt: '2026-08-16T05:53:56.852Z',
        endedAt: '2026-08-16T05:54:57.246Z',
        cost: exactNumber(cost),
        costBreakdown: breakdown(cost, analysis),
        transcript: 'must not persist',
        recordingUrl: 'https://private.invalid/recording',
        customer: { name: 'Private', number: '+15555550100' },
    });
}

async function seedSession({
    companyId = COMPANY_A,
    callId = 'provider-call-a',
    assistantId = 'assistant-a',
    firstPendingAt = new Date('2026-08-16T06:00:00.000Z'),
    createUsage = true,
} = {}) {
    const session = await client.query(
        `INSERT INTO vapi_call_sessions (
             company_id, direction, purpose, environment,
             provider_account_key, expected_vapi_assistant_id, vapi_call_id,
             bind_source, bound_at, admitted_at, state, started_at, ended_at
         ) VALUES (
             $1, 'outbound', 'outbound_parts_call', 'prod',
             'vapi:platform', $3, $2, 'post_call_response',
             $4, $4, 'cost_pending', $4, $4
         ) RETURNING id`,
        [companyId, callId, assistantId, firstPendingAt],
    );
    if (createUsage) await client.query(
        `INSERT INTO vapi_call_usage (
             company_id, vapi_call_session_id, state,
             first_pending_at, next_reconcile_at
         ) VALUES ($1, $2, 'provisional', $3, $3)`,
        [companyId, session.rows[0].id, firstPendingAt],
    );
    return session.rows[0].id;
}

async function seedAssistantProfile({ assistantId = 'assistant-a' } = {}) {
    const connectionId = `vapi-reconcile-connection-${TAG}`;
    const profileId = `vapi-reconcile-profile-${TAG}`;
    await client.query(
        `INSERT INTO provider_connections (
             id, tenant_id, provider, environment, status, company_id
         ) VALUES ($1, $2, 'vapi', 'prod', 'active', $3)`,
        [connectionId, `tenant-${TAG}`, COMPANY_A],
    );
    await client.query(
        `INSERT INTO vapi_assistant_profiles (
             id, tenant_id, provider_connection_id, slug, purpose,
             vapi_assistant_id, is_active, company_id, environment
         ) VALUES (
             $1, $2, $3, $4, 'outbound_parts_call',
             $5, true, $6, 'prod'
         )`,
        [
            profileId, `tenant-${TAG}`, connectionId,
            `reconcile-${TAG}`, assistantId, COMPANY_A,
        ],
    );
    return { connectionId, profileId };
}

async function claim(companyId, now) {
    await client.query(
        `UPDATE vapi_call_usage
         SET next_reconcile_at = $2
         WHERE company_id = $1`,
        [companyId, now],
    );
    return reconcile.claimDueWithClient({ companyId, now }, client);
}

async function applySample({ now, rawJson = getCallRaw(), source } = {}) {
    const claimed = await claim(COMPANY_A, now);
    expect(claimed).not.toBeNull();
    return reconcile.applyAuthoritativeWithClient({
        claim: claimed,
        rawJson,
        source,
        now,
    }, client);
}

async function usageRow() {
    const result = await client.query(
        `SELECT state, supplier_cost::text, stable_count,
                reconcile_attempts, final_snapshot_version,
                pending_correction_hash, last_error
         FROM vapi_call_usage
         WHERE company_id = $1`,
        [COMPANY_A],
    );
    return result.rows[0];
}

async function evidenceCounts() {
    const result = await client.query(
        `SELECT
             (SELECT count(*)::int FROM vapi_call_usage_observations
              WHERE company_id = $1) AS observations,
             (SELECT count(*)::int FROM vapi_call_usage_final_snapshots
              WHERE company_id = $1) AS snapshots,
             (SELECT count(*)::int FROM vapi_call_usage_adjustments
              WHERE company_id = $1) AS adjustments,
             (SELECT count(*)::int FROM billing_wallet_ledger
              WHERE company_id = $1) AS wallet_entries`,
        [COMPANY_A],
    );
    return result.rows[0];
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
            COMPANY_A, `Vapi reconcile A ${TAG}`, `vapi-reconcile-a-${TAG}`,
            COMPANY_B, `Vapi reconcile B ${TAG}`, `vapi-reconcile-b-${TAG}`,
        ],
    );
});

beforeEach(async () => {
    await client.query(
        `TRUNCATE vapi_usage_alert_delivery_items,
                  vapi_usage_alert_delivery_runs, vapi_call_cost_input_events,
                  vapi_usage_alerts, vapi_usage_audit_runs,
                  vapi_call_usage_adjustments, vapi_call_usage_final_snapshots,
                  vapi_call_usage, vapi_call_usage_observations, vapi_call_sessions`,
    );
    await client.query(
        `DELETE FROM vapi_assistant_profiles WHERE company_id = $1`,
        [COMPANY_A],
    );
    await client.query(
        `DELETE FROM provider_connections WHERE company_id = $1`,
        [COMPANY_A],
    );
});

afterAll(async () => {
    if (client) {
        await client.query('ROLLBACK');
        client.release();
    }
    if (pool) await pool.end();
});

describe('VAPI-AGENCY-001 T4 authoritative reconciliation', () => {
    test('retry schedule is 5m/30m/2h with positive jitter, then the 24h deadline', () => {
        const firstPendingAt = '2026-08-16T06:00:00.000Z';
        const now = new Date('2026-08-16T07:00:00.000Z');
        const bases = [5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000];
        for (let index = 0; index < bases.length; index += 1) {
            const scheduled = reconcile.nextAttemptAt({
                firstPendingAt,
                attempts: index + 1,
                now,
                jitterSeed: 'session-a',
            });
            const delay = scheduled.getTime() - now.getTime();
            expect(delay).toBeGreaterThanOrEqual(bases[index]);
            expect(delay).toBeLessThanOrEqual(Math.floor(bases[index] * 1.1));
        }
        expect(reconcile.nextAttemptAt({
            firstPendingAt,
            attempts: 4,
            now,
            jitterSeed: 'session-a',
        }).toISOString()).toBe('2026-08-17T06:00:00.000Z');
    });

    test('operational metrics expose due lag/stale/quarantine counts without supplier amounts', async () => {
        await seedSession();
        const metrics = await reconcile.getOperationalMetricsWithClient(
            new Date('2026-08-16T06:01:00.000Z'),
            client,
        );

        expect(metrics).toEqual({
            due_calls: 1,
            stale_pending: 0,
            quarantined: 0,
            max_lag_seconds: '60.000',
        });
        expect(metrics).not.toHaveProperty('supplier_cost');
    });

    test('missing EoC repair creates usage and pins a legacy outbound assistant from local registry', async () => {
        const profile = await seedAssistantProfile();
        const sessionId = await seedSession({
            assistantId: null,
            createUsage: false,
        });
        const now = new Date('2026-08-16T06:01:00.000Z');

        const claimed = await reconcile.claimDueWithClient({ companyId: COMPANY_A, now }, client);
        expect(claimed).toMatchObject({
            vapi_call_session_id: sessionId,
            expected_vapi_assistant_id: null,
        });
        await reconcile.applyAuthoritativeWithClient({
            claim: claimed,
            rawJson: getCallRaw(),
            now,
        }, client);

        const repaired = await client.query(
            `SELECT session.expected_vapi_assistant_id,
                    session.assistant_profile_id,
                    session.provider_connection_id,
                    usage.state, usage.supplier_cost::text,
                    count(observation.id)::int AS observations
             FROM vapi_call_sessions session
             JOIN vapi_call_usage usage
               ON usage.vapi_call_session_id = session.id
              AND usage.company_id = session.company_id
             LEFT JOIN vapi_call_usage_observations observation
               ON observation.vapi_call_session_id = session.id
              AND observation.company_id = session.company_id
             WHERE session.id = $1 AND session.company_id = $2
             GROUP BY session.id, usage.vapi_call_session_id`,
            [sessionId, COMPANY_A],
        );
        expect(repaired.rows).toEqual([{
            expected_vapi_assistant_id: 'assistant-a',
            assistant_profile_id: profile.profileId,
            provider_connection_id: profile.connectionId,
            state: 'stable_once',
            supplier_cost: '0.050000000000',
            observations: 1,
        }]);
    });

    test('late analysis resets stability; only two matching samples >=5m apart finalize', async () => {
        await seedSession();
        const firstAt = new Date('2026-08-16T06:01:00.000Z');
        const changedAt = new Date('2026-08-16T06:06:00.000Z');
        const finalAt = new Date('2026-08-16T06:11:00.000Z');

        expect(await applySample({
            now: firstAt,
            rawJson: getCallRaw({ cost: '0.05' }),
        })).toMatchObject({ state: 'stable_once' });
        expect(await applySample({
            now: changedAt,
            rawJson: getCallRaw({
                cost: '0.0565',
                analysis: '0.0002',
                updatedAt: '2026-08-16T05:55:02.208Z',
            }),
        })).toMatchObject({ state: 'stable_once' });
        expect(await usageRow()).toMatchObject({
            state: 'stable_once',
            supplier_cost: '0.056500000000',
            stable_count: 1,
            final_snapshot_version: 0,
        });

        expect(await applySample({
            now: finalAt,
            rawJson: getCallRaw({
                cost: '0.0565',
                analysis: '0.0002',
                updatedAt: '2026-08-16T05:55:02.208Z',
            }),
        })).toMatchObject({ state: 'final', finalized: true });
        expect(await usageRow()).toMatchObject({
            state: 'final',
            supplier_cost: '0.056500000000',
            stable_count: 2,
            final_snapshot_version: 1,
        });
        expect(await evidenceCounts()).toEqual({
            observations: 2,
            snapshots: 1,
            adjustments: 0,
            wallet_entries: 0,
        });
        const evidence = await client.query(
            `SELECT sanitized_payload
             FROM vapi_call_usage_observations
             WHERE company_id = $1`,
            [COMPANY_A],
        );
        expect(JSON.stringify(evidence.rows)).not.toMatch(
            /must not persist|private\.invalid|Private|15555550100|transcript|recording/i,
        );
    });

    test('newer provider updatedAt appends evidence even when normalized cost is unchanged', async () => {
        await seedSession();
        await applySample({ now: new Date('2026-08-16T06:01:00.000Z') });
        const result = await applySample({
            now: new Date('2026-08-16T06:06:00.000Z'),
            rawJson: getCallRaw({ updatedAt: '2026-08-16T05:56:02.208Z' }),
        });

        expect(result).toMatchObject({
            state: 'final',
            finalized: true,
            observationCreated: true,
        });
        expect((await evidenceCounts()).observations).toBe(2);
    });

    test('an identical immediate poll is a no-op observation and cannot finalize', async () => {
        await seedSession();
        const firstAt = new Date('2026-08-16T06:01:00.000Z');
        await applySample({ now: firstAt });
        const repeat = await applySample({
            now: new Date('2026-08-16T06:01:30.000Z'),
        });

        expect(repeat).toMatchObject({
            state: 'stable_once',
            observationCreated: false,
        });
        expect(await usageRow()).toMatchObject({
            state: 'stable_once',
            stable_count: 1,
            final_snapshot_version: 0,
        });
        expect(await evidenceCounts()).toEqual({
            observations: 1,
            snapshots: 0,
            adjustments: 0,
            wallet_entries: 0,
        });
    });

    test('provider failure is neither a zero sample nor stability evidence', async () => {
        await seedSession();
        await applySample({ now: new Date('2026-08-16T06:01:00.000Z') });
        const claimed = await claim(COMPANY_A, new Date('2026-08-16T06:06:00.000Z'));
        const failure = await reconcile.recordProviderFailureWithClient({
            claim: claimed,
            error: Object.assign(new Error('timeout'), { code: 'VAPI_PROVIDER_REQUEST_FAILED' }),
            now: new Date('2026-08-16T06:06:00.000Z'),
        }, client);

        expect(failure).toMatchObject({ providerError: true, stale: false });
        expect(await usageRow()).toMatchObject({
            state: 'stable_once',
            supplier_cost: '0.050000000000',
            stable_count: 1,
            final_snapshot_version: 0,
            last_error: 'VAPI_PROVIDER_REQUEST_FAILED',
        });
        expect(await evidenceCounts()).toEqual({
            observations: 1,
            snapshots: 0,
            adjustments: 0,
            wallet_entries: 0,
        });
    });

    test('24h without stability becomes stale_pending with one alert and no charge', async () => {
        await seedSession({ firstPendingAt: new Date('2026-08-15T05:00:00.000Z') });
        const now = new Date('2026-08-16T06:00:00.000Z');
        const claimed = await claim(COMPANY_A, now);
        await reconcile.recordProviderFailureWithClient({
            claim: claimed,
            error: Object.assign(new Error('503'), { code: 'VAPI_PROVIDER_REQUEST_FAILED' }),
            now,
        }, client);
        const again = await claim(COMPANY_A, new Date('2026-08-17T06:00:00.000Z'));
        await reconcile.recordProviderFailureWithClient({
            claim: again,
            error: Object.assign(new Error('503'), { code: 'VAPI_PROVIDER_REQUEST_FAILED' }),
            now: new Date('2026-08-17T06:00:00.000Z'),
        }, client);

        expect(await usageRow()).toMatchObject({
            state: 'stale_pending',
            supplier_cost: null,
            stable_count: 0,
            final_snapshot_version: 0,
        });
        const alerts = await client.query(
            `SELECT kind, count(*)::int AS count
             FROM vapi_usage_alerts
             WHERE company_id = $1
             GROUP BY kind`,
            [COMPANY_A],
        );
        expect(alerts.rows).toEqual([{ kind: 'stale_pending', count: 1 }]);
        expect((await evidenceCounts()).wallet_entries).toBe(0);
    });

    test('post-final correction appends version and delta without rewriting version 1', async () => {
        await seedSession();
        await applySample({ now: new Date('2026-08-16T06:01:00.000Z') });
        await applySample({ now: new Date('2026-08-16T06:06:00.000Z') });
        const before = await client.query(
            `SELECT row_to_json(snapshot)::text AS exact_row
             FROM vapi_call_usage_final_snapshots snapshot
             WHERE company_id = $1 AND snapshot_version = 1`,
            [COMPANY_A],
        );

        const correctionRaw = getCallRaw({
            cost: '0.07',
            analysis: '0.02',
            updatedAt: '2026-08-16T08:00:00.000Z',
        });
        expect(await applySample({
            now: new Date('2026-08-17T03:00:00.000Z'),
            rawJson: correctionRaw,
            source: 'audit_repair',
        })).toMatchObject({ state: 'final', correctionPending: true });
        expect(await applySample({
            now: new Date('2026-08-17T03:05:00.000Z'),
            rawJson: correctionRaw,
            source: 'audit_repair',
        })).toMatchObject({ state: 'final', corrected: true, snapshotVersion: 2 });

        const after = await client.query(
            `SELECT row_to_json(snapshot)::text AS exact_row
             FROM vapi_call_usage_final_snapshots snapshot
             WHERE company_id = $1 AND snapshot_version = 1`,
            [COMPANY_A],
        );
        expect(after.rows[0].exact_row).toBe(before.rows[0].exact_row);
        const versions = await client.query(
            `SELECT snapshot_version, supplier_cost::text,
                    supplier_cost_delta::text, snapshot_kind
             FROM vapi_call_usage_final_snapshots
             WHERE company_id = $1
             ORDER BY snapshot_version`,
            [COMPANY_A],
        );
        expect(versions.rows).toEqual([
            {
                snapshot_version: 1,
                supplier_cost: '0.050000000000',
                supplier_cost_delta: '0.050000000000',
                snapshot_kind: 'initial',
            },
            {
                snapshot_version: 2,
                supplier_cost: '0.070000000000',
                supplier_cost_delta: '0.020000000000',
                snapshot_kind: 'correction',
            },
        ]);
        expect(await evidenceCounts()).toEqual({
            observations: 2,
            snapshots: 2,
            adjustments: 1,
            wallet_entries: 0,
        });
    });

    test('company worker cannot claim or mutate a foreign due row', async () => {
        const sessionId = await seedSession({ companyId: COMPANY_A });
        const foreignClaim = await reconcile.claimDueWithClient({
            companyId: COMPANY_B,
            now: new Date('2026-08-16T06:01:00.000Z'),
        }, client);

        expect(foreignClaim).toBeNull();
        const unchanged = await client.query(
            `SELECT state, reconcile_attempts
             FROM vapi_call_usage
             WHERE company_id = $1 AND vapi_call_session_id = $2`,
            [COMPANY_A, sessionId],
        );
        expect(unchanged.rows).toEqual([{ state: 'provisional', reconcile_attempts: 0 }]);
    });

    test('claim lease lets only one worker own a due session', async () => {
        await seedSession();
        const now = new Date('2026-08-16T06:01:00.000Z');

        const first = await reconcile.claimDueWithClient({ companyId: COMPANY_A, now }, client);
        const duplicate = await reconcile.claimDueWithClient({ companyId: COMPANY_A, now }, client);

        expect(first).toMatchObject({ company_id: COMPANY_A });
        expect(duplicate).toBeNull();
    });
});
