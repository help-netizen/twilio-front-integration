'use strict';

const crypto = require('crypto');
const { withTransaction } = require('./transactionService');
const {
    VapiContractError,
    parseVapiServerMessageJson,
    parseVapiEndOfCallReportJson,
    sanitizeVapiServerMessageJson,
    sanitizeVapiServerMessageCandidateJson,
} = require('./vapiProviderContracts');

const PLATFORM_PROVIDER_ACCOUNT_KEY = 'vapi:platform';
const STATUS_SURFACE = 'vapi_call_status';
const STATUS_SCOPE = 'vapi_call_status:invoke';
const MAX_SIGNED_BIGINT = 9223372036854775807n;

class VapiUsageIngestError extends Error {
    constructor(code, status = 409) {
        super(code);
        this.name = 'VapiUsageIngestError';
        this.code = code;
        this.status = status;
    }
}

function requireNonEmpty(value, code, maxLength = 255) {
    if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
        throw new VapiUsageIngestError(code, 400);
    }
    return value.trim();
}

function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => (
            `${JSON.stringify(key)}:${stableStringify(value[key])}`
        )).join(',')}}`;
    }
    return JSON.stringify(value);
}

function hashEvidence(value) {
    return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function assertNumericFits(value, precision = 24, scale = 12) {
    const [whole, fraction = ''] = value.split('.');
    const significantWhole = whole.replace(/^0+/, '');
    if (fraction.length > scale || significantWhole.length > precision - scale) {
        throw new VapiUsageIngestError('VAPI_USAGE_NUMERIC_OUT_OF_RANGE', 400);
    }
    return value;
}

function addDecimalStrings(values) {
    let maxScale = 0;
    for (const value of values) {
        const fraction = value.split('.')[1] || '';
        maxScale = Math.max(maxScale, fraction.length);
    }
    let total = 0n;
    for (const value of values) {
        const [whole, fraction = ''] = value.split('.');
        total += BigInt(`${whole}${fraction.padEnd(maxScale, '0')}`);
    }
    if (maxScale === 0) return total.toString();
    const digits = total.toString().padStart(maxScale + 1, '0');
    const whole = digits.slice(0, -maxScale);
    const fraction = digits.slice(-maxScale).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
}

function addCounters(values) {
    const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
    if (total > MAX_SIGNED_BIGINT) {
        throw new VapiUsageIngestError('VAPI_USAGE_COUNTER_OUT_OF_RANGE', 400);
    }
    return total.toString();
}

function exactDurationSeconds(startedAt, endedAt) {
    const startedMs = BigInt(Date.parse(startedAt));
    const endedMs = BigInt(Date.parse(endedAt));
    if (endedMs < startedMs) {
        throw new VapiUsageIngestError('VAPI_USAGE_TIMESTAMP_ORDER_INVALID', 400);
    }
    const milliseconds = endedMs - startedMs;
    const whole = milliseconds / 1000n;
    const remainder = (milliseconds % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
    return remainder ? `${whole}.${remainder}` : whole.toString();
}

function normalizeObservation(parsed) {
    const money = [
        parsed.cost.supplierTotal,
        ...Object.values(parsed.cost.components),
        ...Object.values(parsed.cost.analysis.costs),
    ];
    for (const value of money) assertNumericFits(value);

    const analysisCost = assertNumericFits(
        addDecimalStrings(Object.values(parsed.cost.analysis.costs)),
    );
    const promptTokens = addCounters([
        parsed.cost.tokens.llmPromptTokens,
        ...Object.entries(parsed.cost.analysis.tokens)
            .filter(([key]) => (
                key.endsWith('PromptTokens') && !key.endsWith('CachedPromptTokens')
            ))
            .map(([, value]) => value),
    ]);
    const completionTokens = addCounters([
        parsed.cost.tokens.llmCompletionTokens,
        ...Object.entries(parsed.cost.analysis.tokens)
            .filter(([key]) => key.endsWith('CompletionTokens'))
            .map(([, value]) => value),
    ]);
    const totalTokens = addCounters([promptTokens, completionTokens]);

    return {
        supplierCost: parsed.cost.supplierTotal,
        breakdownTotal: parsed.cost.supplierTotal,
        components: parsed.cost.components,
        analysisCost,
        promptTokens,
        completionTokens,
        totalTokens,
        durationSeconds: exactDurationSeconds(parsed.call.startedAt, parsed.call.endedAt),
        normalizedBreakdown: {
            schemaVersion: 1,
            total: parsed.cost.supplierTotal,
            components: parsed.cost.components,
            tokens: parsed.cost.tokens,
            analysis: parsed.cost.analysis,
        },
    };
}

async function assertStatusCredential(client, companyId, credentialId) {
    const credential = await client.query(
        `SELECT id
         FROM api_integrations
         WHERE id = $1
           AND company_id = $2
           AND machine_surface = $3
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
           AND scopes ? $4
         LIMIT 2
         FOR SHARE`,
        [credentialId, companyId, STATUS_SURFACE, STATUS_SCOPE],
    );
    if (credential.rows.length !== 1) {
        throw new VapiUsageIngestError('VAPI_USAGE_STATUS_CREDENTIAL_INVALID', 403);
    }
}

function purposeForScenario(scenario) {
    return scenario === 'lead_call' ? 'outbound_lead_call' : 'outbound_parts_call';
}

function configuredOutboundAssistantId(purpose) {
    return purpose === 'outbound_lead_call'
        ? process.env.VAPI_LEAD_CALL_ASSISTANT_ID
        : process.env.VAPI_OUTBOUND_ASSISTANT_ID;
}

function warnOutboundAssistantDrift({ companyId, providerCallId, purpose, assistantId }) {
    const configured = configuredOutboundAssistantId(purpose);
    if (configured === assistantId) return;
    console.warn(
        '[vapiUsageIngest] transitional outbound assistant mismatch',
        {
            companyId,
            providerCallId,
            purpose,
            configured: configured || null,
            observed: assistantId,
        },
    );
}

async function findAttempt(client, companyId, providerCallId) {
    const attempt = await client.query(
        `SELECT id, company_id, job_id, task_id, attempt_no, status, phone,
                contact_id, slot_json, scenario, lead_uuid, created_at, updated_at
         FROM outbound_call_attempts
         WHERE company_id = $1
           AND vapi_call_id = $2
         ORDER BY id DESC
         LIMIT 2
         FOR UPDATE`,
        [companyId, providerCallId],
    );
    return attempt.rows.length === 1 ? attempt.rows[0] : null;
}

function callTypeMatchesDirection(callType, direction) {
    return (direction === 'inbound' && callType === 'inboundPhoneCall')
        || (direction === 'outbound' && callType === 'outboundPhoneCall');
}

async function correlateCallWithClient({
    companyId,
    providerCallId,
    assistantId,
    callType,
}, client) {
    const existing = await client.query(
        `SELECT *
         FROM vapi_call_sessions
         WHERE company_id = $1
           AND vapi_call_id = $2
         LIMIT 2
         FOR UPDATE`,
        [companyId, providerCallId],
    );
    if (existing.rows.length > 1) {
        throw new VapiUsageIngestError('VAPI_USAGE_SESSION_AMBIGUOUS', 409);
    }

    let session = existing.rows[0] || null;
    let attempt = null;
    if (session) {
        if (session.state === 'quarantined'
            || !callTypeMatchesDirection(callType, session.direction)) {
            return { correlated: false, reason: 'session_not_eligible' };
        }
        if (session.outbound_call_attempt_id != null) {
            attempt = await findAttempt(client, companyId, providerCallId);
            if (!attempt || String(attempt.id) !== String(session.outbound_call_attempt_id)) {
                return { correlated: false, reason: 'attempt_mismatch' };
            }
        }

        if (session.direction === 'outbound') {
            warnOutboundAssistantDrift({
                companyId,
                providerCallId,
                purpose: session.purpose,
                assistantId,
            });
        }

        if (session.expected_vapi_assistant_id == null && session.direction === 'outbound') {
            const enriched = await client.query(
                `UPDATE vapi_call_sessions
                 SET expected_vapi_assistant_id = $3
                 WHERE id = $1
                   AND company_id = $2
                   AND expected_vapi_assistant_id IS NULL
                 RETURNING *`,
                [session.id, companyId, assistantId],
            );
            session = enriched.rows[0] || session;
        }

        if (session.direction === 'inbound'
            && session.expected_vapi_assistant_id !== assistantId) {
            return { correlated: false, reason: 'assistant_mismatch' };
        }
        return { correlated: true, session, attempt };
    }

    if (callType !== 'outboundPhoneCall') {
        return { correlated: false, reason: 'session_not_found' };
    }
    attempt = await findAttempt(client, companyId, providerCallId);
    if (!attempt) return { correlated: false, reason: 'attempt_not_found' };

    const purpose = purposeForScenario(attempt.scenario);
    warnOutboundAssistantDrift({
        companyId,
        providerCallId,
        purpose,
        assistantId,
    });

    const created = await client.query(
        `INSERT INTO vapi_call_sessions (
             company_id, direction, purpose, environment,
             provider_account_key, expected_vapi_assistant_id, vapi_call_id,
             outbound_call_attempt_id, bind_source, bound_at, admitted_at, state
         ) VALUES (
             $1, 'outbound', $2, 'prod',
             $3, $4, $5, $6, 'post_call_response', $7, $8, 'active'
         )
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
            companyId,
            purpose,
            PLATFORM_PROVIDER_ACCOUNT_KEY,
            assistantId,
            providerCallId,
            attempt.id,
            attempt.updated_at,
            attempt.created_at,
        ],
    );
    if (created.rows.length === 1) {
        return { correlated: true, session: created.rows[0], attempt };
    }

    const raced = await client.query(
        `SELECT *
         FROM vapi_call_sessions
         WHERE company_id = $1
           AND vapi_call_id = $2
           AND outbound_call_attempt_id = $3
         LIMIT 2
         FOR UPDATE`,
        [companyId, providerCallId, attempt.id],
    );
    if (raced.rows.length !== 1) {
        return { correlated: false, reason: 'provider_call_collision' };
    }
    return { correlated: true, session: raced.rows[0], attempt };
}

async function updateSessionLifecycle(client, session, parsed, state) {
    await client.query(
        `UPDATE vapi_call_sessions
         SET started_at = COALESCE(started_at, $3),
             ended_at = COALESCE($4, ended_at),
             provider_ended_reason = COALESCE($5, provider_ended_reason),
             state = CASE
                 WHEN state IN ('closed', 'quarantined') THEN state
                 WHEN $6 = 'cost_pending' THEN 'cost_pending'
                 WHEN state IN ('ended', 'cost_pending') THEN state
                 ELSE $6
             END
         WHERE id = $1
           AND company_id = $2`,
        [
            session.id,
            session.company_id,
            parsed.call.startedAt || null,
            parsed.call.endedAt || null,
            parsed.endedReason || parsed.call.endedReason || null,
            state,
        ],
    );
}

function validationError(error) {
    if (error instanceof VapiContractError || error instanceof VapiUsageIngestError) {
        return `${error.code}${error.path ? `:${error.path}` : ''}`.slice(0, 255);
    }
    throw error;
}

function hashWirePayload(rawJson) {
    return crypto.createHash('sha256').update(rawJson, 'utf8').digest('hex');
}

async function quarantineProviderMessage(client, {
    companyId,
    credentialId,
    rawJson,
    error,
    alertKind,
}) {
    const sanitizedPayload = sanitizeVapiServerMessageCandidateJson(rawJson);
    const payloadHash = hashWirePayload(rawJson);
    const providerCallId = sanitizedPayload.message?.call?.id || null;
    const claimedMessageType = sanitizedPayload.message?.type || null;
    const validation = typeof error === 'string'
        ? error.slice(0, 255)
        : validationError(error);
    const quarantined = await client.query(
        `INSERT INTO vapi_provider_message_quarantine (
             company_id, status_credential_id, payload_hash,
             provider_call_id, claimed_message_type, validation_error,
             sanitized_payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (company_id, status_credential_id, payload_hash)
         DO UPDATE SET delivery_count =
                           vapi_provider_message_quarantine.delivery_count + 1,
                       last_seen_at = now(),
                       validation_error = EXCLUDED.validation_error
         RETURNING id`,
        [
            companyId,
            credentialId,
            payloadHash,
            providerCallId,
            claimedMessageType,
            validation,
            JSON.stringify(sanitizedPayload),
        ],
    );
    const quarantineId = quarantined.rows[0].id;
    await client.query(
        `INSERT INTO vapi_usage_alerts (
             company_id, kind, dedupe_key, details
         ) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [
            companyId,
            alertKind,
            `${alertKind}:${companyId}:${credentialId}:${payloadHash}`,
            JSON.stringify({
                quarantineId,
                validationError: validation,
                providerCallId,
                claimedMessageType,
            }),
        ],
    );
    return {
        quarantineId,
        providerCallId,
        claimedMessageType,
        validationError: validation,
    };
}

async function insertObservation(client, {
    companyId,
    credentialId,
    session,
    parsed,
    sanitizedPayload,
    payloadHash,
    normalized,
    error,
}) {
    const accepted = !error;
    const components = normalized?.components || {};
    const inserted = await client.query(
        `INSERT INTO vapi_call_usage_observations (
             company_id, vapi_call_session_id, source, payload_hash,
             supplier_cost, breakdown_total,
             transport_cost, stt_cost, llm_cost, tts_cost, vapi_cost, chat_cost,
             analysis_cost, prompt_tokens, completion_tokens, total_tokens,
             breakdown_schema_version, cost_breakdown_evidence,
             provider_updated_at, started_at, ended_at, ended_reason,
             validation_state, validation_error,
             status_credential_id, assistant_id, call_type, provider_status,
             sanitized_payload
         ) VALUES (
             $1, $2, 'end_of_call_report', $3,
             $4::numeric, $5::numeric,
             $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10::numeric, $11::numeric,
             $12::numeric, $13::bigint, $14::bigint, $15::bigint,
             1, $16::jsonb,
             $17, $18, $19, $20,
             $21, $22,
             $23, $24, $25, $26,
             $27::jsonb
         )
         ON CONFLICT (company_id, vapi_call_session_id, source, payload_hash)
         DO NOTHING
         RETURNING id`,
        [
            companyId,
            session.id,
            payloadHash,
            normalized?.supplierCost || null,
            normalized?.breakdownTotal || null,
            components.transport || null,
            components.stt || null,
            components.llm || null,
            components.tts || null,
            components.vapi || null,
            components.chat || null,
            normalized?.analysisCost || null,
            normalized?.promptTokens || null,
            normalized?.completionTokens || null,
            normalized?.totalTokens || null,
            JSON.stringify(normalized?.normalizedBreakdown || {}),
            parsed.call.updatedAt || null,
            parsed.call.startedAt || null,
            parsed.call.endedAt || null,
            parsed.endedReason || parsed.call.endedReason || null,
            accepted ? 'accepted' : 'quarantined',
            error || null,
            credentialId,
            parsed.call.assistantId,
            parsed.call.type,
            parsed.call.status,
            JSON.stringify(sanitizedPayload),
        ],
    );
    return inserted.rows[0]?.id || null;
}

async function projectObservation(client, {
    companyId,
    session,
    observationId,
    parsed,
    normalized,
    error,
}) {
    if (error) {
        await client.query(
            `INSERT INTO vapi_call_usage (
             company_id, vapi_call_session_id, state, last_error,
                 provisional_updated_at, next_reconcile_at
             ) VALUES (
                 $1, $2, 'quarantined', $3, now(), now() + interval '1 minute'
             )
             ON CONFLICT (vapi_call_session_id) DO NOTHING`,
            [companyId, session.id, error],
        );
        return;
    }

    await client.query(
        `INSERT INTO vapi_call_usage (
             company_id, vapi_call_session_id, state, supplier_cost,
             normalized_breakdown, ended_reason, duration_seconds,
             next_reconcile_at, provisional_observation_id,
             provisional_updated_at, last_error
         ) VALUES (
             $1, $2, 'provisional', $3::numeric,
             $4::jsonb, $5, $6::numeric,
             now() + interval '1 minute', $7, now(), NULL
         )
         ON CONFLICT (vapi_call_session_id) DO UPDATE
         SET state = 'provisional',
             supplier_cost = EXCLUDED.supplier_cost,
             normalized_breakdown = EXCLUDED.normalized_breakdown,
             ended_reason = EXCLUDED.ended_reason,
             duration_seconds = EXCLUDED.duration_seconds,
             next_reconcile_at = COALESCE(
                 vapi_call_usage.next_reconcile_at,
                 now() + interval '1 minute'
             ),
             provisional_observation_id = EXCLUDED.provisional_observation_id,
             provisional_updated_at = now(),
             last_error = NULL
         WHERE vapi_call_usage.company_id = EXCLUDED.company_id
           AND vapi_call_usage.state IN ('provisional', 'quarantined')`,
        [
            companyId,
            session.id,
            normalized.supplierCost,
            JSON.stringify(normalized.normalizedBreakdown),
            parsed.endedReason || parsed.call.endedReason,
            normalized.durationSeconds,
            observationId,
        ],
    );
}

async function ingestServerMessageWithClient({
    companyId,
    credentialId,
    rawJson,
}, client) {
    const normalizedCompanyId = requireNonEmpty(
        companyId,
        'VAPI_USAGE_COMPANY_REQUIRED',
        64,
    );
    const normalizedCredentialId = requireNonEmpty(
        String(credentialId || ''),
        'VAPI_USAGE_CREDENTIAL_REQUIRED',
        32,
    );
    if (typeof rawJson !== 'string' || rawJson.length === 0) {
        throw new VapiUsageIngestError('VAPI_USAGE_RAW_JSON_REQUIRED', 503);
    }

    await assertStatusCredential(client, normalizedCompanyId, normalizedCredentialId);
    let parsed;
    try {
        parsed = parseVapiServerMessageJson(rawJson);
    } catch (error) {
        if (!(error instanceof VapiContractError)) throw error;
        const quarantine = await quarantineProviderMessage(client, {
            companyId: normalizedCompanyId,
            credentialId: normalizedCredentialId,
            rawJson,
            error,
            alertKind: 'provider_message_quarantined',
        });
        return {
            correlated: false,
            quarantined: true,
            reason: 'identity_contract_rejected',
            ...quarantine,
        };
    }
    if (!['status-update', 'end-of-call-report'].includes(parsed.kind)) {
        return { correlated: false, reason: 'message_not_ingested', parsed };
    }

    const correlation = await correlateCallWithClient({
        companyId: normalizedCompanyId,
        providerCallId: parsed.call.id,
        assistantId: parsed.call.assistantId,
        callType: parsed.call.type,
    }, client);
    if (!correlation.correlated) {
        if (parsed.kind === 'end-of-call-report') {
            const quarantine = await quarantineProviderMessage(client, {
                companyId: normalizedCompanyId,
                credentialId: normalizedCredentialId,
                rawJson,
                error: `correlation:${correlation.reason}`,
                alertKind: 'usage_ingest_rejected',
            });
            return { ...correlation, parsed, quarantined: true, ...quarantine };
        }
        return { ...correlation, parsed };
    }

    if (parsed.kind === 'status-update') {
        await updateSessionLifecycle(
            client,
            correlation.session,
            parsed,
            parsed.status === 'ended' ? 'ended' : 'active',
        );
        return { ...correlation, parsed, observationCreated: false };
    }

    const sanitizedPayload = sanitizeVapiServerMessageJson(rawJson);
    const payloadHash = hashEvidence(sanitizedPayload);
    let strictParsed = parsed;
    let normalized = null;
    let error = null;
    try {
        strictParsed = parseVapiEndOfCallReportJson(rawJson);
        normalized = normalizeObservation(strictParsed);
    } catch (parseError) {
        error = validationError(parseError);
    }

    await updateSessionLifecycle(
        client,
        correlation.session,
        strictParsed,
        'cost_pending',
    );
    const observationId = await insertObservation(client, {
        companyId: normalizedCompanyId,
        credentialId: normalizedCredentialId,
        session: correlation.session,
        parsed: strictParsed,
        sanitizedPayload,
        payloadHash,
        normalized,
        error,
    });
    if (observationId) {
        await projectObservation(client, {
            companyId: normalizedCompanyId,
            session: correlation.session,
            observationId,
            parsed: strictParsed,
            normalized,
            error,
        });
    }

    return {
        ...correlation,
        parsed: strictParsed,
        observationCreated: Boolean(observationId),
        observationId,
        validationState: error ? 'quarantined' : 'accepted',
        validationError: error,
    };
}

async function ingestServerMessage(input) {
    return withTransaction((client) => ingestServerMessageWithClient(input, client));
}

module.exports = {
    VapiUsageIngestError,
    stableStringify,
    hashEvidence,
    normalizeObservation,
    addDecimalStrings,
    correlateCallWithClient,
    quarantineProviderMessage,
    ingestServerMessage,
    ingestServerMessageWithClient,
};
