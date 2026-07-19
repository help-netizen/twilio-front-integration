/**
 * TWILIO-SIG-ENFORCE-001 — Twilio-called TwiML endpoints reject unsigned
 * requests in production.
 *
 * Audit TENANCY-RBAC-AUDIT-001 flagged four public Twilio surfaces with absent
 * or fail-open signature validation: twiml.js /voice, voice.js /twiml/{outbound,
 * inbound}, the voice-fallback handler, and the Conversations post webhook
 * (which fell through to processing when the token OR signature was absent).
 * Knowing only the URL, an attacker could mint TwiML (exposing SIP topology /
 * redirecting the call) or inject Conversations events.
 *
 * These behavioral tests run with NODE_ENV=production (the guard is bypassed in
 * development, as the pre-existing suites rely on). validateTwilioSignature is
 * mocked so no real signature/crypto is needed — we assert the gate, not Twilio.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/webhooks/twilioWebhooks', () => {
    const actual = jest.requireActual('../backend/src/webhooks/twilioWebhooks');
    return { ...actual, validateTwilioSignature: jest.fn() };
});
const { validateTwilioSignature } = require('../backend/src/webhooks/twilioWebhooks');

const twimlRouter = require('../backend/src/routes/twiml');
const { twimlRouter: voiceTwimlRouter } = require('../backend/src/routes/voice');
const { handleConversationsPost } = require('../backend/src/webhooks/conversationsWebhooks');

function appWith(mountPath, router) {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use(mountPath, router);
    return app;
}

const ORIGINAL_ENV = process.env.NODE_ENV;

beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'production';
    process.env.TWILIO_AUTH_TOKEN = 'test_auth_token';
});

afterAll(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
});

describe('twiml.js POST /voice', () => {
    const app = () => appWith('/twiml', twimlRouter);

    test('rejects an unsigned request with 403 in production', async () => {
        validateTwilioSignature.mockResolvedValue(false);
        const res = await request(app()).post('/twiml/voice').send({ CallSid: 'CA1' });
        expect(res.status).toBe(403);
        expect(validateTwilioSignature).toHaveBeenCalledTimes(1);
    });

    test('serves TwiML when the signature is valid', async () => {
        validateTwilioSignature.mockResolvedValue(true);
        const res = await request(app()).post('/twiml/voice').send({ CallSid: 'CA1' });
        expect(res.status).toBe(200);
        expect(res.text).toContain('<Dial');
    });

    test('bypasses the gate in development (parity with existing suites)', async () => {
        process.env.NODE_ENV = 'development';
        const res = await request(app()).post('/twiml/voice').send({ CallSid: 'CA1' });
        expect(res.status).toBe(200);
        expect(validateTwilioSignature).not.toHaveBeenCalled();
    });
});

describe('voice.js twiml routes', () => {
    const app = () => appWith('/api/voice', voiceTwimlRouter);

    test.each(['/api/voice/twiml/outbound', '/api/voice/twiml/inbound'])(
        'POST %s rejects an unsigned request with 403 before any work',
        async (path) => {
            validateTwilioSignature.mockResolvedValue(false);
            const res = await request(app()).post(path).send({ To: '+15551234567', From: 'client:x' });
            expect(res.status).toBe(403);
            expect(validateTwilioSignature).toHaveBeenCalled();
        },
    );
});

describe('conversationsWebhooks post', () => {
    function makeRes() {
        const res = {};
        res.status = jest.fn().mockReturnValue(res);
        res.send = jest.fn().mockReturnValue(res);
        return res;
    }

    test('fails closed (403) when the signature header is absent in production', async () => {
        const res = makeRes();
        await handleConversationsPost(
            { headers: {}, body: { EventType: 'onMessageAdded' }, originalUrl: '/x' },
            res,
        );
        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('fails closed (403) when the auth token is unset in production', async () => {
        delete process.env.TWILIO_AUTH_TOKEN;
        const res = makeRes();
        await handleConversationsPost(
            { headers: { 'x-twilio-signature': 'sig' }, body: { EventType: 'x' }, originalUrl: '/x' },
            res,
        );
        expect(res.status).toHaveBeenCalledWith(403);
    });
});
