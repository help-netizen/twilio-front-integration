/**
 * outboundCallService.test.js — OUTBOUND-PARTS-CALL-001, TC-OPC-U08.
 *
 * Unit (mocked axios): pins the VAPI `POST https://api.vapi.ai/call` request
 * CONTRACT and the safe-fail posture of `outboundCallService.placeCall`.
 *
 * NO real HTTP ever leaves the process — `axios` is jest.mocked; we capture the
 * request the module would send and assert URL / Bearer header / body shape:
 *   { assistantId (from registry), phoneNumberId, customer.number,
 *     assistantOverrides.variableValues }.
 *
 * Also covers: safe-fail on non-2xx / thrown / missing config — placeCall NEVER
 * throws, always resolves `{ ok:false, error }` (spec §C.3, Decision D, OQ-3).
 */

'use strict';

// Capture the axios instance the module builds via axios.create(), so we can
// assert on its `.post(...)` calls. axios.create returns our stub client.
const mockPost = jest.fn();
jest.mock('axios', () => ({
    create: jest.fn(() => ({ post: mockPost })),
}));

const PARTS_ASSISTANT_ID = 'assistant-registry-parts';
const LEAD_ASSISTANT_ID = 'assistant-registry-lead';
const mockReserveOutboundSession = jest.fn();
const mockBindOutboundPlacement = jest.fn();
const mockQuarantineOutboundReservation = jest.fn();
jest.mock('../backend/src/services/vapiCallIdentityService', () => ({
    reserveOutboundSession: (...args) => mockReserveOutboundSession(...args),
    bindOutboundPlacement: (...args) => mockBindOutboundPlacement(...args),
    quarantineOutboundReservation: (...args) => mockQuarantineOutboundReservation(...args),
}));

const ENV_KEYS = [
    'VAPI_API_KEY',
    'VAPI_OUTBOUND_PHONE_NUMBER_ID',
    'VAPI_OUTBOUND_TWILIO_NUMBER',
    'VAPI_OUTBOUND_ASSISTANT_ID',
    'VAPI_LEAD_CALL_ASSISTANT_ID',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
];
const savedEnv = {};

function setEnv() {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.VAPI_API_KEY = 'sk_test_vapi_key';
}

const CO = '00000000-0000-0000-0000-000000000001';
const SLOT = {
    key: 'slot_key_1',
    date: '2026-07-10',
    start: '10:00',
    end: '12:00',
    label: 'Tuesday between 10 AM and 12 PM',
};
const CALL_ARGS = {
    companyId: CO,
    attemptId: 900,
    jobId: 50,
    contactId: 501,
    customerName: 'Jane',
    customerNumber: '+16175551212',
    slot: SLOT,
};

let outboundCallService;

beforeAll(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterAll(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    setEnv();
    mockReserveOutboundSession.mockResolvedValue({
        sessionId: '10000000-0000-4000-8000-000000000001',
        companyId: CO,
        purpose: 'outbound_parts_call',
        assistantId: PARTS_ASSISTANT_ID,
        resourceType: 'vapi_phone_number',
        phoneNumberId: 'pn_registry_999',
        twilioPhoneNumber: null,
    });
    mockBindOutboundPlacement.mockResolvedValue({ ok: true });
    mockQuarantineOutboundReservation.mockResolvedValue(undefined);
    outboundCallService = require('../backend/src/services/outboundCallService');
});

describe('TC-OPC-U08: outboundCallService.placeCall — VAPI request contract', () => {
    test('POSTs to https://api.vapi.ai/call with Bearer header + correct body, returns vapiCallId', async () => {
        mockPost.mockResolvedValue({ data: { id: 'vapi_call_x' } });

        const out = await outboundCallService.placeCall(CALL_ARGS);

        // --- URL: the axios client is created against the VAPI /call endpoint. ---
        const axios = require('axios');
        expect(axios.create).toHaveBeenCalledWith(
            expect.objectContaining({ baseURL: 'https://api.vapi.ai/call' }),
        );

        // --- Exactly one POST placed. ---
        expect(mockPost).toHaveBeenCalledTimes(1);
        const [urlArg, bodyArg, optsArg] = mockPost.mock.calls[0];

        // --- Path is the (empty) POST against the baseURL. ---
        expect(urlArg).toBe('');

        // --- Bearer token comes from env (per-request header). ---
        expect(optsArg).toMatchObject({
            headers: { Authorization: 'Bearer sk_test_vapi_key' },
        });

        // --- Body shape: assistantId from registry, server caller id, customer.number,
        //     assistantOverrides.variableValues. ---
        expect(bodyArg).toMatchObject({
            assistantId: PARTS_ASSISTANT_ID,
            phoneNumberId: 'pn_registry_999',
            metadata: {
                albustoCallSessionId: '10000000-0000-4000-8000-000000000001',
            },
            customer: { number: '+16175551212' },
            assistantOverrides: {
                variableValues: {
                    jobId: 50,
                    contactId: 501,
                    companyId: CO,
                    customerName: 'Jane',
                    slotLabel: SLOT.label,
                    slotDate: SLOT.date,
                    slotStart: SLOT.start,
                    slotEnd: SLOT.end,
                },
            },
        });

        // --- assistant and caller id are both pinned by the local reservation. ---
        expect(bodyArg.phoneNumberId).toBe('pn_registry_999');
        expect(bodyArg.assistantId).toBe(PARTS_ASSISTANT_ID);

        expect(mockBindOutboundPlacement).toHaveBeenCalledWith(expect.objectContaining({
            companyId: CO,
            outboundCallAttemptId: 900,
            providerCallId: 'vapi_call_x',
        }));
        expect(out).toMatchObject({ ok: true, vapiCallId: 'vapi_call_x' });
    });

    test('tenant registry transient Twilio resource builds inline phoneNumber, never reads caller id from env', async () => {
        process.env.VAPI_OUTBOUND_TWILIO_NUMBER = '+16179999999';
        process.env.TWILIO_ACCOUNT_SID = 'ACtest';
        process.env.TWILIO_AUTH_TOKEN = 'tok_test';
        mockReserveOutboundSession.mockResolvedValue({
            sessionId: '10000000-0000-4000-8000-000000000001',
            companyId: CO,
            purpose: 'outbound_parts_call',
            assistantId: PARTS_ASSISTANT_ID,
            resourceType: 'transient_twilio',
            phoneNumberId: null,
            twilioPhoneNumber: '+16175006181',
        });
        mockPost.mockResolvedValue({ data: { id: 'vapi_call_t' } });

        const out = await outboundCallService.placeCall(CALL_ARGS);

        const [, bodyArg] = mockPost.mock.calls[0];
        expect(bodyArg.phoneNumberId).toBeUndefined();
        // DIAL-FIX-001: VAPI transient Twilio caller-ID uses `twilioPhoneNumber` (E.164),
        // NOT `provider`/`number` (those get a 400 and the call never places).
        expect(bodyArg.phoneNumber).toEqual({
            twilioPhoneNumber: '+16175006181',
            twilioAccountSid: 'ACtest',
            twilioAuthToken: 'tok_test',
        });
        expect(out).toMatchObject({
            ok: true,
            vapiCallId: 'vapi_call_t',
            callerId: '+16175006181',
        });
    });

    test('registry tuple without an executable caller is quarantined and never POSTed', async () => {
        mockReserveOutboundSession.mockResolvedValue({
            sessionId: '10000000-0000-4000-8000-000000000001',
            companyId: CO,
            purpose: 'outbound_parts_call',
            assistantId: PARTS_ASSISTANT_ID,
            resourceType: 'vapi_phone_number',
            phoneNumberId: null,
            twilioPhoneNumber: null,
        });

        const out = await outboundCallService.placeCall(CALL_ARGS);
        expect(out).toEqual({ ok: false, error: 'vapi_config_missing' });
        expect(mockQuarantineOutboundReservation).toHaveBeenCalled();
        expect(mockPost).not.toHaveBeenCalled();
    });

    test('safe-fail: non-2xx (axios throws with response.status) → { ok:false }, never throws', async () => {
        const err = new Error('Request failed with status code 429');
        err.response = { status: 429 };
        mockPost.mockRejectedValue(err);

        const out = await outboundCallService.placeCall(CALL_ARGS);
        expect(out.ok).toBe(false);
        expect(out.error).toBe('vapi_http_429');
    });

    test('safe-fail: network/timeout throw (err.code, no response) → { ok:false }, never throws', async () => {
        const err = new Error('timeout of 15000ms exceeded');
        err.code = 'ECONNABORTED';
        mockPost.mockRejectedValue(err);

        const out = await outboundCallService.placeCall(CALL_ARGS);
        expect(out.ok).toBe(false);
        expect(out.error).toBe('ECONNABORTED');
        expect(out.providerPending).toBe(true);
        expect(mockQuarantineOutboundReservation).not.toHaveBeenCalled();
    });

    test('safe-fail: 2xx but no call id remains provider_pending, never retries as definite failure', async () => {
        mockPost.mockResolvedValue({ data: {} });
        const out = await outboundCallService.placeCall(CALL_ARGS);
        expect(out).toMatchObject({
            ok: false,
            error: 'no_call_id',
            providerPending: true,
        });
    });

    test('vapi_config_missing: no VAPI env set → { ok:false }, NO POST placed', async () => {
        for (const k of ENV_KEYS) delete process.env[k];
        jest.resetModules();
        const svc = require('../backend/src/services/outboundCallService');

        const out = await svc.placeCall(CALL_ARGS);
        expect(out).toEqual({ ok: false, error: 'vapi_config_missing' });
        expect(mockPost).not.toHaveBeenCalled();
    });

    test('missing customerNumber → { ok:false, missing_customer_number }, NO POST placed', async () => {
        const out = await outboundCallService.placeCall({ ...CALL_ARGS, customerNumber: null });
        expect(out).toEqual({ ok: false, error: 'missing_customer_number' });
        expect(mockPost).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// AGENT-FINANCE-CONTEXT-001 — amounts are never injected into assistant context.
// Even a stale caller that supplies balanceDue cannot put it in variableValues.
// ---------------------------------------------------------------------------
describe('placeCall — finance is on-demand only', () => {
    test('legacy balanceDue argument is ignored and absent from variableValues', async () => {
        mockPost.mockResolvedValue({ data: { id: 'vapi_call_b' } });

        await outboundCallService.placeCall({ ...CALL_ARGS, balanceDue: '$200.00' });

        const [, bodyArg] = mockPost.mock.calls[0];
        expect(Object.keys(bodyArg.assistantOverrides.variableValues)).not.toContain('balanceDue');
    });

    test('legacy paid-in-full phrase is also ignored', async () => {
        mockPost.mockResolvedValue({ data: { id: 'vapi_call_b2' } });

        await outboundCallService.placeCall({ ...CALL_ARGS, balanceDue: 'paid in full, nothing due' });

        const [, bodyArg] = mockPost.mock.calls[0];
        expect(Object.keys(bodyArg.assistantOverrides.variableValues)).not.toContain('balanceDue');
    });

    test('balanceDue omitted → the key is ABSENT from variableValues (not undefined)', async () => {
        mockPost.mockResolvedValue({ data: { id: 'vapi_call_c' } });

        await outboundCallService.placeCall(CALL_ARGS); // no balanceDue

        const [, bodyArg] = mockPost.mock.calls[0];
        // Not just undefined — the key must not be present at all.
        expect(Object.keys(bodyArg.assistantOverrides.variableValues)).not.toContain('balanceDue');
    });
});

// ---------------------------------------------------------------------------
// OUTBOUND-PARTS-CALL-TECHSLOT-001 (TC-TS-18) — technicianId (+ job coords) →
// variableValues. Injected ONLY when present on the slot_json (dispatcher lane
// pick / single-tech default + job coords from startRobotCall); absent → keys
// ABSENT (the legacy/auto-compute call body stays byte-identical). Downstream,
// vapi-tools.buildSkillInput spreads variableValues LAST over model args, so
// these server-injected values always win (model can't spoof the constraint).
// ---------------------------------------------------------------------------
describe('TC-TS-18: placeCall — slot techId/lat/lng → variableValues technicianId + coords', () => {
    test('slot carries techId + lat/lng → variableValues gets technicianId + coords; existing keys unchanged', async () => {
        mockPost.mockResolvedValue({ data: { id: 'vapi_call_ts1' } });

        await outboundCallService.placeCall({
            ...CALL_ARGS,
            slot: { ...SLOT, techId: 'B', lat: 42.1, lng: -71.1 },
        });

        const [, bodyArg] = mockPost.mock.calls[0];
        const vv = bodyArg.assistantOverrides.variableValues;
        expect(vv.technicianId).toBe('B');
        expect(vv.lat).toBe(42.1);
        expect(vv.lng).toBe(-71.1);
        // The pre-existing contract keys ride along unchanged.
        expect(vv).toMatchObject({
            jobId: 50,
            contactId: 501,
            companyId: CO,
            customerName: 'Jane',
            slotLabel: SLOT.label,
            slotDate: SLOT.date,
            slotStart: SLOT.start,
            slotEnd: SLOT.end,
            slotKey: SLOT.key,
        });
    });

    test('slot WITHOUT techId/coords → keys ABSENT from variableValues (legacy body unchanged)', async () => {
        mockPost.mockResolvedValue({ data: { id: 'vapi_call_ts2' } });

        await outboundCallService.placeCall(CALL_ARGS); // SLOT has no techId/lat/lng

        const [, bodyArg] = mockPost.mock.calls[0];
        const keys = Object.keys(bodyArg.assistantOverrides.variableValues);
        expect(keys).not.toContain('technicianId');
        expect(keys).not.toContain('lat');
        expect(keys).not.toContain('lng');
    });

    test('null techId / half coords (lat without lng) → all three omitted, never a null/partial injection', async () => {
        mockPost.mockResolvedValue({ data: { id: 'vapi_call_ts3' } });

        await outboundCallService.placeCall({
            ...CALL_ARGS,
            slot: { ...SLOT, techId: null, lat: 42.1, lng: null },
        });

        const [, bodyArg] = mockPost.mock.calls[0];
        const keys = Object.keys(bodyArg.assistantOverrides.variableValues);
        expect(keys).not.toContain('technicianId');
        expect(keys).not.toContain('lat');
        expect(keys).not.toContain('lng');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// OUTBOUND-LEAD-CALL-001 (OLC-T5) — TC-OLC-031: lead-scenario conditional
// spreads. Additive describe: everything above is byte-untouched.
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-OLC-031: placeCall — lead conditional spreads (parts wire body byte-identical)', () => {
    const LEAD_ARGS = {
        companyId: CO,
        attemptId: 700,
        scenario: 'lead_call',
        leadUuid: 'LD-1',
        contactId: 501,
        customerName: 'Alfreda Smith',
        customerNumber: '+16175551234',
        slot: { ...SLOT, lat: 42.31, lng: -71.16 },
        zip: '02467',
        problemDescription: 'Dishwasher leaks',
        source: 'Pro Referral',
        firstMessage: 'Hi {{customerName}}, this is Sara with ABC Homes — would {{slotLabel}} work?',
    };

    beforeEach(() => {
        mockReserveOutboundSession.mockResolvedValue({
            sessionId: '10000000-0000-4000-8000-000000000002',
            companyId: CO,
            purpose: 'outbound_lead_call',
            assistantId: LEAD_ASSISTANT_ID,
            resourceType: 'vapi_phone_number',
            phoneNumberId: 'pn_registry_999',
            twilioPhoneNumber: null,
        });
        mockPost.mockResolvedValue({ status: 201, data: { id: 'vapi_new_call' } });
    });

    test('(a) parts args → NO lead keys on the wire; no firstMessage override', async () => {
        mockReserveOutboundSession.mockResolvedValue({
            sessionId: '10000000-0000-4000-8000-000000000001',
            companyId: CO,
            purpose: 'outbound_parts_call',
            assistantId: PARTS_ASSISTANT_ID,
            resourceType: 'vapi_phone_number',
            phoneNumberId: 'pn_registry_999',
            twilioPhoneNumber: null,
        });
        await outboundCallService.placeCall(CALL_ARGS);
        const body = mockPost.mock.calls[0][1];
        const vv = body.assistantOverrides.variableValues;
        expect(vv.jobId).toBe(50);
        expect(vv.contactId).toBe(501);
        for (const k of ['scenario', 'leadUuid', 'zip', 'problemDescription', 'source']) {
            expect(Object.keys(vv)).not.toContain(k);
        }
        expect(Object.keys(body.assistantOverrides)).not.toContain('firstMessage');
    });

    test('(b) lead args → prompt discriminator lead_booking (NOT the db value), slot keys, coords, firstMessage; NO jobId key', async () => {
        await outboundCallService.placeCall(LEAD_ARGS);
        const body = mockPost.mock.calls[0][1];
        const vv = body.assistantOverrides.variableValues;
        expect(vv.scenario).toBe('lead_booking'); // §7.1 naming trap: not 'lead_call'
        expect(vv.leadUuid).toBe('LD-1');
        expect(vv.zip).toBe('02467');
        expect(vv.problemDescription).toBe('Dishwasher leaks');
        expect(vv.source).toBe('Pro Referral');
        expect(vv).toMatchObject({
            slotLabel: SLOT.label, slotDate: SLOT.date,
            slotStart: SLOT.start, slotEnd: SLOT.end, slotKey: SLOT.key,
            lat: 42.31, lng: -71.16,
        });
        expect(Object.keys(vv)).not.toContain('jobId');
        expect(body.assistantOverrides.firstMessage).toBe(LEAD_ARGS.firstMessage);
    });

    test('(c) absent options yield ABSENT keys (not undefined)', async () => {
        const { zip, problemDescription, source, firstMessage, ...rest } = LEAD_ARGS;
        await outboundCallService.placeCall({ ...rest, slot: { ...SLOT } });
        const body = mockPost.mock.calls[0][1];
        const keys = Object.keys(body.assistantOverrides.variableValues);
        for (const k of ['zip', 'problemDescription', 'source', 'lat', 'lng']) {
            expect(keys).not.toContain(k);
        }
        expect(Object.keys(body.assistantOverrides)).not.toContain('firstMessage');
        expect(body.assistantOverrides.variableValues.scenario).toBe('lead_booking');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// VAPI-AGENCY-001 T6: one pre-POST reservation is the only source of assistant
// and caller identity. Environment ids and caller numbers are ignored.
// ─────────────────────────────────────────────────────────────────────────────

describe('placeCall — fail-closed company outbound reservation', () => {
    beforeEach(() => {
        mockPost.mockResolvedValue({ status: 201, data: { id: 'vapi_call' } });
    });

    test('reservation is requested only by company and local attempt identity', async () => {
        await outboundCallService.placeCall(CALL_ARGS);
        expect(mockReserveOutboundSession).toHaveBeenCalledWith({
            companyId: CO,
            outboundCallAttemptId: 900,
            environment: 'prod',
        });
    });

    test('missing or inactive mapping refuses placement without a provider call', async () => {
        mockReserveOutboundSession.mockRejectedValue(
            Object.assign(new Error('unavailable'), { code: 'VAPI_IDENTITY_OUTBOUND_TUPLE_UNAVAILABLE' }),
        );
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const result = await outboundCallService.placeCall(CALL_ARGS);
        expect(result).toEqual({ ok: false, error: 'outbound_registry_unavailable' });
        expect(mockPost).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
            '[VAPI_OUTBOUND_ALERT] registry/session refused placement',
            expect.objectContaining({
                companyId: CO,
                attemptId: 900,
                code: 'VAPI_IDENTITY_OUTBOUND_TUPLE_UNAVAILABLE',
            }),
        );
        errorSpy.mockRestore();
    });

    test('SAB-T6-ENV: global assistant/phone env values cannot alter provider payload', async () => {
        process.env.VAPI_OUTBOUND_ASSISTANT_ID = 'foreign-env-assistant';
        process.env.VAPI_LEAD_CALL_ASSISTANT_ID = 'foreign-env-lead';
        process.env.VAPI_OUTBOUND_PHONE_NUMBER_ID = 'foreign-env-number';
        process.env.VAPI_OUTBOUND_TWILIO_NUMBER = '+16179999999';
        await outboundCallService.placeCall(CALL_ARGS);
        const body = mockPost.mock.calls[0][1];
        expect(body.assistantId).toBe(PARTS_ASSISTANT_ID);
        expect(body.phoneNumberId).toBe('pn_registry_999');
        expect(JSON.stringify(body)).not.toContain('foreign-env');
    });

    test('subscriptionLimits is telemetry on the atomic bind, never a placement input', async () => {
        const subscriptionLimits = { concurrencyLimit: 10, concurrencyLimitUsed: 4 };
        mockPost.mockResolvedValue({ data: { id: 'vapi_call', subscriptionLimits } });
        await outboundCallService.placeCall(CALL_ARGS);
        expect(mockBindOutboundPlacement).toHaveBeenCalledWith(expect.objectContaining({
            subscriptionLimits,
        }));
        expect(mockPost.mock.calls[0][1]).not.toHaveProperty('subscriptionLimits');
    });

    test('SAB-T6-ATOMIC: provider success + bind failure remains pending and cannot enter retry path', async () => {
        mockBindOutboundPlacement.mockRejectedValue(
            Object.assign(new Error('db unavailable'), { code: 'VAPI_IDENTITY_OUTBOUND_ATOMIC_BIND_FAILED' }),
        );
        const result = await outboundCallService.placeCall(CALL_ARGS);
        expect(result).toMatchObject({
            ok: false,
            providerPending: true,
            providerCallId: 'vapi_call',
        });
        expect(mockPost).toHaveBeenCalledTimes(1);
    });
});
