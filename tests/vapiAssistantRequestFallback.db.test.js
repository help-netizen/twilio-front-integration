'use strict';

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');

const COMPANY_ID = '51000000-0000-4000-8000-000000000071';
const CONNECTION_ID = 'vapi-assistant-request-fallback-db';
const RESOURCE_ID = 'vapi-assistant-request-minimal-resource';
const ASSISTANT_ID = 'assistant-request-company-fallback';

jest.mock('../backend/src/services/machineCredentialService', () => ({
    SURFACES: { VAPI_ASSISTANT_REQUEST: 'vapi_assistant_request' },
    ACCESS_SCOPES: { VAPI_ASSISTANT_REQUEST: 'vapi_assistant_request:invoke' },
    MachineCredentialError: class MachineCredentialError extends Error {},
    resolveCredential: jest.fn(async () => ({ id: '999999', companyId: COMPANY_ID })),
}));

const router = require('../backend/src/routes/vapiAssistantRequest');

let pool;

function app() {
    const instance = express();
    instance.use(express.json());
    instance.use('/assistant-request', router);
    return instance;
}

function payload({ token = null, callId = 'provider-call-fallback-db' } = {}) {
    const call = {
        id: callId,
        orgId: 'platform-org',
        type: 'inboundPhoneCall',
        status: 'ringing',
    };
    if (token) call.sipHeaders = { 'x-albusto-call-token': token };
    return { message: { type: 'assistant-request', call } };
}

async function cleanup() {
    await pool.query('DELETE FROM vapi_usage_alerts WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM vapi_call_sessions WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM vapi_tenant_resources WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM vapi_assistant_profiles WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM vapi_tenant_provisioning_runs WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM vapi_tenant_voice_configs WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM provider_connections WHERE company_id = $1', [COMPANY_ID]);
    await pool.query('DELETE FROM companies WHERE id = $1', [COMPANY_ID]);
}

async function seedMinimalResource() {
    await pool.query(
        `INSERT INTO companies (id, name, slug, status)
         VALUES ($1, 'Assistant Request Fallback DB', 'assistant-request-fallback-db', 'active')`,
        [COMPANY_ID],
    );
    await pool.query(
        `INSERT INTO provider_connections (
             id, tenant_id, company_id, provider, environment, status
         ) VALUES ($1, 'assistant-request-fallback-db', $2, 'vapi', 'prod', 'active')`,
        [CONNECTION_ID, COMPANY_ID],
    );
    await pool.query(
        `INSERT INTO vapi_tenant_resources (
             id, tenant_id, company_id, provider_connection_id, environment,
             sip_uri, is_active, purpose, status, assistant_profile_id,
             server_credential_id, fallback_vapi_assistant_id
         ) VALUES (
             $1, 'assistant-request-fallback-db', $2, $3, 'staging',
             'sip:minimal-fallback@sip.vapi.ai', true, 'legacy_sip', NULL, NULL,
             NULL, NULL
         )`,
        [RESOURCE_ID, COMPANY_ID, CONNECTION_ID],
    );
    await pool.query(
        `INSERT INTO vapi_tenant_provisioning_runs (
             company_id, environment, template_bundle_version, input_hash,
             state, current_step, provider_assistant_ids
         ) VALUES (
             $1, 'prod', 'fallback-test-v1', 'fallback-test-hash',
             'failed', 'registry', $2::jsonb
         )`,
        [COMPANY_ID, JSON.stringify({ inbound_call: ASSISTANT_ID })],
    );
}

beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
        `ALTER TABLE vapi_usage_alerts
         ADD COLUMN IF NOT EXISTS provider_call_id TEXT`,
    );
});

beforeEach(async () => {
    await cleanup();
    await seedMinimalResource();
});

afterAll(async () => {
    if (pool) {
        await cleanup().catch(() => {});
        await pool.end();
    }
});

test('SAB-FIX17 null fallback assistant column still answers from company-owned durable evidence', async () => {
    const row = await pool.query(
        `SELECT fallback_vapi_assistant_id
         FROM vapi_tenant_resources WHERE id = $1`,
        [RESOURCE_ID],
    );
    expect(row.rows).toEqual([{ fallback_vapi_assistant_id: null }]);

    const response = await request(app())
        .post('/assistant-request')
        .set('x-vapi-secret', 'company-machine-secret')
        .send(payload());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ assistantId: ASSISTANT_ID });
});

test('minimal live resource uses the same eligibility set for SIP and assistant selection', async () => {
    const row = await pool.query(
        `SELECT environment, purpose, status, assistant_profile_id, server_credential_id
         FROM vapi_tenant_resources WHERE id = $1`,
        [RESOURCE_ID],
    );
    expect(row.rows).toEqual([{
        environment: 'staging',
        purpose: 'legacy_sip',
        status: null,
        assistant_profile_id: null,
        server_credential_id: null,
    }]);

    const response = await request(app())
        .post('/assistant-request')
        .set('x-vapi-secret', 'company-machine-secret')
        .send(payload({ callId: 'provider-call-minimal-resource' }));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ assistantId: ASSISTANT_ID });
});

test('SAB-FIX18 real token bind failure answers and persists provider-call identity', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const callId = 'provider-call-bind-failure-real-db';

    const response = await request(app())
        .post('/assistant-request')
        .set('x-vapi-secret', 'company-machine-secret')
        .send(payload({ token: 'unknown-but-well-formed-token', callId }));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ assistantId: ASSISTANT_ID });
    const alert = await pool.query(
        `SELECT company_id, provider_call_id, kind, details
         FROM vapi_usage_alerts
         WHERE company_id = $1 AND provider_call_id = $2`,
        [COMPANY_ID, callId],
    );
    expect(alert.rows).toEqual([{
        company_id: COMPANY_ID,
        provider_call_id: callId,
        kind: 'provider_orphan',
        details: {
            providerCallId: callId,
            reason: 'assistant_request_bind_failed',
        },
    }]);
    errorSpy.mockRestore();
});
