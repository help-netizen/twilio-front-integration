'use strict';

const crypto = require('crypto');
const { withTransaction } = require('./transactionService');
const vapiAssistantRegistry = require('./vapiAssistantRegistryService');

const DEFAULT_TOKEN_TTL_SECONDS = 300;
const DEFAULT_OUTBOUND_PROVIDER_PENDING_MAX_AGE_MINUTES = 30;
const TOKEN_HEADER = 'x-albusto-call-token';
const PLATFORM_PROVIDER_ACCOUNT_KEY = 'vapi:platform';
const PURPOSE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BIND_SOURCES = new Set([
    'assistant_request',
    'status_update',
    'end_of_call_report',
]);

class VapiIdentityError extends Error {
    constructor(code, status = 409) {
        super(code);
        this.name = 'VapiIdentityError';
        this.code = code;
        this.status = status;
    }
}

function assertNonEmpty(value, code, maxLength = 255) {
    if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
        throw new VapiIdentityError(code, 400);
    }
    return value.trim();
}

function normalizePurpose(value) {
    const purpose = assertNonEmpty(value, 'VAPI_IDENTITY_PURPOSE_REQUIRED', 64);
    if (!PURPOSE_PATTERN.test(purpose)) {
        throw new VapiIdentityError('VAPI_IDENTITY_PURPOSE_INVALID', 400);
    }
    return purpose;
}

function tokenTtlSeconds() {
    const raw = process.env.VAPI_CORRELATION_TOKEN_TTL_SECONDS;
    if (raw === undefined) return DEFAULT_TOKEN_TTL_SECONDS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < 30 || parsed > 900) {
        throw new VapiIdentityError('VAPI_IDENTITY_TOKEN_TTL_INVALID', 503);
    }
    return parsed;
}

function generateToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function identityAlert(code, details) {
    const safe = {
        code,
        companyId: details.companyId,
        sessionId: details.sessionId || null,
        providerCallId: details.providerCallId || null,
    };
    console.error('[VAPI_IDENTITY_ALERT]', safe);
}

function normalizeAttemptId(value) {
    const normalized = assertNonEmpty(
        String(value ?? ''),
        'VAPI_IDENTITY_OUTBOUND_ATTEMPT_REQUIRED',
        32,
    );
    if (!/^\d+$/.test(normalized) || normalized === '0') {
        throw new VapiIdentityError('VAPI_IDENTITY_OUTBOUND_ATTEMPT_INVALID', 400);
    }
    return normalized;
}

function sanitizeSubscriptionLimits(value, depth = 0) {
    if (value === undefined || value === null) return null;
    if (depth > 3) return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') {
        return /^-?\d+(?:\.\d+)?$/.test(value) && value.length <= 40
            ? value
            : undefined;
    }
    if (Array.isArray(value)) {
        if (value.length > 32) return undefined;
        const items = value
            .map((item) => sanitizeSubscriptionLimits(item, depth + 1))
            .filter((item) => item !== undefined);
        return items;
    }
    if (typeof value !== 'object') return undefined;
    const entries = Object.entries(value);
    if (entries.length > 64) return undefined;
    const sanitized = {};
    for (const [key, item] of entries) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
        const normalized = sanitizeSubscriptionLimits(item, depth + 1);
        if (normalized !== undefined) sanitized[key] = normalized;
    }
    return sanitized;
}

async function reserveOutboundSessionWithClient({
    companyId,
    outboundCallAttemptId,
    environment = 'prod',
}, client) {
    const normalizedCompanyId = assertNonEmpty(
        companyId,
        'VAPI_IDENTITY_COMPANY_REQUIRED',
        64,
    );
    const attemptId = normalizeAttemptId(outboundCallAttemptId);
    const normalizedEnvironment = assertNonEmpty(
        environment,
        'VAPI_IDENTITY_ENVIRONMENT_REQUIRED',
        32,
    );

    await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`,
        [normalizedCompanyId, attemptId],
    );
    const attemptResult = await client.query(
        `SELECT id, company_id, scenario, status, vapi_call_id
         FROM outbound_call_attempts
         WHERE id = $1
           AND company_id = $2
         LIMIT 2
         FOR UPDATE`,
        [attemptId, normalizedCompanyId],
    );
    if (attemptResult.rows.length !== 1) {
        throw new VapiIdentityError('VAPI_IDENTITY_OUTBOUND_ATTEMPT_SCOPE_MISMATCH', 409);
    }
    const attempt = attemptResult.rows[0];
    if (attempt.status !== 'dialing') {
        throw new VapiIdentityError('VAPI_IDENTITY_OUTBOUND_ATTEMPT_NOT_DIALING', 409);
    }
    const purpose = vapiAssistantRegistry.purposeForOutboundScenario(attempt.scenario);

    const existingResult = await client.query(
        `SELECT id, company_id, state, vapi_call_id, expected_vapi_assistant_id
         FROM vapi_call_sessions
         WHERE company_id = $1
           AND direction = 'outbound'
           AND outbound_call_attempt_id = $2
         LIMIT 2
         FOR UPDATE`,
        [normalizedCompanyId, attemptId],
    );
    if (existingResult.rows.length > 1) {
        throw new VapiIdentityError('VAPI_IDENTITY_OUTBOUND_SESSION_AMBIGUOUS', 409);
    }
    if (existingResult.rows.length === 1) {
        const existing = existingResult.rows[0];
        if (existing.vapi_call_id && attempt.vapi_call_id === existing.vapi_call_id) {
            return {
                sessionId: String(existing.id),
                companyId: existing.company_id,
                providerCallId: existing.vapi_call_id,
                assistantId: existing.expected_vapi_assistant_id,
                alreadyBound: true,
            };
        }
        if (existing.state === 'provider_pending' && !existing.vapi_call_id) {
            return {
                sessionId: String(existing.id),
                companyId: existing.company_id,
                providerPending: true,
            };
        }
        throw new VapiIdentityError('VAPI_IDENTITY_OUTBOUND_SESSION_TERMINAL', 409);
    }
    if (attempt.vapi_call_id) {
        throw new VapiIdentityError('VAPI_IDENTITY_OUTBOUND_ATTEMPT_ALREADY_BOUND', 409);
    }

    let selected;
    try {
        selected = await vapiAssistantRegistry.resolveOutboundTuple({
            companyId: normalizedCompanyId,
            purpose,
            environment: normalizedEnvironment,
            client,
        });
    } catch (error) {
        if (error instanceof vapiAssistantRegistry.VapiAssistantRegistryError) {
            throw new VapiIdentityError('VAPI_IDENTITY_OUTBOUND_TUPLE_UNAVAILABLE', 409);
        }
        throw error;
    }

    const inserted = await client.query(
        `INSERT INTO vapi_call_sessions (
             company_id,
             direction,
             purpose,
             environment,
             provider_connection_id,
             assistant_profile_id,
             tenant_resource_id,
             provider_account_key,
             expected_vapi_assistant_id,
             outbound_call_attempt_id,
             state
         ) VALUES (
             $1, 'outbound', $2, $3, $4, $5, $6, $7, $8, $9, 'provider_pending'
         )
         RETURNING id, company_id, admitted_at`,
        [
            normalizedCompanyId,
            purpose,
            normalizedEnvironment,
            selected.provider_connection_id,
            selected.assistant_profile_id,
            selected.tenant_resource_id,
            PLATFORM_PROVIDER_ACCOUNT_KEY,
            selected.expected_vapi_assistant_id,
            attemptId,
        ],
    );
    return {
        sessionId: String(inserted.rows[0].id),
        companyId: inserted.rows[0].company_id,
        admittedAt: inserted.rows[0].admitted_at,
        purpose,
        assistantId: selected.expected_vapi_assistant_id,
        resourceType: selected.resource_type,
        phoneNumberId: selected.vapi_phone_number_id || null,
        twilioPhoneNumber: selected.twilio_phone_number || null,
    };
}

async function reserveOutboundSession(input) {
    try {
        return await withTransaction((client) => reserveOutboundSessionWithClient(input, client));
    } catch (error) {
        identityAlert(error?.code || 'VAPI_IDENTITY_OUTBOUND_RESERVATION_FAILED', {
            companyId: input.companyId,
            sessionId: null,
            providerCallId: null,
        });
        throw error;
    }
}

async function bindOutboundPlacementWithClient({
    companyId,
    sessionId,
    outboundCallAttemptId,
    providerCallId,
    subscriptionLimits,
    slotJson,
    allowTerminalRepair = false,
}, client) {
    const normalizedCompanyId = assertNonEmpty(
        companyId,
        'VAPI_IDENTITY_COMPANY_REQUIRED',
        64,
    );
    const normalizedSessionId = assertNonEmpty(
        sessionId,
        'VAPI_IDENTITY_SESSION_REQUIRED',
        64,
    );
    const attemptId = normalizeAttemptId(outboundCallAttemptId);
    const normalizedProviderCallId = assertNonEmpty(
        providerCallId,
        'VAPI_IDENTITY_PROVIDER_CALL_REQUIRED',
        128,
    );
    const limits = sanitizeSubscriptionLimits(subscriptionLimits);

    const sessionResult = await client.query(
        `SELECT id, company_id, purpose, state, vapi_call_id,
                outbound_call_attempt_id, expected_vapi_assistant_id,
                quarantine_reason
         FROM vapi_call_sessions
         WHERE id = $1
           AND company_id = $2
           AND direction = 'outbound'
           AND outbound_call_attempt_id = $3
         LIMIT 2
         FOR UPDATE`,
        [normalizedSessionId, normalizedCompanyId, attemptId],
    );
    if (sessionResult.rows.length !== 1) {
        throw new VapiIdentityError('VAPI_IDENTITY_OUTBOUND_SESSION_SCOPE_MISMATCH', 409);
    }
    const session = sessionResult.rows[0];

    const attemptResult = await client.query(
        `SELECT id, company_id, scenario, status, vapi_call_id, reason
         FROM outbound_call_attempts
         WHERE id = $1
           AND company_id = $2
         LIMIT 2
         FOR UPDATE`,
        [attemptId, normalizedCompanyId],
    );
    if (attemptResult.rows.length !== 1) {
        throw new VapiIdentityError('VAPI_IDENTITY_OUTBOUND_ATTEMPT_SCOPE_MISMATCH', 409);
    }
    const attempt = attemptResult.rows[0];
    if (vapiAssistantRegistry.purposeForOutboundScenario(attempt.scenario) !== session.purpose) {
        throw new VapiIdentityError('VAPI_IDENTITY_OUTBOUND_PURPOSE_DRIFT', 409);
    }

    if (session.vapi_call_id || attempt.vapi_call_id) {
        if (
            session.vapi_call_id === normalizedProviderCallId
            && attempt.vapi_call_id === normalizedProviderCallId
        ) {
            return {
                ok: true,
                idempotent: true,
                sessionId: String(session.id),
                companyId: session.company_id,
                providerCallId: normalizedProviderCallId,
            };
        }
        throw new VapiIdentityError('VAPI_IDENTITY_OUTBOUND_PROVIDER_RESPONSE_CONFLICT', 409);
    }
    const isPendingBind = session.state === 'provider_pending' && attempt.status === 'dialing';
    const isTerminalRepair = Boolean(
        allowTerminalRepair
        && session.state === 'quarantined'
        && session.quarantine_reason === 'provider_outcome_unresolved'
        && attempt.status === 'exhausted'
        && attempt.reason === 'provider_outcome_unresolved',
    );
    if (!isPendingBind && !isTerminalRepair) {
        throw new VapiIdentityError('VAPI_IDENTITY_OUTBOUND_BIND_STATE_INVALID', 409);
    }

    await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [normalizedProviderCallId],
    );
    const collision = await client.query(
        `SELECT session.id, session.company_id
         FROM vapi_call_sessions session
         WHERE session.vapi_call_id = $1
           AND session.id <> $2
         UNION ALL
         SELECT '00000000-0000-0000-0000-000000000000'::uuid, attempt.company_id
         FROM outbound_call_attempts attempt
         WHERE attempt.vapi_call_id = $1
           AND attempt.id <> $3
         LIMIT 2`,
        [normalizedProviderCallId, normalizedSessionId, attemptId],
    );
    if (collision.rows.length > 0) {
        throw new VapiIdentityError('VAPI_IDENTITY_PROVIDER_CALL_COLLISION', 409);
    }

    const slotValue = slotJson === undefined ? null : JSON.stringify(slotJson);
    const limitsValue = limits === null || limits === undefined
        ? null
        : JSON.stringify(limits);
    const boundSession = await client.query(
        `UPDATE vapi_call_sessions
         SET vapi_call_id = $3,
             bind_source = 'post_call_response',
             bound_at = now(),
             state = 'active',
             quarantine_reason = NULL,
             quarantined_at = NULL,
             provider_subscription_limits = COALESCE($4::jsonb, provider_subscription_limits),
             provider_placement_observed_at = now()
         WHERE id = $1
           AND company_id = $2
           AND state = $5
           AND ($6::text IS NULL OR quarantine_reason = $6)
           AND vapi_call_id IS NULL
         RETURNING id`,
        [
            normalizedSessionId,
            normalizedCompanyId,
            normalizedProviderCallId,
            limitsValue,
            isTerminalRepair ? 'quarantined' : 'provider_pending',
            isTerminalRepair ? 'provider_outcome_unresolved' : null,
        ],
    );
    const boundAttempt = await client.query(
        `UPDATE outbound_call_attempts
         SET vapi_call_id = $3,
             slot_json = COALESCE($4::jsonb, slot_json),
             updated_at = now()
         WHERE id = $1
           AND company_id = $2
           AND status = $5
           AND ($6::text IS NULL OR reason = $6)
           AND vapi_call_id IS NULL
         RETURNING id`,
        [
            attemptId,
            normalizedCompanyId,
            normalizedProviderCallId,
            slotValue,
            isTerminalRepair ? 'exhausted' : 'dialing',
            isTerminalRepair ? 'provider_outcome_unresolved' : null,
        ],
    );
    if (boundSession.rows.length !== 1 || boundAttempt.rows.length !== 1) {
        throw new VapiIdentityError('VAPI_IDENTITY_OUTBOUND_ATOMIC_BIND_FAILED', 409);
    }
    return {
        ok: true,
        idempotent: false,
        sessionId: String(session.id),
        companyId: session.company_id,
        providerCallId: normalizedProviderCallId,
        terminalRepair: isTerminalRepair,
    };
}

async function bindOutboundPlacement(input) {
    try {
        return await withTransaction((client) => bindOutboundPlacementWithClient(input, client));
    } catch (error) {
        identityAlert(error?.code || 'VAPI_IDENTITY_OUTBOUND_BIND_FAILED', {
            companyId: input.companyId,
            sessionId: input.sessionId,
            providerCallId: input.providerCallId,
        });
        throw error;
    }
}

async function quarantineOutboundReservationWithClient({
    companyId,
    sessionId,
    outboundCallAttemptId,
    reason,
}, client) {
    const normalizedCompanyId = assertNonEmpty(companyId, 'VAPI_IDENTITY_COMPANY_REQUIRED', 64);
    const normalizedSessionId = assertNonEmpty(sessionId, 'VAPI_IDENTITY_SESSION_REQUIRED', 64);
    const attemptId = normalizeAttemptId(outboundCallAttemptId);
    const normalizedReason = assertNonEmpty(reason, 'VAPI_IDENTITY_QUARANTINE_REASON_REQUIRED', 120);
    await client.query(
        `UPDATE vapi_call_sessions
         SET state = 'quarantined',
             quarantine_reason = $4,
             quarantined_at = now()
         WHERE id = $1
           AND company_id = $2
           AND outbound_call_attempt_id = $3
           AND direction = 'outbound'
           AND state = 'provider_pending'
           AND vapi_call_id IS NULL`,
        [normalizedSessionId, normalizedCompanyId, attemptId, normalizedReason],
    );
}

async function quarantineOutboundReservation(input) {
    return withTransaction((client) => quarantineOutboundReservationWithClient(input, client));
}

async function reapStaleOutboundPlacementsWithClient({
    maxAgeMinutes = DEFAULT_OUTBOUND_PROVIDER_PENDING_MAX_AGE_MINUTES,
    limit = 100,
} = {}, client) {
    if (!Number.isInteger(maxAgeMinutes) || maxAgeMinutes < 1 || maxAgeMinutes > 1440) {
        throw new VapiIdentityError('VAPI_IDENTITY_PROVIDER_PENDING_AGE_INVALID', 500);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new VapiIdentityError('VAPI_IDENTITY_PROVIDER_PENDING_LIMIT_INVALID', 500);
    }
    const result = await client.query(
        // tenant-safety-allow R-worker: this platform worker intentionally sweeps
        // all tenants, but derives company only from the joined local rows and
        // performs both terminal writes with that same company_id.
        `WITH candidates AS (
             SELECT session.id AS session_id,
                    session.company_id,
                    session.outbound_call_attempt_id AS attempt_id,
                    attempt.job_id,
                    attempt.task_id,
                    attempt.contact_id,
                    attempt.phone,
                    attempt.attempt_no,
                    attempt.scenario,
                    attempt.lead_uuid,
                    attempt.slot_json
             FROM vapi_call_sessions session
             JOIN outbound_call_attempts attempt
               ON attempt.id = session.outbound_call_attempt_id
              AND attempt.company_id = session.company_id
             WHERE session.direction = 'outbound'
               AND session.state = 'provider_pending'
               AND session.vapi_call_id IS NULL
               AND attempt.status = 'dialing'
               AND attempt.vapi_call_id IS NULL
               AND session.admitted_at <= now() - make_interval(mins => $1)
             ORDER BY session.admitted_at, session.id
             LIMIT $2
             FOR UPDATE OF session, attempt SKIP LOCKED
         ), quarantined AS (
             UPDATE vapi_call_sessions session
             SET state = 'quarantined',
                 quarantine_reason = 'provider_outcome_unresolved',
                 quarantined_at = now(),
                 updated_at = now()
             FROM candidates candidate
             WHERE session.id = candidate.session_id
               AND session.company_id = candidate.company_id
               AND session.state = 'provider_pending'
               AND session.vapi_call_id IS NULL
             RETURNING session.id
         ), exhausted AS (
             UPDATE outbound_call_attempts attempt
             SET status = 'exhausted',
                 reason = 'provider_outcome_unresolved',
                 updated_at = now()
             FROM candidates candidate
             WHERE attempt.id = candidate.attempt_id
               AND attempt.company_id = candidate.company_id
               AND attempt.status = 'dialing'
               AND attempt.vapi_call_id IS NULL
             RETURNING attempt.id
         )
         SELECT candidate.*
         FROM candidates candidate
         JOIN quarantined ON quarantined.id = candidate.session_id
         JOIN exhausted ON exhausted.id = candidate.attempt_id
         ORDER BY candidate.attempt_id`,
        [maxAgeMinutes, limit],
    );
    return result.rows;
}

async function reapStaleOutboundPlacements(options = {}) {
    const { onExhaustedWithClient = null, ...queryOptions } = options;
    return withTransaction(async (client) => {
        const exhausted = await reapStaleOutboundPlacementsWithClient(queryOptions, client);
        if (onExhaustedWithClient) {
            for (const attempt of exhausted) {
                // The human follow-up and the terminal attempt/session transition
                // are one commit. A follow-up failure rolls the terminal state back
                // so the next sweep can retry the whole durable unit.
                await onExhaustedWithClient(attempt, client);
            }
        }
        return exhausted;
    });
}

async function reserveInboundSessionWithClient({
    companyId,
    twilioParentCallSid,
    flowExecutionId,
    flowNodeId,
    purpose = 'inbound_call',
    environment = 'prod',
}, client) {
    const normalizedCompanyId = assertNonEmpty(
        companyId,
        'VAPI_IDENTITY_COMPANY_REQUIRED',
        64,
    );
    const parentSid = assertNonEmpty(
        twilioParentCallSid,
        'VAPI_IDENTITY_PARENT_SID_REQUIRED',
        128,
    );
    const executionId = assertNonEmpty(
        flowExecutionId,
        'VAPI_IDENTITY_FLOW_EXECUTION_REQUIRED',
        128,
    );
    const nodeId = assertNonEmpty(flowNodeId, 'VAPI_IDENTITY_FLOW_NODE_REQUIRED', 128);
    const normalizedPurpose = normalizePurpose(purpose);
    const normalizedEnvironment = assertNonEmpty(
        environment,
        'VAPI_IDENTITY_ENVIRONMENT_REQUIRED',
        32,
    );

    const execution = await client.query(
        `SELECT id
         FROM call_flow_executions
         WHERE id = $1
           AND company_id::text = $2::text
           AND call_sid = $3
         LIMIT 2
         FOR SHARE`,
        [executionId, normalizedCompanyId, parentSid],
    );
    if (execution.rows.length !== 1) {
        throw new VapiIdentityError('VAPI_IDENTITY_FLOW_SCOPE_MISMATCH', 409);
    }

    let selected;
    try {
        selected = await vapiAssistantRegistry.resolveInboundTuple({
            companyId: normalizedCompanyId,
            purpose: normalizedPurpose,
            environment: normalizedEnvironment,
            client,
        });
    } catch (error) {
        if (error instanceof vapiAssistantRegistry.VapiAssistantRegistryError) {
            throw new VapiIdentityError('VAPI_IDENTITY_TUPLE_UNAVAILABLE', 409);
        }
        throw error;
    }

    await client.query(
        `SELECT pg_advisory_xact_lock(
             hashtextextended($1 || ':' || $2 || ':' || $3, 0)
         )`,
        [normalizedCompanyId, executionId, nodeId],
    );

    const inFlight = await client.query(
        `SELECT id
         FROM vapi_call_sessions
         WHERE company_id = $1
           AND direction = 'inbound'
           AND flow_execution_id = $2
           AND flow_node_id = $3
           AND vapi_call_id IS NULL
           AND state IN ('created', 'admitted', 'provider_pending')
           AND correlation_expires_at > now()
         LIMIT 2
         FOR UPDATE`,
        [normalizedCompanyId, executionId, nodeId],
    );
    if (inFlight.rows.length > 0) {
        throw new VapiIdentityError('VAPI_IDENTITY_RESERVATION_IN_FLIGHT', 409);
    }

    await client.query(
        `UPDATE vapi_call_sessions
         SET state = 'quarantined',
             quarantine_reason = 'expired_before_redial',
             quarantined_at = now(),
             correlation_expires_at = LEAST(correlation_expires_at, now())
         WHERE company_id = $1
           AND direction = 'inbound'
           AND flow_execution_id = $2
           AND flow_node_id = $3
           AND vapi_call_id IS NULL
           AND state IN ('created', 'admitted', 'provider_pending')
           AND correlation_expires_at <= now()`,
        [normalizedCompanyId, executionId, nodeId],
    );

    const token = generateToken();
    const tokenHash = hashToken(token);
    const ttlSeconds = tokenTtlSeconds();
    const inserted = await client.query(
        `INSERT INTO vapi_call_sessions (
             company_id,
             direction,
             purpose,
             environment,
             provider_connection_id,
             assistant_profile_id,
             tenant_resource_id,
             assistant_request_credential_id,
             provider_account_key,
             expected_vapi_assistant_id,
             twilio_parent_call_sid,
             flow_execution_id,
             flow_node_id,
             correlation_token_hash,
             correlation_expires_at,
             state
         ) VALUES (
             $1, 'inbound', $2, $3, $4, $5, $6, $7, $8, $9,
             $10, $11, $12, $13, now() + ($14 * interval '1 second'), 'admitted'
         )
         RETURNING id, company_id, correlation_expires_at, admitted_at`,
        [
            normalizedCompanyId,
            normalizedPurpose,
            normalizedEnvironment,
            selected.provider_connection_id,
            selected.assistant_profile_id,
            selected.tenant_resource_id,
            selected.assistant_request_credential_id,
            PLATFORM_PROVIDER_ACCOUNT_KEY,
            selected.expected_vapi_assistant_id,
            parentSid,
            executionId,
            nodeId,
            tokenHash,
            ttlSeconds,
        ],
    );

    const missingOperationalSurfaces = [
        selected.tools_credential_ready === true
            ? null
            : { surface: 'vapi_tools', reason: 'vapi_tools_credential_unavailable' },
        selected.call_status_credential_ready === true
            ? null
            : { surface: 'vapi_call_status', reason: 'call_status_credential_unavailable' },
    ].filter(Boolean);
    for (const missing of missingOperationalSurfaces) {
        await client.query('SAVEPOINT vapi_identity_accounting_alert');
        try {
            await client.query(
                `INSERT INTO vapi_usage_alerts (
                     company_id, vapi_call_session_id, kind, dedupe_key, details
                 ) VALUES (
                     $1, $2, 'local_missing', $3, $4::jsonb
                 )
                 ON CONFLICT (dedupe_key) DO UPDATE
                 SET details = EXCLUDED.details,
                     resolved_at = NULL
                 WHERE vapi_usage_alerts.details IS DISTINCT FROM EXCLUDED.details
                    OR vapi_usage_alerts.resolved_at IS NOT NULL`,
                [
                    normalizedCompanyId,
                    inserted.rows[0].id,
                    `local_missing:${inserted.rows[0].id}:${missing.surface}_credential`,
                    JSON.stringify({ reason: missing.reason }),
                ],
            );
            await client.query('RELEASE SAVEPOINT vapi_identity_accounting_alert');
        } catch (_alertError) {
            await client.query('ROLLBACK TO SAVEPOINT vapi_identity_accounting_alert');
            await client.query('RELEASE SAVEPOINT vapi_identity_accounting_alert');
        }
        identityAlert(missing.reason, {
            companyId: normalizedCompanyId,
            sessionId: inserted.rows[0].id,
            providerCallId: null,
        });
    }

    return {
        sessionId: String(inserted.rows[0].id),
        companyId: inserted.rows[0].company_id,
        correlationToken: token,
        correlationExpiresAt: inserted.rows[0].correlation_expires_at,
        admittedAt: inserted.rows[0].admitted_at,
        sipUri: selected.sip_uri,
    };
}

async function reserveInboundSession(input) {
    return withTransaction((client) => reserveInboundSessionWithClient(input, client));
}

async function quarantineSession(client, session, reason) {
    await client.query(
        `UPDATE vapi_call_sessions
         SET state = 'quarantined',
             quarantine_reason = $3,
             quarantined_at = now()
         WHERE id = $1
           AND company_id = $2`,
        [session.id, session.company_id, reason],
    );
    return {
        ok: false,
        code: reason,
        status: reason === 'credential_mismatch' ? 403 : 409,
        sessionId: String(session.id),
        companyId: session.company_id,
    };
}

async function bindInboundCallWithClient({
    companyId,
    credentialId,
    correlationToken,
    providerCallId,
    source = 'assistant_request',
}, client) {
    const normalizedCompanyId = assertNonEmpty(
        companyId,
        'VAPI_IDENTITY_COMPANY_REQUIRED',
        64,
    );
    const normalizedCredentialId = assertNonEmpty(
        String(credentialId || ''),
        'VAPI_IDENTITY_CREDENTIAL_REQUIRED',
        32,
    );
    const token = assertNonEmpty(
        correlationToken,
        'VAPI_IDENTITY_TOKEN_REQUIRED',
        256,
    );
    const normalizedProviderCallId = assertNonEmpty(
        providerCallId,
        'VAPI_IDENTITY_PROVIDER_CALL_REQUIRED',
        128,
    );
    if (!BIND_SOURCES.has(source)) {
        throw new VapiIdentityError('VAPI_IDENTITY_BIND_SOURCE_INVALID', 400);
    }

    const tokenHash = hashToken(token);
    const found = await client.query(
        `SELECT
             session.*,
             resource.is_active AS resource_active,
             profile.is_active AS profile_active,
             profile.vapi_assistant_id AS current_vapi_assistant_id,
             credential.machine_surface AS credential_surface,
             credential.scopes AS credential_scopes,
             credential.revoked_at AS credential_revoked_at,
             credential.expires_at AS credential_expires_at,
             acceptance.acceptance_state AS credential_acceptance_state,
             acceptance.expires_at AS credential_acceptance_expires_at
         FROM vapi_call_sessions session
         LEFT JOIN vapi_tenant_resources resource
           ON resource.id = session.tenant_resource_id
          AND resource.company_id = session.company_id
          AND resource.provider_connection_id = session.provider_connection_id
          AND resource.assistant_profile_id = session.assistant_profile_id
         LEFT JOIN vapi_assistant_profiles profile
           ON profile.id = session.assistant_profile_id
          AND profile.company_id = session.company_id
          AND profile.provider_connection_id = session.provider_connection_id
         LEFT JOIN api_integrations credential
           ON credential.id = $3
          AND credential.company_id = session.company_id
         LEFT JOIN vapi_company_credential_acceptance acceptance
           ON acceptance.company_id = session.company_id
          AND acceptance.environment = session.environment
          AND acceptance.machine_surface = 'vapi_assistant_request'
          AND acceptance.credential_id = credential.id
         WHERE session.company_id = $1
           AND session.correlation_token_hash = $2
           AND session.direction = 'inbound'
         LIMIT 2
         FOR UPDATE OF session`,
        [normalizedCompanyId, tokenHash, normalizedCredentialId],
    );
    if (found.rows.length !== 1) {
        throw new VapiIdentityError('VAPI_IDENTITY_TOKEN_NOT_FOUND', 404);
    }

    const session = found.rows[0];
    if (session.state === 'quarantined') {
        throw new VapiIdentityError('VAPI_IDENTITY_SESSION_QUARANTINED', 409);
    }

    if (session.vapi_call_id) {
        if (session.vapi_call_id === normalizedProviderCallId) {
            return {
                ok: true,
                idempotent: true,
                sessionId: String(session.id),
                companyId: session.company_id,
                assistantId: session.expected_vapi_assistant_id,
                providerCallId: session.vapi_call_id,
            };
        }
        return quarantineSession(client, session, 'correlation_token_reused');
    }

    if (!session.credential_surface) {
        return quarantineSession(client, session, 'credential_mismatch');
    }

    const scopes = Array.isArray(session.credential_scopes)
        ? session.credential_scopes
        : [];
    const credentialExpired = session.credential_expires_at
        && new Date(session.credential_expires_at).getTime() <= Date.now();
    const acceptanceExpired = session.credential_acceptance_expires_at
        && new Date(session.credential_acceptance_expires_at).getTime() <= Date.now();
    const credentialPinned = String(session.assistant_request_credential_id)
        === normalizedCredentialId;
    const rotationCredentialAccepted = ['rotating', 'current', 'retiring']
        .includes(session.credential_acceptance_state)
        && !acceptanceExpired;
    if (
        session.resource_active !== true
        || session.profile_active !== true
        || session.credential_surface !== 'vapi_assistant_request'
        || !scopes.includes('vapi_assistant_request:invoke')
        || session.credential_revoked_at
        || credentialExpired
        || (!credentialPinned && !rotationCredentialAccepted)
        || session.current_vapi_assistant_id !== session.expected_vapi_assistant_id
    ) {
        return quarantineSession(client, session, 'execution_tuple_drift');
    }

    if (new Date(session.correlation_expires_at).getTime() <= Date.now()) {
        return quarantineSession(client, session, 'correlation_token_expired');
    }

    await client.query(
        `SELECT pg_advisory_xact_lock(
             hashtextextended($1, 0)
         )`,
        [normalizedProviderCallId],
    );
    const collision = await client.query(
        `SELECT id, company_id
         FROM vapi_call_sessions
         WHERE vapi_call_id = $1
         LIMIT 2
         FOR UPDATE`,
        [normalizedProviderCallId],
    );
    if (collision.rows.some((row) => String(row.id) !== String(session.id))) {
        return quarantineSession(client, session, 'provider_call_collision');
    }

    const bound = await client.query(
        `UPDATE vapi_call_sessions
         SET vapi_call_id = $3,
             bind_source = $4,
             bound_at = now(),
             correlation_consumed_at = now(),
             state = 'active'
         WHERE id = $1
           AND company_id = $2
           AND vapi_call_id IS NULL
           AND correlation_token_hash = $5
         RETURNING id, company_id, vapi_call_id, expected_vapi_assistant_id`,
        [
            session.id,
            normalizedCompanyId,
            normalizedProviderCallId,
            source,
            tokenHash,
        ],
    );
    if (bound.rows.length !== 1) {
        return quarantineSession(client, session, 'concurrent_bind_conflict');
    }

    return {
        ok: true,
        idempotent: false,
        sessionId: String(bound.rows[0].id),
        companyId: bound.rows[0].company_id,
        assistantId: bound.rows[0].expected_vapi_assistant_id,
        providerCallId: bound.rows[0].vapi_call_id,
    };
}

async function bindInboundCall(input) {
    const outcome = await withTransaction((client) => bindInboundCallWithClient(input, client));
    if (!outcome.ok) {
        identityAlert(outcome.code, {
            companyId: outcome.companyId,
            sessionId: outcome.sessionId,
            providerCallId: input.providerCallId,
        });
        throw new VapiIdentityError(`VAPI_IDENTITY_${outcome.code.toUpperCase()}`, outcome.status);
    }
    return outcome;
}

async function recordUnattributedInboundCall({ companyId, providerCallId, reason }, client = null) {
    const normalizedCompanyId = assertNonEmpty(
        companyId,
        'VAPI_IDENTITY_COMPANY_REQUIRED',
        64,
    );
    const normalizedProviderCallId = assertNonEmpty(
        providerCallId,
        'VAPI_IDENTITY_PROVIDER_CALL_REQUIRED',
        128,
    );
    const normalizedReason = assertNonEmpty(
        reason,
        'VAPI_IDENTITY_UNATTRIBUTED_REASON_REQUIRED',
        64,
    );
    const write = (executor) => executor.query(
        `INSERT INTO vapi_usage_alerts (
             company_id, provider_call_id, kind, dedupe_key, details
         ) VALUES (
             $1, $2, 'provider_orphan', $3, $4::jsonb
         )
         ON CONFLICT (dedupe_key) DO UPDATE
         SET provider_call_id = EXCLUDED.provider_call_id,
             details = EXCLUDED.details,
             resolved_at = NULL
         WHERE vapi_usage_alerts.details IS DISTINCT FROM EXCLUDED.details
            OR vapi_usage_alerts.resolved_at IS NOT NULL`,
        [
            normalizedCompanyId,
            normalizedProviderCallId,
            `provider_orphan:${normalizedProviderCallId}:assistant_request_unattributed`,
            JSON.stringify({ providerCallId: normalizedProviderCallId, reason: normalizedReason }),
        ],
    );
    if (client?.query) await write(client);
    else await withTransaction(write);
    identityAlert(normalizedReason, {
        companyId: normalizedCompanyId,
        sessionId: null,
        providerCallId: normalizedProviderCallId,
    });
}

module.exports = {
    TOKEN_HEADER,
    VapiIdentityError,
    hashToken,
    reserveInboundSession,
    reserveInboundSessionWithClient,
    bindInboundCall,
    bindInboundCallWithClient,
    recordUnattributedInboundCall,
    sanitizeSubscriptionLimits,
    reserveOutboundSession,
    reserveOutboundSessionWithClient,
    bindOutboundPlacement,
    bindOutboundPlacementWithClient,
    quarantineOutboundReservation,
    quarantineOutboundReservationWithClient,
    reapStaleOutboundPlacements,
    reapStaleOutboundPlacementsWithClient,
};
