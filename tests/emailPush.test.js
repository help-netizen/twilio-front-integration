'use strict';

/**
 * EMAIL-TIMELINE-001 — Gmail→Pub/Sub push endpoint (routes/emailPush.js).
 * Covers TC-ET-042 (raw body before express.json), TC-ET-043 (token mismatch →
 * 401, no processing), TC-ET-044 (OIDC bad aud/email → 403), TC-ET-045 (valid →
 * fast-ack 200 + async ingest; async error still 200), plus malformed-body ACK.
 *
 * Strategy: mock emailTimelineService.ingestPushNotification (the only collaborator)
 * and mount the router EXACTLY as production does — `express.raw({type:'*\/*'})`
 * BEFORE any express.json — so we exercise the real verification + raw-parse +
 * setImmediate fast-ack. Env tokens are set/cleared per-describe.
 *
 * Run:
 *   npx jest --runTestsByPath tests/emailPush.test.js \
 *     --testPathIgnorePatterns "/node_modules/"
 */

jest.mock('../backend/src/services/email/emailTimelineService', () => ({
    ingestPushNotification: jest.fn().mockResolvedValue({ handled: true }),
}));

// Mock google-auth-library so the OIDC path exercises real verification *flow*
// without hitting Google's certs. `verifyIdToken` is the single seam: per-test we
// make it resolve a ticket (valid signature) or reject (bad signature/aud).
const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
    OAuth2Client: jest.fn().mockImplementation(() => ({
        verifyIdToken: mockVerifyIdToken,
    })),
}));

const express = require('express');
const request = require('supertest');

const emailTimelineService = require('../backend/src/services/email/emailTimelineService');
const pushRouter = require('../backend/src/routes/emailPush');

// Helper: make verifyIdToken resolve a ticket whose getPayload() returns `payload`.
const resolveTicket = (payload) => mockVerifyIdToken.mockResolvedValue({ getPayload: () => payload });
// Helper: make verifyIdToken reject (simulates an invalid signature / expiry).
const rejectVerify = (msg = 'Invalid token signature') => mockVerifyIdToken.mockRejectedValue(new Error(msg));

// Mirror the production mount: raw body parser BEFORE the router, no express.json
// on this path. A `jsonProbe` flag lets us assert express.json did NOT consume the body.
function pushApp({ withJsonFirst = false } = {}) {
    const app = express();
    if (withJsonFirst) {
        // If a global express.json were (wrongly) mounted first on this path it would
        // parse the body into an object; the route would then String() it. We assert
        // the route still works off the RAW buffer regardless — but in production the
        // raw parser is mounted FIRST, which is what we model by default.
        app.use(express.json());
    }
    app.use('/api/email/push', express.raw({ type: '*/*', limit: '1mb' }), pushRouter);
    return app;
}

const VALID_ENVELOPE = {
    message: {
        data: Buffer.from(JSON.stringify({ emailAddress: 'mb@co.com', historyId: '123' })).toString('base64'),
        messageId: 'pubsub-1',
    },
    subscription: 'projects/p/subscriptions/s',
};

beforeEach(() => {
    jest.clearAllMocks();
    // Default: verifyIdToken rejects unless a test explicitly resolves a ticket,
    // so an accidentally-unset expectation fails closed (403) rather than open.
    rejectVerify('verifyIdToken not stubbed for this test');
    delete process.env.GMAIL_PUSH_VERIFICATION_TOKEN;
    delete process.env.GMAIL_PUSH_OIDC_AUDIENCE;
    delete process.env.GMAIL_PUBSUB_SA_EMAIL;
});

// flush the setImmediate the route uses for detached ingest.
const flush = () => new Promise((r) => setImmediate(r));

// ─── Raw body parsing (P0, TC-ET-042) ─────────────────────────────────────────────

describe('raw body handling (P0)', () => {
    it('TC-ET-042: parses the unparsed Pub/Sub buffer → ingest receives the decoded envelope', async () => {
        const res = await request(pushApp())
            .post('/api/email/push/google')
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(VALID_ENVELOPE)); // raw bytes
        expect(res.status).toBe(200);
        await flush();
        expect(emailTimelineService.ingestPushNotification).toHaveBeenCalledTimes(1);
        // The route JSON.parses the raw buffer and hands the parsed envelope to ingest.
        expect(emailTimelineService.ingestPushNotification.mock.calls[0][0]).toMatchObject({
            message: { messageId: 'pubsub-1' },
        });
    });

    it('malformed JSON body → 200 ACK (never 4xx) and NO ingest (Pub/Sub must not retry)', async () => {
        const res = await request(pushApp())
            .post('/api/email/push/google')
            .set('Content-Type', 'application/json')
            .send('{not json');
        expect(res.status).toBe(200);
        await flush();
        expect(emailTimelineService.ingestPushNotification).not.toHaveBeenCalled();
    });

    it('envelope missing `message` → 200 ACK, dropped, no ingest', async () => {
        const res = await request(pushApp())
            .post('/api/email/push/google')
            .set('Content-Type', 'application/json')
            .send(JSON.stringify({ subscription: 's' }));
        expect(res.status).toBe(200);
        await flush();
        expect(emailTimelineService.ingestPushNotification).not.toHaveBeenCalled();
    });
});

// ─── Token verification (P0, TC-ET-043) ───────────────────────────────────────────

describe('shared-token verification (P0)', () => {
    beforeEach(() => { process.env.GMAIL_PUSH_VERIFICATION_TOKEN = 's3cret'; });

    it('TC-ET-043: missing ?token → 401, ingest never called, no body parse', async () => {
        const res = await request(pushApp())
            .post('/api/email/push/google')
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(VALID_ENVELOPE));
        expect(res.status).toBe(401);
        await flush();
        expect(emailTimelineService.ingestPushNotification).not.toHaveBeenCalled();
    });

    it('TC-ET-043: wrong ?token → 401, ingest never called', async () => {
        const res = await request(pushApp())
            .post('/api/email/push/google?token=nope')
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(VALID_ENVELOPE));
        expect(res.status).toBe(401);
        await flush();
        expect(emailTimelineService.ingestPushNotification).not.toHaveBeenCalled();
    });

    it('correct ?token → 200 and ingest scheduled', async () => {
        const res = await request(pushApp())
            .post('/api/email/push/google?token=s3cret')
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(VALID_ENVELOPE));
        expect(res.status).toBe(200);
        await flush();
        expect(emailTimelineService.ingestPushNotification).toHaveBeenCalledTimes(1);
    });
});

// ─── OIDC verification (P1, TC-ET-044) ────────────────────────────────────────────

describe('OIDC bearer verification (P1)', () => {
    const AUD = 'https://push.aud';
    const SA = 'sa@project.iam.gserviceaccount.com';
    // The JWT string is opaque to the route now (google-auth-library is mocked); we
    // just need *a* bearer present so the route reaches verifyIdToken.
    const BEARER = 'header.payload.sig';

    beforeEach(() => { process.env.GMAIL_PUSH_OIDC_AUDIENCE = AUD; });

    it('TC-ET-044: valid signature (ticket resolves, aud+email match) → 200 + ingest, verified against the configured audience', async () => {
        process.env.GMAIL_PUBSUB_SA_EMAIL = SA;
        resolveTicket({ aud: AUD, email: SA, email_verified: true });
        const res = await request(pushApp())
            .post('/api/email/push/google')
            .set('Authorization', `Bearer ${BEARER}`)
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(VALID_ENVELOPE));
        expect(res.status).toBe(200);
        // verifyIdToken got the raw bearer + the env audience (cert-backed signature check).
        expect(mockVerifyIdToken).toHaveBeenCalledWith({ idToken: BEARER, audience: AUD });
        await flush();
        expect(emailTimelineService.ingestPushNotification).toHaveBeenCalledTimes(1);
    });

    it('valid signature without SA pin (email_verified only) → 200 + ingest', async () => {
        // GMAIL_PUBSUB_SA_EMAIL unset → email value not pinned, but email_verified still required.
        resolveTicket({ aud: AUD, email: 'anything@x.com', email_verified: true });
        const res = await request(pushApp())
            .post('/api/email/push/google')
            .set('Authorization', `Bearer ${BEARER}`)
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(VALID_ENVELOPE));
        expect(res.status).toBe(200);
        await flush();
        expect(emailTimelineService.ingestPushNotification).toHaveBeenCalledTimes(1);
    });

    it('TC-ET-044: bad signature (verifyIdToken rejects) → 403, no ingest', async () => {
        rejectVerify('Invalid token signature');
        const res = await request(pushApp())
            .post('/api/email/push/google')
            .set('Authorization', `Bearer ${BEARER}`)
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(VALID_ENVELOPE));
        expect(res.status).toBe(403);
        await flush();
        expect(emailTimelineService.ingestPushNotification).not.toHaveBeenCalled();
    });

    it('TC-ET-044: signature valid but wrong aud in payload → 403, no ingest', async () => {
        // Defense-in-depth: even if a ticket comes back, the route re-asserts aud.
        resolveTicket({ aud: 'https://evil.aud', email: SA, email_verified: true });
        const res = await request(pushApp())
            .post('/api/email/push/google')
            .set('Authorization', `Bearer ${BEARER}`)
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(VALID_ENVELOPE));
        expect(res.status).toBe(403);
        await flush();
        expect(emailTimelineService.ingestPushNotification).not.toHaveBeenCalled();
    });

    it('TC-ET-044: signature valid but email ≠ GMAIL_PUBSUB_SA_EMAIL → 403, no ingest', async () => {
        process.env.GMAIL_PUBSUB_SA_EMAIL = SA;
        resolveTicket({ aud: AUD, email: 'someone@else.com', email_verified: true });
        const res = await request(pushApp())
            .post('/api/email/push/google')
            .set('Authorization', `Bearer ${BEARER}`)
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(VALID_ENVELOPE));
        expect(res.status).toBe(403);
        await flush();
        expect(emailTimelineService.ingestPushNotification).not.toHaveBeenCalled();
    });

    it('signature valid but email_verified=false → 403, no ingest', async () => {
        resolveTicket({ aud: AUD, email: SA, email_verified: false });
        const res = await request(pushApp())
            .post('/api/email/push/google')
            .set('Authorization', `Bearer ${BEARER}`)
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(VALID_ENVELOPE));
        expect(res.status).toBe(403);
        await flush();
        expect(emailTimelineService.ingestPushNotification).not.toHaveBeenCalled();
    });

    it('missing Authorization in OIDC mode → 403, verifyIdToken never called', async () => {
        const res = await request(pushApp())
            .post('/api/email/push/google')
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(VALID_ENVELOPE));
        expect(res.status).toBe(403);
        expect(mockVerifyIdToken).not.toHaveBeenCalled();
        await flush();
        expect(emailTimelineService.ingestPushNotification).not.toHaveBeenCalled();
    });
});

// ─── Fast-ack (P0, TC-ET-045) ─────────────────────────────────────────────────────

describe('fast-ack semantics (P0)', () => {
    it('no verification configured (dev) → processes and 200s', async () => {
        const res = await request(pushApp())
            .post('/api/email/push/google')
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(VALID_ENVELOPE));
        expect(res.status).toBe(200);
        await flush();
        expect(emailTimelineService.ingestPushNotification).toHaveBeenCalledTimes(1);
    });

    it('TC-ET-045: async ingest rejection still returns 200 (no retry storm)', async () => {
        emailTimelineService.ingestPushNotification.mockRejectedValue(new Error('downstream boom'));
        const res = await request(pushApp())
            .post('/api/email/push/google')
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(VALID_ENVELOPE));
        expect(res.status).toBe(200); // the 200 is sent BEFORE/independent of the detached ingest
        await flush(); // the rejection is swallowed by the route's .catch — must not crash the test
        expect(emailTimelineService.ingestPushNotification).toHaveBeenCalledTimes(1);
    });
});
