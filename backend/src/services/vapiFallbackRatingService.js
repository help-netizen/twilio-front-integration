'use strict';

const db = require('../db/connection');
const { withTransaction } = require('./transactionService');

const DEFAULT_RATE_PER_STARTED_MINUTE = '0.25';
const RATE_LOCK_KEY = 'vapi:fallback-rate-policy';

class VapiFallbackRatingError extends Error {
    constructor(code) {
        super(code);
        this.name = 'VapiFallbackRatingError';
        this.code = code;
    }
}

function normalizePositiveDecimal(value, fallback = DEFAULT_RATE_PER_STARTED_MINUTE) {
    const candidate = value === undefined || value === null || value === ''
        ? fallback
        : String(value).trim();
    const match = candidate.match(/^(\d+)(?:\.(\d+))?$/);
    if (!match) throw new VapiFallbackRatingError('VAPI_FALLBACK_RATE_INVALID');
    let whole = match[1].replace(/^0+(?=\d)/, '');
    let fraction = (match[2] || '').replace(/0+$/, '');
    if (fraction.length > 12) {
        throw new VapiFallbackRatingError('VAPI_FALLBACK_RATE_SCALE_EXCEEDED');
    }
    if (/^0+$/.test(whole) && fraction === '') {
        throw new VapiFallbackRatingError('VAPI_FALLBACK_RATE_NOT_POSITIVE');
    }
    if (whole === '') whole = '0';
    return fraction ? `${whole}.${fraction}` : whole;
}

function configuredRate(env = process.env) {
    return normalizePositiveDecimal(env.VAPI_FALLBACK_RATE_PER_MINUTE);
}

function requiredCompanyId(companyId) {
    if (typeof companyId !== 'string' || companyId.trim() === '') {
        throw new VapiFallbackRatingError('VAPI_FALLBACK_COMPANY_REQUIRED');
    }
    return companyId.trim();
}

async function ensureConfiguredRateWithClient({ now = new Date(), rate }, client) {
    const normalizedRate = normalizePositiveDecimal(rate);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [RATE_LOCK_KEY]);
    const current = await client.query(
        `SELECT *
         FROM vapi_fallback_rate_policies
         WHERE effective_to IS NULL
         ORDER BY version DESC
         LIMIT 1
         FOR UPDATE`,
    );
    if (current.rows[0]
        && normalizePositiveDecimal(current.rows[0].rate_per_started_minute)
            === normalizedRate) {
        return current.rows[0];
    }
    if (current.rows[0]) {
        const effectiveFrom = new Date(current.rows[0].effective_from).getTime();
        if (Number.isFinite(effectiveFrom) && now.getTime() <= effectiveFrom) {
            throw new VapiFallbackRatingError('VAPI_FALLBACK_POLICY_TIME_NOT_ADVANCING');
        }
        await client.query(
            `UPDATE vapi_fallback_rate_policies
             SET effective_to = $2
             WHERE id = $1 AND effective_to IS NULL`,
            [current.rows[0].id, now],
        );
    }
    const inserted = await client.query(
        `INSERT INTO vapi_fallback_rate_policies (
             rate_per_started_minute, effective_from, source
         ) VALUES ($1::numeric, $2, 'runtime_config')
         RETURNING *`,
        [normalizedRate, now],
    );
    return inserted.rows[0];
}

async function createFallbackEstimatesWithClient({ companyId, now = new Date() }, client) {
    const scopedCompanyId = requiredCompanyId(companyId);
    const inserted = await client.query(
        `WITH candidates AS (
             SELECT usage.company_id, usage.vapi_call_session_id,
                    session.admitted_at,
                    COALESCE(
                        usage.duration_seconds,
                        CASE
                            WHEN session.started_at IS NOT NULL
                             AND session.ended_at IS NOT NULL
                             AND session.ended_at >= session.started_at
                            THEN EXTRACT(EPOCH FROM (
                                session.ended_at - session.started_at
                            ))::numeric
                            ELSE NULL
                        END
                    )::numeric(18,6) AS duration_seconds
             FROM vapi_call_usage usage
             JOIN vapi_call_sessions session
               ON session.id = usage.vapi_call_session_id
              AND session.company_id = usage.company_id
             WHERE usage.state IN ('stale_pending', 'quarantined')
               AND usage.company_id = $2
               AND usage.supplier_cost IS NULL
               AND NOT EXISTS (
                   SELECT 1
                   FROM vapi_call_usage_final_snapshots snapshot
                   WHERE snapshot.vapi_call_session_id = usage.vapi_call_session_id
                     AND snapshot.company_id = usage.company_id
               )
               AND NOT EXISTS (
                   SELECT 1
                   FROM vapi_call_cost_input_events event
                   WHERE event.vapi_call_session_id = usage.vapi_call_session_id
                     AND event.event_kind = 'fallback_estimate'
               )
         ), rated AS (
             SELECT candidate.*,
                    policy.id AS policy_id,
                    policy.rate_per_started_minute,
                    GREATEST(
                        1::bigint,
                        CEIL(candidate.duration_seconds / 60::numeric)::bigint
                    ) AS billed_minutes
             FROM candidates candidate
             JOIN LATERAL (
                 SELECT policy.*
                 FROM vapi_fallback_rate_policies policy
                 WHERE policy.effective_from <= candidate.admitted_at
                   AND (
                       policy.effective_to IS NULL
                       OR candidate.admitted_at < policy.effective_to
                   )
                 ORDER BY policy.effective_from DESC, policy.version DESC
                 LIMIT 1
             ) policy ON true
             WHERE candidate.duration_seconds IS NOT NULL
               AND candidate.duration_seconds >= 0
         )
         INSERT INTO vapi_call_cost_input_events (
             company_id, vapi_call_session_id, input_version, event_kind,
             fallback_rate_policy_id, supplier_snapshot_version,
             duration_seconds, billed_started_minutes, rate_per_started_minute,
             amount_delta, effective_supplier_cost, is_estimate, state, created_at
         )
         SELECT company_id, vapi_call_session_id, 1, 'fallback_estimate',
                policy_id, NULL, duration_seconds, billed_minutes,
                rate_per_started_minute,
                billed_minutes::numeric * rate_per_started_minute,
                billed_minutes::numeric * rate_per_started_minute,
                true, 'pending_pricing', $1
         FROM rated
         ON CONFLICT (vapi_call_session_id, input_version) DO NOTHING
         RETURNING *`,
        [now, scopedCompanyId],
    );

    if (inserted.rows.length > 0) {
        await client.query(
            `UPDATE vapi_usage_alerts alert
             SET supplier_cost_at_risk = estimate.effective_supplier_cost,
                 cost_basis = 'fallback_estimate',
                 updated_at = $2
             FROM vapi_call_cost_input_events estimate
             WHERE estimate.vapi_call_session_id = alert.vapi_call_session_id
               AND estimate.company_id = alert.company_id
               AND estimate.event_kind = 'fallback_estimate'
               AND alert.vapi_call_session_id = ANY($1::uuid[])
               AND alert.resolved_at IS NULL
               AND alert.supplier_cost_at_risk IS NULL`,
            [inserted.rows.map((row) => row.vapi_call_session_id), now],
        );
    }
    return inserted.rows;
}

async function createSupplierCorrectionsWithClient({ companyId, now = new Date() }, client) {
    const scopedCompanyId = requiredCompanyId(companyId);
    const inserted = await client.query(
        `WITH estimates AS (
             SELECT event.*
             FROM vapi_call_cost_input_events event
             WHERE event.event_kind = 'fallback_estimate'
               AND event.company_id = $2
         )
         INSERT INTO vapi_call_cost_input_events (
             company_id, vapi_call_session_id, input_version, event_kind,
             fallback_rate_policy_id, supplier_snapshot_version,
             duration_seconds, billed_started_minutes, rate_per_started_minute,
             amount_delta, effective_supplier_cost, is_estimate, state, created_at
         )
         SELECT estimate.company_id, estimate.vapi_call_session_id,
                snapshot.snapshot_version + 1, 'supplier_actual_correction',
                estimate.fallback_rate_policy_id, snapshot.snapshot_version,
                estimate.duration_seconds, estimate.billed_started_minutes,
                estimate.rate_per_started_minute,
                CASE
                    WHEN snapshot.snapshot_version = 1
                    THEN snapshot.supplier_cost - estimate.effective_supplier_cost
                    ELSE snapshot.supplier_cost_delta
                END,
                snapshot.supplier_cost, false, 'pending_pricing', $1
         FROM estimates estimate
         JOIN vapi_call_usage_final_snapshots snapshot
           ON snapshot.vapi_call_session_id = estimate.vapi_call_session_id
          AND snapshot.company_id = estimate.company_id
         ON CONFLICT (vapi_call_session_id, input_version) DO NOTHING
         RETURNING *`,
        [now, scopedCompanyId],
    );
    if (inserted.rows.length > 0) {
        await client.query(
            `UPDATE vapi_usage_alerts alert
             SET resolved_at = COALESCE(alert.resolved_at, $2),
                 updated_at = $2
             WHERE alert.vapi_call_session_id = ANY($1::uuid[])
               AND alert.kind IN (
                   'stale_pending', 'local_missing',
                   'late_correction_stale', 'quarantined'
               )`,
            [[...new Set(inserted.rows.map((row) => row.vapi_call_session_id))], now],
        );
    }
    return inserted.rows;
}

async function listDueCompanies(_now = new Date(), client = db) {
    const result = await client.query(
        `SELECT company_id
         FROM (
             SELECT usage.company_id
             FROM vapi_call_usage usage
             JOIN vapi_call_sessions session
               ON session.id = usage.vapi_call_session_id
              AND session.company_id = usage.company_id
             WHERE usage.state IN ('stale_pending', 'quarantined')
               AND usage.supplier_cost IS NULL
               AND (
                   usage.duration_seconds IS NOT NULL
                   OR (
                       session.started_at IS NOT NULL
                       AND session.ended_at IS NOT NULL
                       AND session.ended_at >= session.started_at
                   )
               )
               AND NOT EXISTS (
                   SELECT 1
                   FROM vapi_call_usage_final_snapshots snapshot
                   WHERE snapshot.vapi_call_session_id = usage.vapi_call_session_id
                     AND snapshot.company_id = usage.company_id
               )
               AND NOT EXISTS (
                   SELECT 1
                   FROM vapi_call_cost_input_events event
                   WHERE event.vapi_call_session_id = usage.vapi_call_session_id
                     AND event.event_kind = 'fallback_estimate'
               )
             UNION
             SELECT estimate.company_id
             FROM vapi_call_cost_input_events estimate
             JOIN vapi_call_usage_final_snapshots snapshot
               ON snapshot.vapi_call_session_id = estimate.vapi_call_session_id
              AND snapshot.company_id = estimate.company_id
             WHERE estimate.event_kind = 'fallback_estimate'
               AND NOT EXISTS (
                   SELECT 1
                   FROM vapi_call_cost_input_events correction
                   WHERE correction.vapi_call_session_id = estimate.vapi_call_session_id
                     AND correction.input_version = snapshot.snapshot_version + 1
               )
         ) candidates
         GROUP BY company_id
         ORDER BY company_id`,
    );
    return result.rows.map((row) => row.company_id);
}

async function syncConfiguredRate(options = {}) {
    const now = options.now || new Date();
    const rate = options.rate === undefined ? configuredRate(options.env) : options.rate;
    return withTransaction((client) => ensureConfiguredRateWithClient({ now, rate }, client));
}

async function processCompanyWithClient(options = {}, client) {
    const now = options.now || new Date();
    const companyId = requiredCompanyId(options.companyId);
    const rate = options.rate === undefined ? configuredRate(options.env) : options.rate;
    const policy = await ensureConfiguredRateWithClient({ now, rate }, client);
    const estimates = await createFallbackEstimatesWithClient({ companyId, now }, client);
    const corrections = await createSupplierCorrectionsWithClient({ companyId, now }, client);
    return {
        companyId,
        policyVersion: String(policy.version),
        estimatesCreated: estimates.length,
        correctionsCreated: corrections.length,
    };
}

async function processCompany(companyId, options = {}) {
    const scopedCompanyId = requiredCompanyId(companyId);
    return withTransaction((client) => processCompanyWithClient({
        ...options,
        companyId: scopedCompanyId,
    }, client));
}

module.exports = {
    DEFAULT_RATE_PER_STARTED_MINUTE,
    VapiFallbackRatingError,
    normalizePositiveDecimal,
    configuredRate,
    requiredCompanyId,
    ensureConfiguredRateWithClient,
    createFallbackEstimatesWithClient,
    createSupplierCorrectionsWithClient,
    listDueCompanies,
    syncConfiguredRate,
    processCompanyWithClient,
    processCompany,
};
