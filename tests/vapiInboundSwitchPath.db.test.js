'use strict';

const previousPepper = process.env.BLANC_SERVER_PEPPER;
process.env.BLANC_SERVER_PEPPER = 'ob62-real-db-machine-credential-pepper';

const express = require('express');
const request = require('supertest');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

const db = require('../backend/src/db/connection');
const { hashSecret } = require('../backend/src/middleware/integrationsAuth');
const identity = require('../backend/src/services/vapiCallIdentityService');
const callStatusRouter = require('../backend/src/routes/vapiCallStatus');

const COMPANY_ID = randomUUID();
const TAG = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const CONNECTION_ID = `ob62-connection-${TAG}`;
const PROFILE_ID = `ob62-profile-${TAG}`;
const RESOURCE_ID = `ob62-resource-${TAG}`;
const FLOW_EXECUTION_ID = `ob62-flow-${TAG}`;
const TWILIO_PARENT_SID = `CAob62${TAG.replace(/[^A-Za-z0-9]/g, '')}`;
const ASSISTANT_ID = randomUUID();
const PROVIDER_CALL_ID = randomUUID();
const ASSISTANT_REQUEST_SECRET = `assistant-request-${TAG}-0123456789abcdef`;
const CALL_STATUS_SECRET = `call-status-${TAG}-0123456789abcdef`;
const TOOLS_SECRET = `tools-${TAG}-0123456789abcdef`;

let pool;
let assistantRequestCredentialId;
let callStatusCredentialId;
let toolsCredentialId;

function providerFacingApp() {
    const app = express();
    // This is the required production mount order: exact provider bytes must be
    // captured before any global JSON parser consumes decimal cost lexemes.
    app.use(
        '/api/vapi/call-status',
        express.raw({ type: '*/*', limit: '2mb' }),
        callStatusRouter,
    );
    return app;
}

async function seedCredential(surface, scope, secret) {
    const result = await pool.query(
        `INSERT INTO api_integrations (
             client_name, key_id, secret_hash, scopes, company_id, machine_surface
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING id`,
        [
            `OB-62 ${surface}`,
            `ob62_${surface}_${TAG}`,
            hashSecret(secret),
            JSON.stringify([scope]),
            COMPANY_ID,
            surface,
        ],
    );
    return String(result.rows[0].id);
}

async function seedRuntimeTuple() {
    await pool.query(
        `INSERT INTO companies (id, name, slug, status)
         VALUES ($1, $2, $3, 'active')`,
        [COMPANY_ID, `OB-62 switch ${TAG}`, `ob62-switch-${TAG}`],
    );
    assistantRequestCredentialId = await seedCredential(
        'vapi_assistant_request',
        'vapi_assistant_request:invoke',
        ASSISTANT_REQUEST_SECRET,
    );
    callStatusCredentialId = await seedCredential(
        'vapi_call_status',
        'vapi_call_status:invoke',
        CALL_STATUS_SECRET,
    );
    toolsCredentialId = await seedCredential(
        'vapi_tools',
        'vapi_tools:invoke',
        TOOLS_SECRET,
    );
    await pool.query(
        `INSERT INTO provider_connections (
             id, tenant_id, company_id, provider, environment, status, provider_org_id
         ) VALUES ($1, $2, $3, 'vapi', 'prod', 'active', '')`,
        [CONNECTION_ID, `ob62-tenant-${TAG}`, COMPANY_ID],
    );
    await pool.query(
        `INSERT INTO vapi_assistant_profiles (
             id, tenant_id, company_id, provider_connection_id, slug, purpose,
             environment, provider_account_key, status, is_active,
             vapi_assistant_id, tools_credential_id, call_status_credential_id
         ) VALUES (
             $1, $2, $3, $4, $5, 'inbound_call',
             'prod', 'vapi:platform', 'active', true,
             $6, $7, $8
         )`,
        [
            PROFILE_ID,
            `ob62-tenant-${TAG}`,
            COMPANY_ID,
            CONNECTION_ID,
            `ob62-inbound-${TAG}`,
            ASSISTANT_ID,
            toolsCredentialId,
            callStatusCredentialId,
        ],
    );
    await pool.query(
        `INSERT INTO vapi_tenant_resources (
             id, tenant_id, company_id, provider_connection_id, environment,
             vapi_phone_number_id, sip_uri, server_url, is_active, purpose,
             assistant_profile_id, server_credential_id, fallback_vapi_assistant_id,
             status
         ) VALUES (
             $1, $2, $3, $4, 'prod',
             $5, $6, 'https://api.albusto.com/api/vapi/call-status/assistant-request',
             true, 'inbound_call', $7, $8, $9, 'active'
         )`,
        [
            RESOURCE_ID,
            `ob62-tenant-${TAG}`,
            COMPANY_ID,
            CONNECTION_ID,
            randomUUID(),
            `sip:ob62-${TAG}@sip.vapi.ai`,
            PROFILE_ID,
            assistantRequestCredentialId,
            ASSISTANT_ID,
        ],
    );
    await pool.query(
        `INSERT INTO call_flow_executions (
             id, company_id, call_sid, current_node_id, context_json, status
         ) VALUES ($1, $2, $3, 'vapi-node', '{}', 'active')`,
        [FLOW_EXECUTION_ID, COMPANY_ID, TWILIO_PARENT_SID],
    );
}

function assistantRequestBody(token) {
    return {
        message: {
            type: 'assistant-request',
            call: {
                id: PROVIDER_CALL_ID,
                orgId: 'ob62-platform-org',
                type: 'inboundPhoneCall',
                status: 'ringing',
                sipHeaders: { 'x-albusto-call-token': token },
            },
            phoneNumber: { id: randomUUID() },
        },
    };
}

function endOfCallBody() {
    return {
        message: {
            type: 'end-of-call-report',
            endedReason: 'customer-ended-call',
            call: {
                id: PROVIDER_CALL_ID,
                orgId: 'ob62-platform-org',
                type: 'inboundPhoneCall',
                assistantId: ASSISTANT_ID,
                status: 'ended',
                endedReason: 'customer-ended-call',
                createdAt: '2026-08-18T12:00:00.000Z',
                updatedAt: '2026-08-18T12:00:02.000Z',
                startedAt: '2026-08-18T12:00:00.000Z',
                endedAt: '2026-08-18T12:00:01.000Z',
                cost: 0.4027,
                costBreakdown: {
                    transport: 0.001,
                    stt: 0.01,
                    llm: 0.1,
                    tts: 0.09,
                    vapi: 0.2015,
                    chat: 0,
                    total: 0.4027,
                    llmPromptTokens: 100,
                    llmCompletionTokens: 20,
                    llmCachedPromptTokens: 0,
                    ttsCharacters: 500,
                    analysisCostBreakdown: {
                        summary: 0.0002,
                        structuredData: 0,
                        structuredOutput: 0,
                        successEvaluation: 0,
                        summaryPromptTokens: 10,
                        summaryCompletionTokens: 2,
                        summaryCachedPromptTokens: 0,
                        structuredDataPromptTokens: 0,
                        structuredDataCompletionTokens: 0,
                        structuredDataCachedPromptTokens: 0,
                        structuredOutputPromptTokens: 0,
                        structuredOutputCompletionTokens: 0,
                        structuredOutputCachedPromptTokens: 0,
                        successEvaluationPromptTokens: 0,
                        successEvaluationCompletionTokens: 0,
                        successEvaluationCachedPromptTokens: 0,
                    },
                },
            },
        },
    };
}

async function cleanup() {
    if (!pool) return;
    await pool.query('DELETE FROM vapi_inbound_recovery_cases WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM vapi_call_usage WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM vapi_call_usage_observations WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM vapi_provider_message_quarantine WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM vapi_usage_alerts WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM vapi_call_sessions WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM call_flow_executions WHERE id = $1', [FLOW_EXECUTION_ID]);
    await pool.query('DELETE FROM vapi_tenant_resources WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM vapi_assistant_profiles WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM vapi_company_credential_acceptance WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM api_integrations WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM provider_connections WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM companies WHERE id = $1', [COMPANY_ID]);
}

beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await cleanup();
    await seedRuntimeTuple();
});

afterAll(async () => {
    await cleanup().catch(() => {});
    if (pool) await pool.end();
    await db.pool.end();
    if (previousPepper === undefined) delete process.env.BLANC_SERVER_PEPPER;
    else process.env.BLANC_SERVER_PEPPER = previousPepper;
});

test('OB-62 real tables: assistant-request binds inbound identity and EoC finds the session', async () => {
    const reservation = await identity.reserveInboundSession({
        companyId: COMPANY_ID,
        twilioParentCallSid: TWILIO_PARENT_SID,
        flowExecutionId: FLOW_EXECUTION_ID,
        flowNodeId: 'vapi-node',
        purpose: 'inbound_call',
        environment: 'prod',
    });
    const app = providerFacingApp();

    const selection = await request(app)
        .post('/api/vapi/call-status/assistant-request')
        .set('content-type', 'application/json')
        .set('x-vapi-secret', ASSISTANT_REQUEST_SECRET)
        .send(assistantRequestBody(reservation.correlationToken));

    expect(selection.status).toBe(200);
    expect(selection.body).toEqual({
        assistantId: ASSISTANT_ID,
        assistantOverrides: {
            variableValues: {
                albusto_context_contract: 'assistant-request-probe/v1',
                albusto_context_status: 'generic',
                albusto_ob62_probe: 'sip-assistant-request-v1',
            },
        },
    });
    const bound = await pool.query(
        `SELECT id, company_id, vapi_call_id, state, bind_source
         FROM vapi_call_sessions
         WHERE id = $1`,
        [reservation.sessionId],
    );
    expect(bound.rows).toEqual([expect.objectContaining({
        company_id: COMPANY_ID,
        vapi_call_id: PROVIDER_CALL_ID,
        state: 'active',
        bind_source: 'assistant_request',
    })]);

    const report = await request(app)
        .post('/api/vapi/call-status')
        .set('content-type', 'application/json')
        .set('x-vapi-secret', CALL_STATUS_SECRET)
        .send(endOfCallBody());

    expect(report.status).toBe(200);
    expect(report.body).toEqual({ ok: true });
    const money = await pool.query(
        `SELECT observation.vapi_call_session_id,
                observation.supplier_cost::text,
                observation.validation_state,
                usage.state,
                usage.supplier_cost::text AS projected_supplier_cost
         FROM vapi_call_usage_observations observation
         JOIN vapi_call_usage usage
           ON usage.vapi_call_session_id = observation.vapi_call_session_id
          AND usage.company_id = observation.company_id
         WHERE observation.company_id = $1
           AND observation.vapi_call_session_id = $2`,
        [COMPANY_ID, reservation.sessionId],
    );
    expect(money.rows).toEqual([{
        vapi_call_session_id: reservation.sessionId,
        supplier_cost: '0.402700000000',
        validation_state: 'accepted',
        state: 'provisional',
        projected_supplier_cost: '0.402700000000',
    }]);
});
