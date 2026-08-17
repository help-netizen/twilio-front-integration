'use strict';

const { createHash, randomUUID } = require('crypto');
const db = require('../db/connection');
const { withTransaction } = require('./transactionService');
const providerClient = require('./vapiProviderClient');
const {
    VapiContractError,
    parseVapiGetCallJson,
    sanitizeVapiGetCallJson,
} = require('./vapiProviderContracts');
const {
    VapiUsageIngestError,
    hashEvidence,
    normalizeObservation,
} = require('./vapiUsageIngestService');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DEFAULT_MIN_STABLE_MS = 5 * MINUTE_MS;
const DEFAULT_STALE_AFTER_MS = 24 * HOUR_MS;
const CLAIM_LEASE_MS = 2 * MINUTE_MS;
const RETRY_DELAYS_MS = [5 * MINUTE_MS, 30 * MINUTE_MS, 2 * HOUR_MS];

class VapiUsageReconcileError extends Error {
    constructor(code) {
        super(code);
        this.name = 'VapiUsageReconcileError';
        this.code = code;
    }
}

function requiredCompanyId(companyId) {
    if (typeof companyId !== 'string' || companyId.trim() === '') {
        throw new VapiUsageReconcileError('VAPI_RECONCILE_COMPANY_REQUIRED');
    }
    return companyId.trim();
}

function positiveConfiguredMs(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
    return parsed;
}

function minStableMs() {
    return positiveConfiguredMs(process.env.VAPI_COST_STABLE_INTERVAL_MS, DEFAULT_MIN_STABLE_MS);
}

function staleAfterMs() {
    return positiveConfiguredMs(process.env.VAPI_COST_STALE_AFTER_MS, DEFAULT_STALE_AFTER_MS);
}

function timestampMs(value, code) {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) throw new VapiUsageReconcileError(code);
    return parsed;
}

function snapshotHash(parsed, normalized) {
    return hashEvidence({
        supplierCost: normalized.supplierCost,
        normalizedBreakdown: normalized.normalizedBreakdown,
        durationSeconds: normalized.durationSeconds,
        endedAt: parsed.call.endedAt,
        endedReason: parsed.call.endedReason,
    });
}

function jitteredDelayMs(baseDelayMs, seed) {
    const hex = createHash('sha256').update(String(seed), 'utf8').digest('hex').slice(0, 8);
    const basisPoints = BigInt(`0x${hex}`) % 1001n;
    const offset = (BigInt(baseDelayMs) * basisPoints) / 10000n;
    return baseDelayMs + Number(offset);
}

function nextAttemptAt({ firstPendingAt, attempts, now, jitterSeed = '' }) {
    const deadlineMs = timestampMs(firstPendingAt, 'VAPI_RECONCILE_FIRST_PENDING_INVALID')
        + staleAfterMs();
    if (deadlineMs <= now.getTime()) return new Date(now.getTime() + staleAfterMs());
    if (attempts <= RETRY_DELAYS_MS.length) {
        const delayMs = jitteredDelayMs(
            RETRY_DELAYS_MS[attempts - 1],
            `${jitterSeed}:${attempts}`,
        );
        return new Date(Math.min(now.getTime() + delayMs, deadlineMs));
    }
    return new Date(deadlineMs > now.getTime() ? deadlineMs : now.getTime() + staleAfterMs());
}

function isStale(firstPendingAt, now) {
    return now.getTime() - timestampMs(
        firstPendingAt,
        'VAPI_RECONCILE_FIRST_PENDING_INVALID',
    ) >= staleAfterMs();
}

async function listDueCompanies(now = new Date(), limit = 100) {
    const result = await db.query(
        `SELECT company_id
         FROM (
             SELECT usage.company_id, min(usage.next_reconcile_at) AS due_at
             FROM vapi_call_usage usage
             WHERE usage.next_reconcile_at <= $1
               AND usage.state IN (
                   'provisional', 'reconciling', 'stable_once',
                   'stale_pending', 'quarantined', 'final'
               )
               AND (
                   usage.reconcile_claim_token IS NULL
                   OR usage.reconcile_lease_expires_at <= $1
               )
             GROUP BY usage.company_id
             UNION ALL
             SELECT session.company_id,
                    min(COALESCE(session.ended_at, session.updated_at)) AS due_at
             FROM vapi_call_sessions session
             LEFT JOIN vapi_call_usage usage
               ON usage.vapi_call_session_id = session.id
              AND usage.company_id = session.company_id
             WHERE usage.vapi_call_session_id IS NULL
               AND session.vapi_call_id IS NOT NULL
               AND session.state IN ('ended', 'cost_pending')
             GROUP BY session.company_id
         ) candidates
         GROUP BY company_id
         ORDER BY min(due_at), company_id
         LIMIT $2`,
        [now, limit],
    );
    return result.rows.map((row) => row.company_id);
}

async function getOperationalMetricsWithClient(now = new Date(), client = db) {
    const result = await client.query(
        `SELECT
             count(*) FILTER (
                 WHERE next_reconcile_at <= $1
                   AND state IN (
                       'provisional', 'reconciling', 'stable_once',
                       'stale_pending', 'quarantined', 'final'
                   )
             )::int AS due_calls,
             count(*) FILTER (WHERE state = 'stale_pending')::int AS stale_pending,
             count(*) FILTER (WHERE state = 'quarantined')::int AS quarantined,
             COALESCE(
                 max(EXTRACT(EPOCH FROM ($1 - next_reconcile_at))) FILTER (
                     WHERE next_reconcile_at <= $1
                 ),
                 0
             )::numeric(18,3)::text AS max_lag_seconds
         FROM vapi_call_usage`,
        [now],
    );
    return result.rows[0];
}

async function getOperationalMetrics(now = new Date()) {
    return getOperationalMetricsWithClient(now, db);
}

async function ensureEndedSessionsHaveUsage(client, companyId, now) {
    await client.query(
        `INSERT INTO vapi_call_usage (
             company_id, vapi_call_session_id, state,
             first_pending_at, next_reconcile_at
         )
         SELECT session.company_id, session.id, 'provisional',
                COALESCE(session.ended_at, session.updated_at, $2), $2
         FROM vapi_call_sessions session
         LEFT JOIN vapi_call_usage usage
           ON usage.vapi_call_session_id = session.id
          AND usage.company_id = session.company_id
         WHERE session.company_id = $1
           AND usage.vapi_call_session_id IS NULL
           AND session.vapi_call_id IS NOT NULL
           AND session.state IN ('ended', 'cost_pending')
         ON CONFLICT (vapi_call_session_id) DO NOTHING`,
        [companyId, now],
    );
}

async function claimDueWithClient({ companyId, now = new Date() }, client) {
    const scopedCompanyId = requiredCompanyId(companyId);
    await ensureEndedSessionsHaveUsage(client, scopedCompanyId, now);
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
    const result = await client.query(
        `WITH candidate AS (
             SELECT usage.vapi_call_session_id
             FROM vapi_call_usage usage
             WHERE usage.company_id = $1
               AND usage.next_reconcile_at <= $2
               AND usage.state IN (
                   'provisional', 'reconciling', 'stable_once',
                   'stale_pending', 'quarantined', 'final'
               )
               AND (
                   usage.reconcile_claim_token IS NULL
                   OR usage.reconcile_lease_expires_at <= $2
               )
             ORDER BY usage.next_reconcile_at, usage.vapi_call_session_id
             LIMIT 1
             FOR UPDATE SKIP LOCKED
         )
         UPDATE vapi_call_usage usage
         SET reconcile_claim_token = $3,
             reconcile_lease_expires_at = $4,
             state = CASE WHEN usage.state = 'final' THEN 'final' ELSE 'reconciling' END
         FROM candidate
         WHERE usage.vapi_call_session_id = candidate.vapi_call_session_id
           AND usage.company_id = $1
         RETURNING usage.*`,
        [scopedCompanyId, now, claimToken, leaseExpiresAt],
    );
    if (!result.rows[0]) return null;

    const identity = await client.query(
        `SELECT session.vapi_call_id, session.expected_vapi_assistant_id,
                session.direction, session.purpose, session.environment
         FROM vapi_call_sessions session
         WHERE session.id = $1
           AND session.company_id = $2
         LIMIT 2`,
        [result.rows[0].vapi_call_session_id, scopedCompanyId],
    );
    if (identity.rows.length !== 1 || !identity.rows[0].vapi_call_id
        || (identity.rows[0].direction === 'inbound'
            && !identity.rows[0].expected_vapi_assistant_id)) {
        throw new VapiUsageReconcileError('VAPI_RECONCILE_IDENTITY_INVALID');
    }
    return { ...result.rows[0], ...identity.rows[0], claim_token: claimToken };
}

async function assertProviderIdentityWithClient(client, claim, parsed) {
    if (parsed.call.id !== claim.vapi_call_id) {
        throw new VapiUsageReconcileError('VAPI_RECONCILE_CALL_ID_MISMATCH');
    }
    if (claim.expected_vapi_assistant_id
        && parsed.call.assistantId !== claim.expected_vapi_assistant_id) {
        throw new VapiUsageReconcileError('VAPI_RECONCILE_ASSISTANT_MISMATCH');
    }
    const expectedType = claim.direction === 'inbound'
        ? 'inboundPhoneCall'
        : 'outboundPhoneCall';
    if (parsed.call.type !== expectedType) {
        throw new VapiUsageReconcileError('VAPI_RECONCILE_DIRECTION_MISMATCH');
    }
    if (claim.expected_vapi_assistant_id) return;
    if (claim.direction !== 'outbound') {
        throw new VapiUsageReconcileError('VAPI_RECONCILE_ASSISTANT_MISMATCH');
    }

    const profile = await client.query(
        `SELECT profile.id, profile.provider_connection_id
         FROM vapi_assistant_profiles profile
         JOIN provider_connections connection
           ON connection.id = profile.provider_connection_id
          AND connection.company_id = profile.company_id
          AND connection.provider = 'vapi'
          AND connection.status = 'active'
         WHERE profile.company_id = $1
           AND profile.purpose = $2
           AND profile.environment = $3
           AND profile.vapi_assistant_id = $4
           AND profile.is_active = true
         ORDER BY profile.id
         LIMIT 2
         FOR SHARE OF profile, connection`,
        [
            claim.company_id,
            claim.purpose,
            claim.environment,
            parsed.call.assistantId,
        ],
    );
    if (profile.rows.length !== 1) {
        throw new VapiUsageReconcileError('VAPI_RECONCILE_ASSISTANT_NOT_OWNED');
    }
    const pinned = await client.query(
        `UPDATE vapi_call_sessions
         SET expected_vapi_assistant_id = $3,
             assistant_profile_id = $4,
             provider_connection_id = $5
         WHERE id = $1
           AND company_id = $2
           AND direction = 'outbound'
           AND expected_vapi_assistant_id IS NULL
         RETURNING id`,
        [
            claim.vapi_call_session_id,
            claim.company_id,
            parsed.call.assistantId,
            profile.rows[0].id,
            profile.rows[0].provider_connection_id,
        ],
    );
    if (pinned.rows.length !== 1) {
        throw new VapiUsageReconcileError('VAPI_RECONCILE_ASSISTANT_PIN_RACE');
    }
}

function retryableErrorCode(error) {
    if (!error) return 'VAPI_PROVIDER_REQUEST_FAILED';
    if (error instanceof VapiContractError) return `VAPI_CONTRACT_${error.code}`;
    return String(error.code || 'VAPI_PROVIDER_REQUEST_FAILED').slice(0, 255);
}

function isProviderEvidenceError(error) {
    return error instanceof VapiContractError
        || error instanceof VapiUsageIngestError
        || error instanceof VapiUsageReconcileError;
}

function assertClaimUpdated(result) {
    if (result.rows.length !== 1) {
        throw new VapiUsageReconcileError('VAPI_RECONCILE_CLAIM_LOST');
    }
    return result;
}

async function emitSessionAlert(client, {
    companyId,
    sessionId,
    providerCallId,
    supplierCost,
    kind,
    details,
    now = new Date(),
}) {
    await client.query(
        `INSERT INTO vapi_usage_alerts (
             company_id, vapi_call_session_id, provider_call_id,
             kind, dedupe_key, details, supplier_cost_at_risk,
             cost_basis, updated_at
         ) VALUES (
             $1, $2, $3, $4, $5, $6::jsonb, $7::numeric,
             CASE WHEN $7::numeric IS NULL THEN 'unknown' ELSE 'supplier' END,
             $8
         )
         ON CONFLICT (dedupe_key) DO UPDATE
         SET details = EXCLUDED.details,
             supplier_cost_at_risk = EXCLUDED.supplier_cost_at_risk,
             cost_basis = EXCLUDED.cost_basis,
             updated_at = EXCLUDED.updated_at
         WHERE vapi_usage_alerts.details IS DISTINCT FROM EXCLUDED.details
            OR vapi_usage_alerts.supplier_cost_at_risk
                IS DISTINCT FROM EXCLUDED.supplier_cost_at_risk`,
        [
            companyId,
            sessionId,
            providerCallId,
            kind,
            `${kind}:${sessionId}`,
            JSON.stringify(details || {}),
            supplierCost || null,
            now,
        ],
    );
}

async function resolveSessionAlerts(client, { companyId, sessionId, kinds, now }) {
    await client.query(
        `UPDATE vapi_usage_alerts
         SET resolved_at = COALESCE(resolved_at, $4), updated_at = $4
         WHERE company_id = $1
           AND vapi_call_session_id = $2
           AND kind = ANY($3::text[])
           AND resolved_at IS NULL`,
        [companyId, sessionId, kinds, now],
    );
}

async function recordProviderFailureWithClient({ claim, error, now = new Date() }, client) {
    const attempts = Number(claim.reconcile_attempts) + 1;
    const stale = claim.state !== 'final' && isStale(claim.first_pending_at, now);
    const correctionStale = claim.state === 'final'
        && claim.pending_correction_first_seen_at
        && now.getTime() - new Date(claim.pending_correction_first_seen_at).getTime()
            >= staleAfterMs();
    const nextAt = nextAttemptAt({
        firstPendingAt: claim.first_pending_at,
        attempts,
        now,
        jitterSeed: claim.vapi_call_session_id,
    });
    const result = await client.query(
        `UPDATE vapi_call_usage
         SET state = CASE
                 WHEN state = 'final' THEN 'final'
                 WHEN $5 THEN 'stale_pending'
                 WHEN stable_count > 0 THEN 'stable_once'
                 ELSE 'provisional'
             END,
             reconcile_attempts = reconcile_attempts + 1,
             next_reconcile_at = $4,
             last_error = $3,
             reconcile_claim_token = NULL,
             reconcile_lease_expires_at = NULL
         WHERE company_id = $1
           AND vapi_call_session_id = $2
           AND reconcile_claim_token = $6
         RETURNING state`,
        [
            claim.company_id,
            claim.vapi_call_session_id,
            retryableErrorCode(error),
            nextAt,
            stale,
            claim.claim_token,
        ],
    );
    if (result.rows.length !== 1) {
        throw new VapiUsageReconcileError('VAPI_RECONCILE_CLAIM_LOST');
    }
    if (stale) {
        await emitSessionAlert(client, {
            companyId: claim.company_id,
            sessionId: claim.vapi_call_session_id,
            providerCallId: claim.vapi_call_id,
            supplierCost: claim.supplier_cost,
            kind: 'stale_pending',
            details: { reason: 'provider_unavailable', attempts },
            now,
        });
    }
    if (correctionStale) {
        await emitSessionAlert(client, {
            companyId: claim.company_id,
            sessionId: claim.vapi_call_session_id,
            providerCallId: claim.vapi_call_id,
            supplierCost: claim.supplier_cost,
            kind: 'late_correction_stale',
            details: {
                reason: 'late_supplier_correction_not_stable',
                targetSnapshotVersion: Number(claim.final_snapshot_version) + 1,
                attempts,
            },
            now,
        });
    }
    return {
        providerError: true,
        stale: stale || correctionStale,
        state: result.rows[0].state,
    };
}

async function insertAuthoritativeObservation(client, {
    claim,
    source,
    parsed,
    normalized,
    sanitized,
    payloadHash,
}) {
    const components = normalized.components;
    const inserted = await client.query(
        `INSERT INTO vapi_call_usage_observations (
             company_id, vapi_call_session_id, source, payload_hash,
             supplier_cost, breakdown_total,
             transport_cost, stt_cost, llm_cost, tts_cost, vapi_cost, chat_cost,
             analysis_cost, prompt_tokens, completion_tokens, total_tokens,
             breakdown_schema_version, cost_breakdown_evidence,
             provider_updated_at, started_at, ended_at, ended_reason,
             validation_state, assistant_id, call_type, provider_status,
             sanitized_payload
         ) VALUES (
             $1, $2, $3, $4,
             $5::numeric, $5::numeric,
             $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10::numeric, $11::numeric,
             $12::numeric, $13::bigint, $14::bigint, $15::bigint,
             1, $16::jsonb,
             $17, $18, $19, $20,
             'accepted', $21, $22, $23,
             $24::jsonb
         )
         ON CONFLICT (company_id, vapi_call_session_id, source, payload_hash)
         DO NOTHING
         RETURNING id`,
        [
            claim.company_id,
            claim.vapi_call_session_id,
            source,
            payloadHash,
            normalized.supplierCost,
            components.transport,
            components.stt,
            components.llm,
            components.tts,
            components.vapi,
            components.chat,
            normalized.analysisCost,
            normalized.promptTokens,
            normalized.completionTokens,
            normalized.totalTokens,
            JSON.stringify(normalized.normalizedBreakdown),
            parsed.call.updatedAt,
            parsed.call.startedAt,
            parsed.call.endedAt,
            parsed.call.endedReason,
            parsed.call.assistantId,
            parsed.call.type,
            parsed.call.status,
            JSON.stringify(sanitized),
        ],
    );
    if (inserted.rows[0]) return inserted.rows[0].id;
    const existing = await client.query(
        `SELECT id
         FROM vapi_call_usage_observations
         WHERE company_id = $1
           AND vapi_call_session_id = $2
           AND source = $3
           AND payload_hash = $4
         LIMIT 2`,
        [claim.company_id, claim.vapi_call_session_id, source, payloadHash],
    );
    if (existing.rows.length !== 1) {
        throw new VapiUsageReconcileError('VAPI_RECONCILE_OBSERVATION_AMBIGUOUS');
    }
    return existing.rows[0].id;
}

async function finalizeInitial(client, { claim, observationId, parsed, normalized, hash, now }) {
    await client.query(
        `INSERT INTO vapi_call_usage_final_snapshots (
             company_id, vapi_call_session_id, snapshot_version,
             observation_id, snapshot_hash, supplier_cost, normalized_breakdown,
             ended_reason, duration_seconds, provider_updated_at,
             snapshot_kind, previous_snapshot_version, supplier_cost_delta,
             finalized_at
         ) VALUES (
             $1, $2, 1, $3, $4, $5::numeric, $6::jsonb,
             $7, $8::numeric, $9, 'initial', NULL, $5::numeric, $10
         )
         ON CONFLICT (vapi_call_session_id, snapshot_version) DO NOTHING`,
        [
            claim.company_id, claim.vapi_call_session_id, observationId, hash,
            normalized.supplierCost, JSON.stringify(normalized.normalizedBreakdown),
            parsed.call.endedReason, normalized.durationSeconds,
            parsed.call.updatedAt, now,
        ],
    );
}

async function finalizeCorrection(client, {
    claim,
    observationId,
    parsed,
    normalized,
    hash,
    now,
}) {
    const nextVersion = Number(claim.final_snapshot_version) + 1;
    const snapshot = await client.query(
        `INSERT INTO vapi_call_usage_final_snapshots (
             company_id, vapi_call_session_id, snapshot_version,
             observation_id, snapshot_hash, supplier_cost, normalized_breakdown,
             ended_reason, duration_seconds, provider_updated_at,
             snapshot_kind, previous_snapshot_version, supplier_cost_delta,
             finalized_at
         ) SELECT
             $1, $2, $3, $4, $5, $6::numeric, $7::jsonb,
             $8, $9::numeric, $10, 'correction', $11,
             $6::numeric - previous.supplier_cost, $12
         FROM vapi_call_usage_final_snapshots previous
         WHERE previous.vapi_call_session_id = $2
           AND previous.company_id = $1
           AND previous.snapshot_version = $11
         ON CONFLICT (vapi_call_session_id, snapshot_version) DO NOTHING
         RETURNING supplier_cost_delta::text`,
        [
            claim.company_id, claim.vapi_call_session_id, nextVersion,
            observationId, hash, normalized.supplierCost,
            JSON.stringify(normalized.normalizedBreakdown), parsed.call.endedReason,
            normalized.durationSeconds, parsed.call.updatedAt,
            Number(claim.final_snapshot_version), now,
        ],
    );
    if (snapshot.rows.length !== 1) {
        throw new VapiUsageReconcileError('VAPI_RECONCILE_CORRECTION_VERSION_CONFLICT');
    }
    await client.query(
        `INSERT INTO vapi_call_usage_adjustments (
             company_id, vapi_call_session_id,
             from_snapshot_version, to_snapshot_version, supplier_cost_delta
         ) VALUES ($1, $2, $3, $4, $5::numeric)
         ON CONFLICT (vapi_call_session_id, to_snapshot_version) DO NOTHING`,
        [
            claim.company_id, claim.vapi_call_session_id,
            Number(claim.final_snapshot_version), nextVersion,
            snapshot.rows[0].supplier_cost_delta,
        ],
    );
    return nextVersion;
}

async function applyAuthoritativeWithClient({
    claim,
    rawJson,
    source = 'get_call',
    now = new Date(),
}, client) {
    const parsed = parseVapiGetCallJson(rawJson);
    await assertProviderIdentityWithClient(client, claim, parsed);
    const normalized = normalizeObservation(parsed);
    const hash = snapshotHash(parsed, normalized);
    const sanitized = sanitizeVapiGetCallJson(rawJson);
    const payloadHash = hashEvidence(sanitized);
    const providerUpdatedMs = timestampMs(
        parsed.call.updatedAt,
        'VAPI_RECONCILE_PROVIDER_UPDATED_AT_INVALID',
    );
    const storedProviderUpdatedMs = claim.last_provider_updated_at
        ? new Date(claim.last_provider_updated_at).getTime()
        : null;
    const observedComparisonHash = claim.pending_correction_hash || claim.snapshot_hash;
    const shouldAppend = storedProviderUpdatedMs === null
        || providerUpdatedMs > storedProviderUpdatedMs
        || hash !== observedComparisonHash;
    let observationId = claim.authoritative_observation_id;
    if (shouldAppend) {
        observationId = await insertAuthoritativeObservation(client, {
            claim,
            source,
            parsed,
            normalized,
            sanitized,
            payloadHash,
        });
    }
    if (!observationId) {
        throw new VapiUsageReconcileError('VAPI_RECONCILE_OBSERVATION_REQUIRED');
    }

    const attempts = Number(claim.reconcile_attempts) + 1;
    const nextAt = nextAttemptAt({
        firstPendingAt: claim.first_pending_at,
        attempts,
        now,
        jitterSeed: claim.vapi_call_session_id,
    });
    const latestProviderUpdatedAt = storedProviderUpdatedMs === null
        || providerUpdatedMs > storedProviderUpdatedMs
        ? parsed.call.updatedAt
        : claim.last_provider_updated_at;

    if (claim.state === 'final') {
        if (hash === claim.snapshot_hash) {
            assertClaimUpdated(await client.query(
                `UPDATE vapi_call_usage
                 SET last_provider_updated_at = $3,
                     authoritative_observation_id = $4,
                     reconcile_attempts = reconcile_attempts + 1,
                     next_reconcile_at = NULL,
                     last_error = NULL,
                     pending_correction_hash = NULL,
                     pending_correction_observation_id = NULL,
                     pending_correction_first_seen_at = NULL,
                     reconcile_claim_token = NULL,
                     reconcile_lease_expires_at = NULL
                 WHERE company_id = $1
                   AND vapi_call_session_id = $2
                   AND reconcile_claim_token = $5
                 RETURNING vapi_call_session_id`,
                [
                    claim.company_id, claim.vapi_call_session_id,
                    latestProviderUpdatedAt, observationId, claim.claim_token,
                ],
            ));
            return { state: 'final', observationCreated: shouldAppend, corrected: false };
        }

        const correctionMatches = claim.pending_correction_hash === hash;
        const correctionSeparated = correctionMatches
            && now.getTime() - new Date(claim.pending_correction_first_seen_at).getTime()
                >= minStableMs();
        if (correctionSeparated) {
            const nextVersion = await finalizeCorrection(client, {
                claim,
                observationId: claim.pending_correction_observation_id || observationId,
                parsed,
                normalized,
                hash,
                now,
            });
            assertClaimUpdated(await client.query(
                `UPDATE vapi_call_usage
                 SET supplier_cost = $3::numeric,
                     normalized_breakdown = $4::jsonb,
                     ended_reason = $5,
                     duration_seconds = $6::numeric,
                     snapshot_hash = $7,
                     last_provider_updated_at = $8,
                     authoritative_observation_id = $9,
                     reconcile_attempts = reconcile_attempts + 1,
                     next_reconcile_at = NULL,
                     last_error = NULL,
                     final_snapshot_version = $10,
                     finalized_at = $11,
                     pending_correction_hash = NULL,
                     pending_correction_observation_id = NULL,
                     pending_correction_first_seen_at = NULL,
                     reconcile_claim_token = NULL,
                     reconcile_lease_expires_at = NULL
                 WHERE company_id = $1
                   AND vapi_call_session_id = $2
                   AND reconcile_claim_token = $12
                 RETURNING vapi_call_session_id`,
                [
                    claim.company_id, claim.vapi_call_session_id,
                    normalized.supplierCost, JSON.stringify(normalized.normalizedBreakdown),
                    parsed.call.endedReason, normalized.durationSeconds, hash,
                    latestProviderUpdatedAt, observationId, nextVersion, now,
                    claim.claim_token,
                ],
            ));
            await resolveSessionAlerts(client, {
                companyId: claim.company_id,
                sessionId: claim.vapi_call_session_id,
                kinds: ['late_correction_stale'],
                now,
            });
            return {
                state: 'final', observationCreated: shouldAppend,
                corrected: true, snapshotVersion: nextVersion,
            };
        }

        assertClaimUpdated(await client.query(
            `UPDATE vapi_call_usage
             SET last_provider_updated_at = $3,
                 authoritative_observation_id = $4,
                 reconcile_attempts = reconcile_attempts + 1,
                 next_reconcile_at = $5,
                 last_error = NULL,
                 pending_correction_hash = $6,
                 pending_correction_observation_id = $7,
                 pending_correction_first_seen_at = CASE
                     WHEN pending_correction_hash = $6
                     THEN pending_correction_first_seen_at
                     ELSE $8
                 END,
                 reconcile_claim_token = NULL,
                 reconcile_lease_expires_at = NULL
             WHERE company_id = $1
               AND vapi_call_session_id = $2
               AND reconcile_claim_token = $9
             RETURNING vapi_call_session_id`,
            [
                claim.company_id, claim.vapi_call_session_id,
                latestProviderUpdatedAt, observationId,
                new Date(now.getTime() + minStableMs()), hash,
                correctionMatches
                    ? claim.pending_correction_observation_id
                    : observationId,
                now, claim.claim_token,
            ],
        ));
        return { state: 'final', observationCreated: shouldAppend, correctionPending: true };
    }

    const sameSnapshot = claim.snapshot_hash === hash;
    const separated = sameSnapshot && claim.last_authoritative_at
        && now.getTime() - new Date(claim.last_authoritative_at).getTime() >= minStableMs();
    if (separated) {
        await finalizeInitial(client, { claim, observationId, parsed, normalized, hash, now });
        assertClaimUpdated(await client.query(
            `UPDATE vapi_call_usage
             SET state = 'final', supplier_cost = $3::numeric,
                 normalized_breakdown = $4::jsonb, ended_reason = $5,
                 duration_seconds = $6::numeric, snapshot_hash = $7,
                 stable_count = 2, last_provider_updated_at = $8,
                 authoritative_observation_id = $9,
                 reconcile_attempts = reconcile_attempts + 1,
                 next_reconcile_at = NULL, last_error = NULL,
                 final_snapshot_version = 1, finalized_at = $10,
                 reconcile_claim_token = NULL,
                 reconcile_lease_expires_at = NULL
             WHERE company_id = $1
               AND vapi_call_session_id = $2
               AND reconcile_claim_token = $11
             RETURNING vapi_call_session_id`,
            [
                claim.company_id, claim.vapi_call_session_id,
                normalized.supplierCost, JSON.stringify(normalized.normalizedBreakdown),
                parsed.call.endedReason, normalized.durationSeconds, hash,
                latestProviderUpdatedAt, observationId, now, claim.claim_token,
            ],
        ));
        await resolveSessionAlerts(client, {
            companyId: claim.company_id,
            sessionId: claim.vapi_call_session_id,
            kinds: ['stale_pending', 'local_missing', 'quarantined'],
            now,
        });
        return { state: 'final', observationCreated: shouldAppend, finalized: true };
    }

    const stale = isStale(claim.first_pending_at, now);
    assertClaimUpdated(await client.query(
        `UPDATE vapi_call_usage
         SET state = CASE WHEN $10 THEN 'stale_pending' ELSE 'stable_once' END,
             supplier_cost = $3::numeric,
             normalized_breakdown = $4::jsonb,
             ended_reason = $5,
             duration_seconds = $6::numeric,
             snapshot_hash = $7,
             stable_count = 1,
             last_authoritative_at = CASE
                 WHEN snapshot_hash = $7 THEN last_authoritative_at
                 ELSE $8
             END,
             last_provider_updated_at = $9,
             authoritative_observation_id = $11,
             reconcile_attempts = reconcile_attempts + 1,
             next_reconcile_at = $12,
             last_error = NULL,
             reconcile_claim_token = NULL,
             reconcile_lease_expires_at = NULL
         WHERE company_id = $1
           AND vapi_call_session_id = $2
           AND reconcile_claim_token = $13
         RETURNING vapi_call_session_id`,
        [
            claim.company_id, claim.vapi_call_session_id,
            normalized.supplierCost, JSON.stringify(normalized.normalizedBreakdown),
            parsed.call.endedReason, normalized.durationSeconds, hash, now,
            latestProviderUpdatedAt, stale, observationId, nextAt, claim.claim_token,
        ],
    ));
    if (stale) {
        await emitSessionAlert(client, {
            companyId: claim.company_id,
            sessionId: claim.vapi_call_session_id,
            providerCallId: parsed.call.id,
            supplierCost: normalized.supplierCost,
            kind: 'stale_pending',
            details: { reason: 'supplier_cost_not_stable', attempts },
            now,
        });
    }
    return { state: stale ? 'stale_pending' : 'stable_once', observationCreated: shouldAppend };
}

async function processClaim(claim, dependencies = {}) {
    const getCall = dependencies.getCall || providerClient.getCall;
    const now = dependencies.now || new Date();
    let rawJson;
    try {
        rawJson = await getCall(claim.vapi_call_id);
    } catch (error) {
        return withTransaction((client) => recordProviderFailureWithClient({ claim, error, now }, client));
    }
    try {
        return await withTransaction((client) => applyAuthoritativeWithClient({
            claim,
            rawJson,
            source: dependencies.source || claim.reconcile_source || 'get_call',
            now,
        }, client));
    } catch (error) {
        if (!isProviderEvidenceError(error)) throw error;
        return withTransaction((client) => recordProviderFailureWithClient({ claim, error, now }, client));
    }
}

async function processDueCompany(companyId, options = {}) {
    const scopedCompanyId = requiredCompanyId(companyId);
    const now = options.now || new Date();
    const maxCalls = options.maxCalls || 25;
    const results = [];
    for (let index = 0; index < maxCalls; index += 1) {
        const claim = await withTransaction((client) => claimDueWithClient({
            companyId: scopedCompanyId,
            now,
        }, client));
        if (!claim) break;
        results.push(await processClaim(claim, { ...options, now }));
    }
    return {
        companyId: scopedCompanyId,
        processed: results.length,
        finalized: results.filter((result) => result.finalized).length,
        corrected: results.filter((result) => result.corrected).length,
        stale: results.filter((result) => result.stale || result.state === 'stale_pending').length,
        providerErrors: results.filter((result) => result.providerError).length,
    };
}

module.exports = {
    DEFAULT_MIN_STABLE_MS,
    DEFAULT_STALE_AFTER_MS,
    RETRY_DELAYS_MS,
    VapiUsageReconcileError,
    snapshotHash,
    jitteredDelayMs,
    nextAttemptAt,
    listDueCompanies,
    getOperationalMetrics,
    getOperationalMetricsWithClient,
    ensureEndedSessionsHaveUsage,
    claimDueWithClient,
    recordProviderFailureWithClient,
    applyAuthoritativeWithClient,
    processClaim,
    processDueCompany,
};
