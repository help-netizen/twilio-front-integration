'use strict';

const crypto = require('crypto');
const { withTransaction } = require('./transactionService');

const DEFAULT_TOKEN_TTL_SECONDS = 300;
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

    const tuple = await client.query(
        `SELECT
             resource.id AS tenant_resource_id,
             resource.sip_uri,
             resource.provider_connection_id,
             resource.server_credential_id AS assistant_request_credential_id,
             profile.id AS assistant_profile_id,
             profile.vapi_assistant_id AS expected_vapi_assistant_id
         FROM vapi_tenant_resources resource
         JOIN provider_connections connection
           ON connection.id = resource.provider_connection_id
          AND connection.company_id = resource.company_id
          AND connection.provider = 'vapi'
          AND connection.status = 'active'
         JOIN vapi_assistant_profiles profile
           ON profile.id = resource.assistant_profile_id
          AND profile.company_id = resource.company_id
          AND profile.provider_connection_id = resource.provider_connection_id
          AND profile.is_active = true
          AND profile.purpose = resource.purpose
          AND profile.environment = resource.environment
         JOIN api_integrations credential
           ON credential.id = resource.server_credential_id
          AND credential.company_id = resource.company_id
          AND credential.machine_surface = 'vapi_assistant_request'
          AND credential.revoked_at IS NULL
          AND (credential.expires_at IS NULL OR credential.expires_at > now())
          AND credential.scopes ? 'vapi_assistant_request:invoke'
         WHERE resource.company_id = $1
           AND resource.environment = $2
           AND resource.purpose = $3
           AND resource.is_active = true
           AND NULLIF(BTRIM(resource.sip_uri), '') IS NOT NULL
           AND NULLIF(BTRIM(profile.vapi_assistant_id), '') IS NOT NULL
         ORDER BY resource.id
         LIMIT 2
         FOR SHARE OF resource, connection, profile, credential`,
        [normalizedCompanyId, normalizedEnvironment, normalizedPurpose],
    );
    if (tuple.rows.length !== 1) {
        throw new VapiIdentityError('VAPI_IDENTITY_TUPLE_UNAVAILABLE', 409);
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
    const selected = tuple.rows[0];
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
             credential.expires_at AS credential_expires_at
         FROM vapi_call_sessions session
         LEFT JOIN vapi_tenant_resources resource
           ON resource.id = session.tenant_resource_id
          AND resource.company_id = session.company_id
          AND resource.provider_connection_id = session.provider_connection_id
          AND resource.assistant_profile_id = session.assistant_profile_id
          AND resource.server_credential_id = session.assistant_request_credential_id
         LEFT JOIN vapi_assistant_profiles profile
           ON profile.id = session.assistant_profile_id
          AND profile.company_id = session.company_id
          AND profile.provider_connection_id = session.provider_connection_id
         LEFT JOIN api_integrations credential
           ON credential.id = session.assistant_request_credential_id
          AND credential.company_id = session.company_id
         WHERE session.company_id = $1
           AND session.correlation_token_hash = $2
           AND session.direction = 'inbound'
         LIMIT 2
         FOR UPDATE OF session`,
        [normalizedCompanyId, tokenHash],
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

    if (String(session.assistant_request_credential_id) !== normalizedCredentialId) {
        return quarantineSession(client, session, 'credential_mismatch');
    }

    const scopes = Array.isArray(session.credential_scopes)
        ? session.credential_scopes
        : [];
    const credentialExpired = session.credential_expires_at
        && new Date(session.credential_expires_at).getTime() <= Date.now();
    if (
        session.resource_active !== true
        || session.profile_active !== true
        || session.credential_surface !== 'vapi_assistant_request'
        || !scopes.includes('vapi_assistant_request:invoke')
        || session.credential_revoked_at
        || credentialExpired
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

module.exports = {
    TOKEN_HEADER,
    VapiIdentityError,
    hashToken,
    reserveInboundSession,
    reserveInboundSessionWithClient,
    bindInboundCall,
    bindInboundCallWithClient,
};
