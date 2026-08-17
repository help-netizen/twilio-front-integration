'use strict';

const { randomUUID } = require('crypto');
const { withTransaction } = require('./transactionService');
const providerClient = require('./vapiProviderClient');
const vapiCallIdentity = require('./vapiCallIdentityService');

const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIT_LEASE_MS = 30 * 60 * 1000;
const PAGE_LIMIT = 1000;
const MAX_PAGES = 100;
const SAMPLE_LIMIT = 20;
const DEFAULT_AUDIT_CATCHUP_DAYS = 7;
const MAX_AUDIT_CATCHUP_DAYS = 31;

class VapiUsageAuditError extends Error {
    constructor(code) {
        super(code);
        this.name = 'VapiUsageAuditError';
        this.code = code;
    }
}

function utcDayWindow(now = new Date()) {
    const end = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
    ));
    return {
        auditDate: new Date(end.getTime() - DAY_MS).toISOString().slice(0, 10),
        start: new Date(end.getTime() - DAY_MS),
        end,
    };
}

function normalizeAuditCatchupDays(value) {
    const configured = typeof value === 'number'
        ? value
        : (
            typeof value === 'string' && /^\d+$/.test(value)
                ? Number(value)
                : Number.NaN
        );
    if (!Number.isSafeInteger(configured) || configured < 1) {
        return DEFAULT_AUDIT_CATCHUP_DAYS;
    }
    return Math.min(configured, MAX_AUDIT_CATCHUP_DAYS);
}

function auditCatchupDays(env = process.env) {
    return normalizeAuditCatchupDays(env.VAPI_USAGE_AUDIT_CATCHUP_DAYS);
}

function assertDescendingPage(page, timeField = 'createdAt') {
    for (let index = 1; index < page.length; index += 1) {
        if (Date.parse(page[index][timeField]) > Date.parse(page[index - 1][timeField])) {
            throw new VapiUsageAuditError('VAPI_AUDIT_PAGE_ORDER_INVALID');
        }
    }
    if (page.length === PAGE_LIMIT && page.length > 1
        && page[page.length - 1][timeField] === page[page.length - 2][timeField]) {
        throw new VapiUsageAuditError('VAPI_AUDIT_CURSOR_AMBIGUOUS');
    }
}

async function claimAuditRunWithClient({
    now = new Date(),
    catchupDays = auditCatchupDays(),
}, client) {
    const { auditDate } = utcDayWindow(now);
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + AUDIT_LEASE_MS);
    const result = await client.query(
        `WITH candidate AS (
             SELECT day::date AS audit_date
             FROM generate_series(
                 $1::date - (($2::integer - 1) * interval '1 day'),
                 $1::date,
                 interval '1 day'
             ) AS day
             LEFT JOIN vapi_usage_audit_runs existing
               ON existing.audit_date = day::date
             WHERE existing.id IS NULL
                OR existing.status = 'failed'
                OR (
                    existing.status = 'running'
                    AND existing.lease_expires_at <= $4
                )
             ORDER BY day
             LIMIT 1
         )
         INSERT INTO vapi_usage_audit_runs (
             audit_date, window_start, window_end, status,
             claim_token, lease_expires_at, started_at
         )
         SELECT audit_date,
                audit_date::timestamp AT TIME ZONE 'UTC',
                (audit_date + 1)::timestamp AT TIME ZONE 'UTC',
                'running', $3, $5, $4
         FROM candidate
         ON CONFLICT (audit_date) DO UPDATE
         SET status = 'running', claim_token = EXCLUDED.claim_token,
             lease_expires_at = EXCLUDED.lease_expires_at,
             started_at = EXCLUDED.started_at, finished_at = NULL,
             last_error = NULL
         WHERE vapi_usage_audit_runs.status = 'failed'
            OR (
                vapi_usage_audit_runs.status = 'running'
                AND vapi_usage_audit_runs.lease_expires_at <= $4
            )
         RETURNING *, audit_date::text AS audit_date_key`,
        [
            auditDate,
            normalizeAuditCatchupDays(catchupDays),
            claimToken,
            now,
            leaseExpiresAt,
        ],
    );
    return result.rows[0] || null;
}

async function fetchProviderWindow({ listCalls, start, end, timeField = 'createdAt' }) {
    if (!['createdAt', 'updatedAt'].includes(timeField)) {
        throw new VapiUsageAuditError('VAPI_AUDIT_TIME_FIELD_INVALID');
    }
    const calls = new Map();
    let cursor = end.toISOString();
    let pages = 0;
    while (pages < MAX_PAGES) {
        const page = await listCalls(timeField === 'createdAt'
            ? {
                createdAtGe: start.toISOString(),
                createdAtLt: cursor,
                limit: PAGE_LIMIT,
            }
            : {
                updatedAtGe: start.toISOString(),
                updatedAtLt: cursor,
                limit: PAGE_LIMIT,
            });
        if (!Array.isArray(page)) {
            throw new VapiUsageAuditError('VAPI_AUDIT_PAGE_ARRAY_REQUIRED');
        }
        assertDescendingPage(page, timeField);
        pages += 1;
        for (const call of page) calls.set(call.id, call);
        if (page.length < PAGE_LIMIT) return { calls, pages };
        const nextCursor = page[page.length - 1][timeField];
        if (Date.parse(nextCursor) >= Date.parse(cursor)) {
            throw new VapiUsageAuditError('VAPI_AUDIT_CURSOR_DID_NOT_ADVANCE');
        }
        cursor = nextCursor;
    }
    throw new VapiUsageAuditError('VAPI_AUDIT_MAX_PAGES_EXCEEDED');
}

async function localIdentityRows(client, start, end, providerCallIds) {
    const result = await client.query(
        `SELECT session.id, session.company_id, session.vapi_call_id,
                usage.state, usage.last_provider_updated_at,
                usage.supplier_cost::text AS supplier_cost,
                usage.vapi_call_session_id IS NOT NULL AS has_usage,
                COALESCE(session.started_at, session.bound_at, session.admitted_at)
                    AS identity_at
         FROM vapi_call_sessions session
         LEFT JOIN vapi_call_usage usage
           ON usage.vapi_call_session_id = session.id
          AND usage.company_id = session.company_id
         WHERE session.vapi_call_id IS NOT NULL
           AND (
               session.vapi_call_id = ANY($3::text[])
               OR (
                   COALESCE(session.started_at, session.bound_at, session.admitted_at) >= $1
                   AND COALESCE(session.started_at, session.bound_at, session.admitted_at) < $2
               )
           )`,
        [start, end, providerCallIds],
    );
    return result.rows;
}

async function enqueueRepairs(client, {
    identityCalls,
    updatedCalls,
    localRows,
    now,
}) {
    let enqueued = 0;
    for (const row of localRows) {
        const identityProvider = identityCalls.get(row.vapi_call_id);
        const updatedProvider = updatedCalls.get(row.vapi_call_id);
        if (!identityProvider && !updatedProvider) continue;
        if (!row.has_usage) {
            const inserted = await client.query(
                `INSERT INTO vapi_call_usage (
                     company_id, vapi_call_session_id, state,
                     first_pending_at, next_reconcile_at, reconcile_source
                 ) VALUES ($1, $2, 'provisional', $3, $3, 'audit_repair')
                 ON CONFLICT (vapi_call_session_id) DO NOTHING
                 RETURNING vapi_call_session_id`,
                [row.company_id, row.id, now],
            );
            enqueued += inserted.rows.length;
            continue;
        }
        if (row.state === 'final' && updatedProvider && (
            !row.last_provider_updated_at
            || Date.parse(updatedProvider.updatedAt)
                > new Date(row.last_provider_updated_at).getTime()
        )) {
            const updated = await client.query(
                `UPDATE vapi_call_usage
                 SET next_reconcile_at = $3,
                     reconcile_source = 'audit_repair'
                 WHERE company_id = $1
                   AND vapi_call_session_id = $2
                   AND state = 'final'
                   AND (
                       reconcile_claim_token IS NULL
                       OR reconcile_lease_expires_at <= $3
                   )
                 RETURNING vapi_call_session_id`,
                [row.company_id, row.id, now],
            );
            enqueued += updated.rows.length;
        }
    }
    return enqueued;
}

async function insertAuditAlerts(client, { run, kind, rows, now }) {
    for (const row of rows) {
        const providerCallId = row.providerCallId;
        const supplierCost = row.supplierCost || null;
        const details = {
            auditDate: run.audit_date_key || String(run.audit_date),
            providerCallId,
        };
        await client.query(
            `INSERT INTO vapi_usage_alerts (
                 company_id, vapi_call_session_id, audit_run_id,
                 provider_call_id, kind, dedupe_key, details,
                 supplier_cost_at_risk, cost_basis, updated_at
             ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7::jsonb,
                 $8::numeric,
                 CASE WHEN $8::numeric IS NULL THEN 'unknown' ELSE 'supplier' END,
                 $9
             )
             ON CONFLICT (dedupe_key) DO UPDATE
             SET audit_run_id = EXCLUDED.audit_run_id,
                 details = EXCLUDED.details,
                 supplier_cost_at_risk = EXCLUDED.supplier_cost_at_risk,
                 cost_basis = EXCLUDED.cost_basis,
                 updated_at = EXCLUDED.updated_at
             WHERE vapi_usage_alerts.details IS DISTINCT FROM EXCLUDED.details
                OR vapi_usage_alerts.supplier_cost_at_risk
                    IS DISTINCT FROM EXCLUDED.supplier_cost_at_risk`,
            [
                row.companyId || null,
                row.sessionId || null,
                run.id,
                providerCallId,
                kind,
                `${kind}:${providerCallId}`,
                JSON.stringify(details),
                supplierCost,
                now,
            ],
        );
    }
}

async function repairPendingOutboundIdentities(client, providerCalls) {
    let repaired = 0;
    for (const call of providerCalls.values()) {
        if (!call.albustoCallSessionId || !call.assistantId) continue;
        const candidate = await client.query(
            // tenant-safety-allow R-natural-key: platform audit starts from the
            // server-generated session UUID stored in provider metadata; company
            // is derived only from that globally unique local row, never provider input.
            `SELECT id, company_id, outbound_call_attempt_id,
                    expected_vapi_assistant_id, state, vapi_call_id
             FROM vapi_call_sessions
             WHERE id = $1
               AND direction = 'outbound'
             LIMIT 2
             FOR UPDATE`,
            [call.albustoCallSessionId],
        );
        if (candidate.rows.length !== 1) continue;
        const session = candidate.rows[0];
        if (
            session.state !== 'provider_pending'
            || session.vapi_call_id
            || !session.outbound_call_attempt_id
            || session.expected_vapi_assistant_id !== call.assistantId
        ) {
            continue;
        }
        await client.query('SAVEPOINT vapi_outbound_identity_repair');
        try {
            await vapiCallIdentity.bindOutboundPlacementWithClient({
                companyId: session.company_id,
                sessionId: String(session.id),
                outboundCallAttemptId: String(session.outbound_call_attempt_id),
                providerCallId: call.id,
            }, client);
            await client.query('RELEASE SAVEPOINT vapi_outbound_identity_repair');
            repaired += 1;
        } catch (error) {
            await client.query('ROLLBACK TO SAVEPOINT vapi_outbound_identity_repair');
            await client.query('RELEASE SAVEPOINT vapi_outbound_identity_repair');
            console.error('[VAPI_OUTBOUND_ALERT] audit could not repair pending identity', {
                sessionId: String(session.id),
                providerCallId: call.id,
                code: error?.code || 'VAPI_OUTBOUND_AUDIT_REPAIR_FAILED',
            });
        }
    }
    return repaired;
}

async function completeAuditWithClient({ run, providerResult, now = new Date() }, client) {
    const updatedCalls = providerResult.updatedCalls || providerResult.calls;
    const providerCalls = new Map(providerResult.calls);
    for (const [id, call] of updatedCalls) {
        providerCalls.set(id, { ...(providerCalls.get(id) || {}), ...call });
    }
    const allProviderIds = new Set([
        ...providerResult.calls.keys(),
        ...updatedCalls.keys(),
    ]);
    const outboundIdentityRepaired = await repairPendingOutboundIdentities(
        client,
        providerCalls,
    );
    const localRows = await localIdentityRows(
        client,
        run.window_start,
        run.window_end,
        [...allProviderIds],
    );
    const localByProviderId = new Map(localRows.map((row) => [row.vapi_call_id, row]));
    const orphanIds = [...providerResult.calls.keys()]
        .filter((id) => !localByProviderId.has(id));
    const windowStartMs = new Date(run.window_start).getTime();
    const windowEndMs = new Date(run.window_end).getTime();
    const missingRows = localRows
        .filter((row) => {
            const identityMs = new Date(row.identity_at).getTime();
            return identityMs >= windowStartMs
                && identityMs < windowEndMs
                && !providerResult.calls.has(row.vapi_call_id);
        });
    const missingIds = missingRows.map((row) => row.vapi_call_id);
    const stuck = await client.query(
        `SELECT count(*)::int AS count,
                COALESCE(array_agg(vapi_call_session_id::text ORDER BY first_pending_at)
                    FILTER (WHERE sample_rank <= $2), ARRAY[]::text[]) AS sample_ids
         FROM (
             SELECT vapi_call_session_id, first_pending_at,
                    row_number() OVER (ORDER BY first_pending_at) AS sample_rank
             FROM vapi_call_usage
             WHERE state IN (
                 'provisional', 'reconciling', 'stable_once', 'stale_pending'
             )
               AND first_pending_at <= $1::timestamptz - interval '24 hours'
         ) candidates`,
        [now, SAMPLE_LIMIT],
    );
    const repairEnqueued = await enqueueRepairs(client, {
        identityCalls: providerResult.calls,
        updatedCalls,
        localRows,
        now,
    });
    const samples = {
        providerOrphanIds: orphanIds.slice(0, SAMPLE_LIMIT),
        localMissingIds: missingIds.slice(0, SAMPLE_LIMIT),
        stuckSessionIds: stuck.rows[0].sample_ids,
    };
    const updated = await client.query(
        // tenant-safety-allow R-natural-key: platform-global audit run has no company_id; id plus its one-time claim token scopes completion.
        `UPDATE vapi_usage_audit_runs
         SET status = 'succeeded', pages_scanned = $3,
             provider_calls_scanned = $4, orphan_count = $5,
             missing_count = $6, stuck_count = $7,
             repair_enqueued_count = $8,
             outbound_identity_repaired_count = $9,
             sample_evidence = $10::jsonb,
             claim_token = NULL, lease_expires_at = NULL,
             finished_at = $11, last_error = NULL
         WHERE id = $1
           AND claim_token = $2
         RETURNING *`,
        [
            run.id, run.claim_token, providerResult.pages,
            allProviderIds.size, orphanIds.length, missingIds.length,
            stuck.rows[0].count, repairEnqueued, outboundIdentityRepaired,
            JSON.stringify(samples), now,
        ],
    );
    if (updated.rows.length !== 1) {
        throw new VapiUsageAuditError('VAPI_AUDIT_CLAIM_LOST');
    }
    await insertAuditAlerts(client, {
        run,
        kind: 'provider_orphan',
        rows: orphanIds.map((providerCallId) => ({
            providerCallId,
            supplierCost: providerResult.calls.get(providerCallId)?.supplierCost || null,
        })),
        now,
    });
    await insertAuditAlerts(client, {
        run,
        kind: 'local_missing',
        rows: missingRows.map((row) => ({
            companyId: row.company_id,
            sessionId: row.id,
            providerCallId: row.vapi_call_id,
            supplierCost: row.supplier_cost,
        })),
        now,
    });
    return updated.rows[0];
}

async function failAuditWithClient({ run, error, now = new Date() }, client) {
    const code = String(error?.code || 'VAPI_AUDIT_FAILED').slice(0, 255);
    await client.query(
        // tenant-safety-allow R-natural-key: platform-global audit run has no company_id; id plus its one-time claim token scopes failure.
        `UPDATE vapi_usage_audit_runs
         SET status = 'failed', last_error = $3,
             claim_token = NULL, lease_expires_at = NULL, finished_at = $4
         WHERE id = $1 AND claim_token = $2`,
        [run.id, run.claim_token, code, now],
    );
    await client.query(
        `INSERT INTO vapi_usage_alerts (
             audit_run_id, kind, dedupe_key, details, updated_at
         ) VALUES ($1, 'quarantined', $2, $3::jsonb, $4)
         ON CONFLICT (dedupe_key) DO UPDATE
         SET details = EXCLUDED.details, updated_at = EXCLUDED.updated_at
         WHERE vapi_usage_alerts.details IS DISTINCT FROM EXCLUDED.details`,
        [
            run.id,
            `quarantined:audit:${run.audit_date_key || String(run.audit_date)}`,
            JSON.stringify({ code, source: 'provider_audit' }),
            now,
        ],
    );
    return { status: 'failed', code };
}

async function runNightlyAudit(options = {}) {
    const now = options.now || new Date();
    const run = await withTransaction((client) => claimAuditRunWithClient({
        now,
        catchupDays: options.catchupDays || auditCatchupDays(),
    }, client));
    if (!run) return { skipped: true, auditDate: null };
    try {
        const listCalls = options.listCalls || providerClient.listCalls;
        const identityResult = await fetchProviderWindow({
            listCalls,
            start: new Date(run.window_start),
            end: new Date(run.window_end),
            timeField: 'createdAt',
        });
        const updatedResult = await fetchProviderWindow({
            listCalls,
            start: new Date(run.window_start),
            end: new Date(run.window_end),
            timeField: 'updatedAt',
        });
        const providerResult = {
            calls: identityResult.calls,
            updatedCalls: updatedResult.calls,
            pages: identityResult.pages + updatedResult.pages,
        };
        const result = await withTransaction((client) => completeAuditWithClient({
            run,
            providerResult,
            now,
        }, client));
        return {
            skipped: false,
            status: result.status,
            runId: result.id,
            auditDate: run.audit_date_key,
        };
    } catch (error) {
        const failed = await withTransaction(
            (client) => failAuditWithClient({ run, error, now }, client),
        );
        return { ...failed, skipped: false, auditDate: run.audit_date_key };
    }
}

module.exports = {
    PAGE_LIMIT,
    MAX_PAGES,
    VapiUsageAuditError,
    DEFAULT_AUDIT_CATCHUP_DAYS,
    MAX_AUDIT_CATCHUP_DAYS,
    utcDayWindow,
    normalizeAuditCatchupDays,
    auditCatchupDays,
    assertDescendingPage,
    claimAuditRunWithClient,
    fetchProviderWindow,
    repairPendingOutboundIdentities,
    completeAuditWithClient,
    failAuditWithClient,
    runNightlyAudit,
};
