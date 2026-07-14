/**
 * outboundCallService.test.js — OUTBOUND-PARTS-CALL-001, TC-OPC-U08.
 *
 * Unit (mocked axios): pins the VAPI `POST https://api.vapi.ai/call` request
 * CONTRACT and the safe-fail posture of `outboundCallService.placeCall`.
 *
 * NO real HTTP ever leaves the process — `axios` is jest.mocked; we capture the
 * request the module would send and assert URL / Bearer header / body shape:
 *   { assistantId, phoneNumberId (from env), customer.number, assistantOverrides.variableValues }.
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

const ENV_KEYS = [
    'VAPI_API_KEY',
    'VAPI_OUTBOUND_ASSISTANT_ID',
    'VAPI_OUTBOUND_PHONE_NUMBER_ID',
    'VAPI_OUTBOUND_TWILIO_NUMBER',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
];
const savedEnv = {};

function setEnv() {
    process.env.VAPI_API_KEY = 'sk_test_vapi_key';
    process.env.VAPI_OUTBOUND_ASSISTANT_ID = 'asst_outbound_123';
    process.env.VAPI_OUTBOUND_PHONE_NUMBER_ID = 'pn_bostonmasters_999';
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

        // --- Body shape: assistantId + phoneNumberId from env, customer.number,
        //     assistantOverrides.variableValues. ---
        expect(bodyArg).toMatchObject({
            assistantId: 'asst_outbound_123',
            phoneNumberId: 'pn_bostonmasters_999',
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

        // --- phoneNumberId is the env value, not a literal. ---
        expect(bodyArg.phoneNumberId).toBe(process.env.VAPI_OUTBOUND_PHONE_NUMBER_ID);
        expect(bodyArg.assistantId).toBe(process.env.VAPI_OUTBOUND_ASSISTANT_ID);

        // --- Returns the VAPI call.id for the caller (worker) to store. ---
        expect(out).toEqual({ ok: true, vapiCallId: 'vapi_call_x' });
    });

    test('no registered phoneNumberId but Twilio caller-ID env set → transient phoneNumber (no VAPI import), never phoneNumberId', async () => {
        delete process.env.VAPI_OUTBOUND_PHONE_NUMBER_ID;
        process.env.VAPI_OUTBOUND_TWILIO_NUMBER = '+16175006181';
        process.env.TWILIO_ACCOUNT_SID = 'ACtest';
        process.env.TWILIO_AUTH_TOKEN = 'tok_test';
        jest.resetModules();
        outboundCallService = require('../backend/src/services/outboundCallService');
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
        expect(out).toEqual({ ok: true, vapiCallId: 'vapi_call_t' });
    });

    test('neither phoneNumberId nor Twilio caller-ID → vapi_config_missing, no POST', async () => {
        delete process.env.VAPI_OUTBOUND_PHONE_NUMBER_ID;
        delete process.env.VAPI_OUTBOUND_TWILIO_NUMBER;
        jest.resetModules();
        outboundCallService = require('../backend/src/services/outboundCallService');

        const out = await outboundCallService.placeCall(CALL_ARGS);
        expect(out).toEqual({ ok: false, error: 'vapi_config_missing' });
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
    });

    test('safe-fail: 2xx but no call id in response → { ok:false, no_call_id }', async () => {
        mockPost.mockResolvedValue({ data: {} });
        const out = await outboundCallService.placeCall(CALL_ARGS);
        expect(out).toEqual({ ok: false, error: 'no_call_id' });
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
// balanceDue injection (OUTBOUND-PARTS-CALL balance) — passed through to
// variableValues verbatim ONLY when defined; never sent as an empty/undefined
// key so the assistant prompt can distinguish "unknown" from "nothing due".
// ---------------------------------------------------------------------------
describe('placeCall — balanceDue → variableValues', () => {
    test('balanceDue passed → included in variableValues as the exact string', async () => {
        mockPost.mockResolvedValue({ data: { id: 'vapi_call_b' } });

        await outboundCallService.placeCall({ ...CALL_ARGS, balanceDue: '$200.00' });

        const [, bodyArg] = mockPost.mock.calls[0];
        expect(bodyArg.assistantOverrides.variableValues.balanceDue).toBe('$200.00');
    });

    test('balanceDue passed as "paid in full, nothing due" → passed through verbatim', async () => {
        mockPost.mockResolvedValue({ data: { id: 'vapi_call_b2' } });

        await outboundCallService.placeCall({ ...CALL_ARGS, balanceDue: 'paid in full, nothing due' });

        const [, bodyArg] = mockPost.mock.calls[0];
        expect(bodyArg.assistantOverrides.variableValues.balanceDue).toBe('paid in full, nothing due');
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
        mockPost.mockResolvedValue({ status: 201, data: { id: 'vapi_new_call' } });
    });

    test('(a) parts args → NO lead keys on the wire; no firstMessage override', async () => {
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
