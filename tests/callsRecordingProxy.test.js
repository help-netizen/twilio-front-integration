// OUTBOUND-CALL-TIMELINE-001 / CT-03 — recording playback proxy.
// The GET /:callSid/recording.mp3 route streams Twilio `RE…` recordings via the
// Twilio REST API (Basic auth). VAPI robot-call recordings are stored as a
// self-authorizing CDN URL under a synthetic `vapi_<id>` sid (written by
// vapiCallTimelineService finalize) — those must stream straight from
// recording_url instead. Branch keyed off `/^RE/i.test(recording_sid)`.
const express = require('express');
const request = require('supertest');
const { Readable } = require('stream');

jest.mock('node-fetch');
const fetch = require('node-fetch');

// getCallMedia is the ONLY db access the recording route makes.
const mockGetCallMedia = jest.fn();
jest.mock('../backend/src/db/queries', () => ({
    getCallMedia: (...args) => mockGetCallMedia(...args),
}));

// Top-level requires in routes/calls.js — stub the heavy ones (mirror
// callsTransfer.test.js) so the module loads without real infra.
jest.mock('../backend/src/services/callSummaryService', () => ({ generateCallSummary: jest.fn() }));
jest.mock('../backend/src/services/operationsDashboard', () => ({
    getOperationsDashboard: jest.fn(),
    flowPathFromContext: jest.fn(),
}));
jest.mock('../backend/src/services/agentPresence', () => ({ getAgentStatus: jest.fn() }));
jest.mock('../backend/src/services/twilioClient', () => ({ getTwilioClient: jest.fn() }));
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
// requirePermission logs denials through auditService — keep it inert so the
// company/authz-gate test doesn't touch real infra.
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const callsRouter = require('../backend/src/routes/calls');

// Build an app whose middleware injects the same shape authenticate +
// requireCompanyAccess would (company context + effective permissions).
function makeApp({ companyId = 'company-1', permissions = ['reports.calls.view'] } = {}) {
    const app = express();
    app.use((req, _res, next) => {
        req.companyFilter = { company_id: companyId };
        req.authz = { scope: 'tenant', permissions, scopes: {} };
        next();
    });
    app.use('/api/calls', callsRouter);
    return app;
}

// Fake node-fetch Response with a pipeable body + header getter.
function fakeUpstream({ ok = true, status = 200, contentType = 'audio/wav', contentLength = '9', body = 'FAKEAUDIO' } = {}) {
    const headers = { 'content-type': contentType, 'content-length': contentLength };
    return {
        ok,
        status,
        headers: { get: (k) => (k == null ? null : headers[String(k).toLowerCase()] ?? null) },
        body: Readable.from([Buffer.from(body)]),
    };
}

// superagent binary collector so we can assert the streamed bytes.
function binaryParser(res, callback) {
    res.setEncoding('binary');
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => callback(null, Buffer.from(data, 'binary')));
}

describe('CT-03 recording proxy — Twilio-sid vs VAPI recording_url branching', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    // (a) Twilio RE… recording — unchanged Twilio REST branch.
    test('(a) RExxxx recording streams via the Twilio REST branch (Basic auth), unchanged', async () => {
        process.env.TWILIO_ACCOUNT_SID = 'AC_test';
        process.env.TWILIO_AUTH_TOKEN = 'auth_test';
        mockGetCallMedia.mockResolvedValue({
            recordings: [{ recording_sid: 'RE12345', status: 'completed', recording_url: null }],
            transcripts: [],
        });
        fetch.mockResolvedValue(fakeUpstream({ contentType: 'audio/mpeg', contentLength: '11', body: 'TWILIOAUDIO' }));

        const res = await request(makeApp()).get('/api/calls/CA_call_1/recording.mp3');

        expect(res.status).toBe(200);
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, opts] = fetch.mock.calls[0];
        expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test/Recordings/RE12345.mp3');
        expect(opts.headers.Authorization).toMatch(/^Basic /); // Twilio needs auth
        expect(res.headers['content-type']).toContain('audio/mpeg'); // route hardcodes for Twilio
        expect(res.headers['accept-ranges']).toBe('bytes');
        expect(res.headers['content-length']).toBe('11');
    });

    // (b) VAPI recording — streams from recording_url, NOT Twilio, no auth header.
    test('(b) VAPI recording (non-RE sid + recording_url) streams from the URL, not Twilio', async () => {
        process.env.TWILIO_ACCOUNT_SID = 'AC_test'; // present, but must NOT be used
        process.env.TWILIO_AUTH_TOKEN = 'auth_test';
        const recUrl = 'https://storage.vapi.ai/recordings/rec-abc.wav';
        mockGetCallMedia.mockResolvedValue({
            recordings: [{ recording_sid: 'vapi_abc123', status: 'completed', recording_url: recUrl }],
            transcripts: [],
        });
        fetch.mockResolvedValue(fakeUpstream({ contentType: 'audio/wav', contentLength: '9', body: 'FAKEAUDIO' }));

        const res = await request(makeApp())
            .get('/api/calls/vapi_abc123/recording.mp3')
            .buffer(true)
            .parse(binaryParser);

        expect(res.status).toBe(200);
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, opts] = fetch.mock.calls[0];
        expect(url).toBe(recUrl); // the CDN URL itself
        expect(url).not.toContain('api.twilio.com'); // NOT the Twilio REST path
        // Self-authorizing: no Authorization header forwarded.
        expect(opts && opts.headers && opts.headers.Authorization).toBeUndefined();
        expect(res.headers['content-type']).toContain('audio/wav'); // from upstream
        expect(res.headers['accept-ranges']).toBe('bytes');
        expect(res.headers['content-length']).toBe('9');
        expect(Buffer.isBuffer(res.body) ? res.body.toString() : '').toBe('FAKEAUDIO'); // bytes piped through
    });

    // (c) Company/authz scoping — the route-level auth check the proxy enforces
    // applies to BOTH branches: a caller without calls-history / pulse permission
    // for this company is denied before any recording (incl. a VAPI row) is served.
    test('(c) caller lacking reports.calls.view/pulse.view is denied (403) — no VAPI recording served', async () => {
        const recUrl = 'https://storage.vapi.ai/recordings/rec-foreign.wav';
        mockGetCallMedia.mockResolvedValue({
            recordings: [{ recording_sid: 'vapi_foreign', status: 'completed', recording_url: recUrl }],
            transcripts: [],
        });
        fetch.mockResolvedValue(fakeUpstream());

        const res = await request(makeApp({ permissions: [] })) // no calls/pulse permission
            .get('/api/calls/vapi_foreign/recording.mp3');

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        expect(fetch).not.toHaveBeenCalled(); // never reached the streaming branch
        expect(mockGetCallMedia).not.toHaveBeenCalled();
    });

    // (d) URL-fetch failure → clean 502, no crash — upstream !ok.
    test('(d1) VAPI recording_url upstream !ok → 502, no crash', async () => {
        const recUrl = 'https://storage.vapi.ai/recordings/rec-500.wav';
        mockGetCallMedia.mockResolvedValue({
            recordings: [{ recording_sid: 'vapi_err', status: 'completed', recording_url: recUrl }],
            transcripts: [],
        });
        fetch.mockResolvedValue(fakeUpstream({ ok: false, status: 500 }));

        const res = await request(makeApp()).get('/api/calls/vapi_err/recording.mp3');

        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: 'Failed to fetch recording' });
    });

    // (d) URL-fetch failure → clean 502, no crash — fetch throws (network error).
    test('(d2) VAPI recording_url fetch throws → 502, no crash', async () => {
        const recUrl = 'https://storage.vapi.ai/recordings/rec-dns.wav';
        mockGetCallMedia.mockResolvedValue({
            recordings: [{ recording_sid: 'vapi_throw', status: 'completed', recording_url: recUrl }],
            transcripts: [],
        });
        fetch.mockRejectedValue(new Error('ECONNREFUSED'));

        const res = await request(makeApp()).get('/api/calls/vapi_throw/recording.mp3');

        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: 'Failed to fetch recording' });
    });

    // Non-Twilio recording with no URL to stream from → 404 (spec S8: require URL).
    test('(e) non-RE recording without recording_url → 404, no fetch', async () => {
        mockGetCallMedia.mockResolvedValue({
            recordings: [{ recording_sid: 'vapi_nourl', status: 'completed', recording_url: null }],
            transcripts: [],
        });

        const res = await request(makeApp()).get('/api/calls/vapi_nourl/recording.mp3');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Recording not available' });
        expect(fetch).not.toHaveBeenCalled();
    });
});
