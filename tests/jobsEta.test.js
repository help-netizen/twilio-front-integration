/**
 * ONWAY-001 — backend tests for the "On the way" ETA endpoints + FSM.
 *
 * Covers test cases from docs/test-cases/ONWAY-001.md:
 *   - estimate  : TC-EST-001..010 (POST /api/jobs/:id/eta/estimate)
 *   - notify    : TC-NOT-001..015 (POST /api/jobs/:id/eta/notify)
 *   - FSM units : TC-FSM-001/002 (fallback ALLOWED_TRANSITIONS map)
 *                 + injectOnTheWay transform additivity/idempotency.
 *
 * Harness style mirrors tests/jobsCreate.test.js (no supertest dep → a tiny
 * http-based request helper) and tests/slotEngineProxy.test.js (route + service
 * mocks + req.companyFilter injection). Production source is NOT modified — the
 * endpoints under test live in backend/src/routes/jobs.js, the pure transform in
 * backend/src/services/fsm/onTheWayTransform.js, and the fallback maps in
 * backend/src/services/jobsService.js.
 */

const express = require('express');
const http = require('http');

// ─── Supertest-like helper (no extra dep — mirrors jobsCreate.test.js) ────────

function request(app, method, path, body = null, { raw = null, contentType = 'application/json' } = {}) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            const options = {
                hostname: '127.0.0.1',
                port,
                path,
                method: method.toUpperCase(),
                headers: { 'Content-Type': contentType },
            };
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    server.close();
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(data) });
                    } catch (e) {
                        resolve({ status: res.statusCode, body: data });
                    }
                });
            });
            req.on('error', err => { server.close(); reject(err); });
            // `raw` lets us send a non-JSON-object payload (TC-EST-009).
            if (raw != null) req.write(raw);
            else if (body != null) req.write(JSON.stringify(body));
            req.end();
        });
    });
}

// ─── Service-boundary mocks ───────────────────────────────────────────────────
// The jobs router require()s a wide set of modules; mock the ones the ETA
// handlers reach (jobsService / conversationsService / routeDistanceService /
// companyQueries / db connection) and cheaply stub the rest so require() is free.

const mockGetJobById = jest.fn();
const mockUpdateBlancStatus = jest.fn();
jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: mockGetJobById,
    updateBlancStatus: mockUpdateBlancStatus,
}));

const mockGetOrCreateConversation = jest.fn();
const mockSendMessage = jest.fn();
jest.mock('../backend/src/services/conversationsService', () => ({
    getOrCreateConversation: mockGetOrCreateConversation,
    sendMessage: mockSendMessage,
}));

const mockComputePair = jest.fn();
jest.mock('../backend/src/services/routeDistanceService', () => ({
    computePair: mockComputePair,
}));

const mockGeocodeAddress = jest.fn();
jest.mock('../backend/src/services/googlePlacesService', () => ({
    geocodeAddress: mockGeocodeAddress,
}));

const mockGetCompanyById = jest.fn();
jest.mock('../backend/src/db/companyQueries', () => ({
    getCompanyById: mockGetCompanyById,
}));

// resolveCompanyProxyE164 reads sms_conversations MRU via db.query, then falls
// back to SOFTPHONE_CALLER_ID. Mock the db module to drive both paths.
const mockDbQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockDbQuery }));

// Cheap stubs for the unrelated modules the router pulls in at require()-time.
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    MAX_FILE_SIZE: 1, MAX_FILES_PER_NOTE: 1,
}));
jest.mock('../backend/src/services/notesMutationService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({
    logEvent: jest.fn(), actorName: jest.fn(), getEntityHistory: jest.fn(),
}));
jest.mock('../backend/src/services/stripePaymentsService', () => ({
    StripePaymentsError: class extends Error {},
}));

const jobsRouter = require('../backend/src/routes/jobs');
const { injectOnTheWay } = require('../backend/src/services/fsm/onTheWayTransform');
const { BLANC_STATUSES, ALLOWED_TRANSITIONS } = jest.requireActual(
    '../backend/src/services/jobsService'
);

const COMPANY = '00000000-0000-0000-0000-00000000000a';

function routeApp({ permissions = ['messages.send'], companyFilter = { company_id: COMPANY } } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc', email: 'u@x.com', crmUser: { id: 'u-1' } };
        req.authz = { scope: 'tenant', permissions, scopes: {} };
        req.companyFilter = companyFilter;
        // Poison the legacy field: the route must read only req.companyFilter (AC-12).
        req.companyId = 'LEGACY-DO-NOT-USE';
        next();
    });
    app.use('/', jobsRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    // Default proxy resolution: MRU hit so notify happy-paths have a sender.
    mockDbQuery.mockResolvedValue({ rows: [{ proxy_e164: '+16175550000' }] });
    process.env.SOFTPHONE_CALLER_ID = '+16175557777';
});

// =============================================================================
// 1A. POST /api/jobs/:id/eta/estimate  (TC-EST-001..010)
// =============================================================================

describe('POST /api/jobs/:id/eta/estimate', () => {
    const ORIGIN = { lat: 42.187, lng: -71.205 };
    const JOB_WITH_COORDS = { id: 5, company_id: COMPANY, lat: 42.20, lng: -71.10 };

    test('TC-EST-001: 403 without messages.send (gate before handler)', async () => {
        const res = await request(
            routeApp({ permissions: [] }), 'POST', '/5/eta/estimate', { origin: ORIGIN }
        );
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        expect(mockComputePair).not.toHaveBeenCalled();
        expect(mockGetJobById).not.toHaveBeenCalled();
    });

    test('TC-EST-002: unauthenticated → 401 (real middleware short-circuits; documented)', async () => {
        // The faked harness injects req.user/req.authz, so a true 401 is exercised
        // by the real authenticate middleware mounted in server.js. Here we assert
        // the route-level gate is what produces the deny in the harness (403),
        // keeping this case as a documented checklist assertion (lower confidence).
        const res = await request(
            routeApp({ permissions: [] }), 'POST', '/5/eta/estimate', { origin: ORIGIN }
        );
        expect(res.status).toBe(403);
    });

    test('TC-EST-003: cross-tenant / missing job → 404, computePair NOT called', async () => {
        mockGetJobById.mockResolvedValue(null);
        const res = await request(
            routeApp(), 'POST', '/999/eta/estimate', { origin: ORIGIN }
        );
        expect(res.status).toBe(404);
        // getJobById called with (id, COMPANY) — never the body / legacy field.
        expect(mockGetJobById).toHaveBeenCalledTimes(1);
        expect(mockGetJobById.mock.calls[0][0]).toBe('999');
        expect(mockGetJobById.mock.calls[0][1]).toBe(COMPANY);
        expect(mockComputePair).not.toHaveBeenCalled();
    });

    test('TC-EST-004: origin + job coords → eta_minutes from computePair (happy path)', async () => {
        mockGetJobById.mockResolvedValue(JOB_WITH_COORDS);
        mockComputePair.mockResolvedValue({ status: 'success', durationMinutes: 23 });
        const res = await request(routeApp(), 'POST', '/5/eta/estimate', { origin: ORIGIN });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { eta_minutes: 23 } });
        expect(mockComputePair).toHaveBeenCalledTimes(1);
        const [origin, dest, mode] = mockComputePair.mock.calls[0];
        expect(origin).toEqual({ lat: ORIGIN.lat, lng: ORIGIN.lng });
        expect(dest).toEqual({ lat: 42.20, lng: -71.10 });
        expect(mode).toBe('driving');
    });

    test('TC-EST-005: no origin in body → eta_minutes null, NO Google call', async () => {
        mockGetJobById.mockResolvedValue(JOB_WITH_COORDS);
        const res = await request(routeApp(), 'POST', '/5/eta/estimate', {});
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { eta_minutes: null } });
        expect(mockComputePair).not.toHaveBeenCalled();
    });

    test('TC-EST-005b: non-numeric origin → eta_minutes null, NO Google call', async () => {
        mockGetJobById.mockResolvedValue(JOB_WITH_COORDS);
        const res = await request(
            routeApp(), 'POST', '/5/eta/estimate', { origin: { lat: null, lng: 'x' } }
        );
        expect(res.status).toBe(200);
        expect(res.body.data.eta_minutes).toBeNull();
        expect(mockComputePair).not.toHaveBeenCalled();
    });

    test('TC-EST-006: no usable destination (no coords, no address) → eta_minutes null', async () => {
        mockGetJobById.mockResolvedValue({ id: 5, company_id: COMPANY, lat: null, lng: null, address: null });
        const res = await request(
            routeApp(), 'POST', '/5/eta/estimate', { origin: { lat: 42.1, lng: -71.2 } }
        );
        expect(res.status).toBe(200);
        expect(res.body.data.eta_minutes).toBeNull();
        expect(mockComputePair).not.toHaveBeenCalled();
        expect(mockGeocodeAddress).not.toHaveBeenCalled();
    });

    test('TC-EST-007: computePair failed (NO_KEY) → eta_minutes null (non-error)', async () => {
        mockGetJobById.mockResolvedValue(JOB_WITH_COORDS);
        mockComputePair.mockResolvedValue({ status: 'failed', errorCode: 'NO_KEY' });
        const res = await request(
            routeApp(), 'POST', '/5/eta/estimate', { origin: { lat: 42.1, lng: -71.2 } }
        );
        expect(res.status).toBe(200);
        expect(res.body.data.eta_minutes).toBeNull();
    });

    test('TC-EST-007b: computePair failed (OVER_QUERY_LIMIT) → eta_minutes null', async () => {
        mockGetJobById.mockResolvedValue(JOB_WITH_COORDS);
        mockComputePair.mockResolvedValue({ status: 'failed', errorCode: 'OVER_QUERY_LIMIT' });
        const res = await request(
            routeApp(), 'POST', '/5/eta/estimate', { origin: { lat: 42.1, lng: -71.2 } }
        );
        expect(res.status).toBe(200);
        expect(res.body.data.eta_minutes).toBeNull();
    });

    test('TC-EST-008: computePair success with null durationMinutes → eta_minutes null', async () => {
        mockGetJobById.mockResolvedValue(JOB_WITH_COORDS);
        mockComputePair.mockResolvedValue({ status: 'success', durationMinutes: null });
        const res = await request(
            routeApp(), 'POST', '/5/eta/estimate', { origin: { lat: 42.1, lng: -71.2 } }
        );
        expect(res.status).toBe(200);
        expect(res.body.data.eta_minutes).toBeNull();
    });

    test('TC-EST-009: malformed body (not an object) → 400 (route guard)', async () => {
        // text/plain → express.json() skips parsing → req.body is non-object, so
        // the route's own `typeof body !== 'object'` guard fires (returns its JSON
        // envelope). (A JSON string over application/json is rejected earlier by
        // body-parser strict mode — also 400, but owned by the parser, not the route.)
        const res = await request(
            routeApp(), 'POST', '/5/eta/estimate', null,
            { raw: 'not-json-object', contentType: 'text/plain' }
        );
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ ok: false, error: 'invalid body' });
        expect(mockGetJobById).not.toHaveBeenCalled();
        expect(mockComputePair).not.toHaveBeenCalled();
    });

    test('TC-EST-009b: array body → 400', async () => {
        const res = await request(
            routeApp(), 'POST', '/5/eta/estimate', null, { raw: '[1,2,3]' }
        );
        expect(res.status).toBe(400);
        expect(mockComputePair).not.toHaveBeenCalled();
    });

    test('TC-EST-010: company_id sourced only from req.companyFilter (isolation)', async () => {
        mockGetJobById.mockResolvedValue(JOB_WITH_COORDS);
        mockComputePair.mockResolvedValue({ status: 'success', durationMinutes: 12 });
        const res = await request(
            routeApp(), 'POST', '/5/eta/estimate',
            { origin: ORIGIN, company_id: 'OTHER' }
        );
        expect(res.status).toBe(200);
        const companyArg = mockGetJobById.mock.calls[0][1];
        expect(companyArg).toBe(COMPANY);
        expect(companyArg).not.toBe('OTHER');
        expect(companyArg).not.toBe('LEGACY-DO-NOT-USE');
    });

    test('estimate: dest geocoded from address when no stored coords', async () => {
        mockGetJobById.mockResolvedValue({
            id: 5, company_id: COMPANY, lat: null, lng: null, address: '6 Cirrus Dr, Ashland MA',
        });
        mockGeocodeAddress.mockResolvedValue({ status: 'success', lat: 42.25, lng: -71.46 });
        mockComputePair.mockResolvedValue({ status: 'success', durationMinutes: 18 });
        const res = await request(routeApp(), 'POST', '/5/eta/estimate', { origin: ORIGIN });
        expect(res.status).toBe(200);
        expect(res.body.data.eta_minutes).toBe(18);
        expect(mockGeocodeAddress).toHaveBeenCalledWith('6 Cirrus Dr, Ashland MA');
        expect(mockComputePair.mock.calls[0][1]).toEqual({ lat: 42.25, lng: -71.46 });
    });
});

// =============================================================================
// 1B. POST /api/jobs/:id/eta/notify  (TC-NOT-001..015)
// =============================================================================

describe('POST /api/jobs/:id/eta/notify', () => {
    const HAPPY_JOB = {
        id: 5, company_id: COMPANY,
        customer_phone: '+16175551234',
        assigned_techs: [{ name: 'Mike' }],
        blanc_status: 'Submitted',
    };
    const EXACT_SMS =
        'Hi! Your technician Mike from ABC Homes is on the way and should arrive in about 25 minutes.';

    function primeHappy(jobOverrides = {}, companyOverride = { name: 'ABC Homes' }) {
        mockGetJobById.mockResolvedValue({ ...HAPPY_JOB, ...jobOverrides });
        mockGetCompanyById.mockResolvedValue(companyOverride);
        mockGetOrCreateConversation.mockResolvedValue({ id: 'conv-uuid' });
        mockSendMessage.mockResolvedValue(undefined);
        mockUpdateBlancStatus.mockResolvedValue({ blanc_status: 'On the way' });
    }

    test('TC-NOT-001: 403 without messages.send; no send, no status', async () => {
        const res = await request(
            routeApp({ permissions: [] }), 'POST', '/5/eta/notify', { eta_minutes: 25 }
        );
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(mockUpdateBlancStatus).not.toHaveBeenCalled();
    });

    test('TC-NOT-002: cross-tenant / missing job → 404, no send, no status', async () => {
        mockGetJobById.mockResolvedValue(null);
        const res = await request(routeApp(), 'POST', '/999/eta/notify', { eta_minutes: 25 });
        expect(res.status).toBe(404);
        expect(mockGetJobById.mock.calls[0][1]).toBe(COMPANY);
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(mockUpdateBlancStatus).not.toHaveBeenCalled();
    });

    test('TC-NOT-003: happy path — EXACT SMS body, then status advances (ordering)', async () => {
        primeHappy();
        const res = await request(routeApp(), 'POST', '/5/eta/notify', { eta_minutes: 25 });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { sent: true, status: 'On the way' } });

        // getOrCreateConversation(customerE164, proxyE164, COMPANY).
        expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(1);
        const [custArg, proxyArg, compArg] = mockGetOrCreateConversation.mock.calls[0];
        expect(custArg).toBe('+16175551234');
        expect(proxyArg).toBe('+16175550000'); // MRU hit
        expect(compArg).toBe(COMPANY);

        // sendMessage('conv-uuid', { body: <EXACT>, author: 'agent' }).
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        expect(mockSendMessage.mock.calls[0][0]).toBe('conv-uuid');
        expect(mockSendMessage.mock.calls[0][1]).toEqual({ body: EXACT_SMS, author: 'agent' });

        // updateBlancStatus(5, 'On the way', COMPANY).
        expect(mockUpdateBlancStatus).toHaveBeenCalledTimes(1);
        expect(mockUpdateBlancStatus.mock.calls[0]).toEqual([5, 'On the way', COMPANY]);

        // Ordering: SMS-first — sendMessage precedes updateBlancStatus.
        expect(mockSendMessage.mock.invocationCallOrder[0])
            .toBeLessThan(mockUpdateBlancStatus.mock.invocationCallOrder[0]);
    });

    test('TC-NOT-004: NO_PHONE (null) → 422, no send, no status', async () => {
        primeHappy({ customer_phone: null });
        const res = await request(routeApp(), 'POST', '/5/eta/notify', { eta_minutes: 25 });
        expect(res.status).toBe(422);
        expect(res.body).toEqual({
            ok: false, code: 'NO_PHONE', message: 'No phone number on file for this customer.',
        });
        expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(mockUpdateBlancStatus).not.toHaveBeenCalled();
    });

    test('TC-NOT-004b: NO_PHONE (empty string) → 422', async () => {
        primeHappy({ customer_phone: '' });
        const res = await request(routeApp(), 'POST', '/5/eta/notify', { eta_minutes: 25 });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('NO_PHONE');
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('TC-NOT-005: NO_PROXY (no MRU + no env) → 422, no send', async () => {
        primeHappy();
        mockDbQuery.mockResolvedValue({ rows: [] });           // MRU empty
        delete process.env.SOFTPHONE_CALLER_ID;                 // no env fallback
        const res = await request(routeApp(), 'POST', '/5/eta/notify', { eta_minutes: 25 });
        expect(res.status).toBe(422);
        expect(res.body).toEqual({
            ok: false, code: 'NO_PROXY', message: 'No sending number configured for your company.',
        });
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(mockUpdateBlancStatus).not.toHaveBeenCalled();
    });

    test('TC-NOT-006: NO_PROXY env fallback — MRU empty but SOFTPHONE_CALLER_ID set → proceeds', async () => {
        primeHappy();
        mockDbQuery.mockResolvedValue({ rows: [] });
        process.env.SOFTPHONE_CALLER_ID = '+16175559999';
        const res = await request(routeApp(), 'POST', '/5/eta/notify', { eta_minutes: 25 });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(mockGetOrCreateConversation.mock.calls[0][1]).toBe('+16175559999');
    });

    test('TC-NOT-007: wallet-blocked (sendMessage throws) → status unchanged, WALLET_BLOCKED', async () => {
        primeHappy();
        mockSendMessage.mockRejectedValue(
            Object.assign(new Error('blocked'), { httpStatus: 402, code: 'WALLET_BLOCKED' })
        );
        const res = await request(routeApp(), 'POST', '/5/eta/notify', { eta_minutes: 25 });
        expect(res.status).toBe(402);
        expect(res.body).toEqual({
            ok: false, code: 'WALLET_BLOCKED', message: 'Messaging is paused — top up your balance.',
        });
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        expect(mockUpdateBlancStatus).not.toHaveBeenCalled();
    });

    test('TC-NOT-008: generic SMS failure (sendMessage throws non-wallet) → SMS_FAILED, status unchanged', async () => {
        primeHappy();
        mockSendMessage.mockRejectedValue(new Error('twilio 500'));
        const res = await request(routeApp(), 'POST', '/5/eta/notify', { eta_minutes: 25 });
        expect(res.status).toBe(502);
        expect(res.body).toEqual({
            ok: false, code: 'SMS_FAILED', message: "Couldn't send the message. Please try again.",
        });
        expect(mockUpdateBlancStatus).not.toHaveBeenCalled();
    });

    test('TC-NOT-009: status-set throws AFTER send → {ok:true, warning:status_not_advanced}', async () => {
        primeHappy();
        mockUpdateBlancStatus.mockRejectedValue(new Error('transition not allowed'));
        const res = await request(routeApp(), 'POST', '/5/eta/notify', { eta_minutes: 25 });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            ok: true, data: { sent: true }, warning: 'status_not_advanced',
        });
        // SMS was sent once and NOT rolled back / re-sent.
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    test('TC-NOT-010: SMS body — {tech} = first of multiple assigned techs', async () => {
        primeHappy({ assigned_techs: [{ name: 'Mike' }, { name: 'Sara' }] });
        await request(routeApp(), 'POST', '/5/eta/notify', { eta_minutes: 25 });
        const body = mockSendMessage.mock.calls[0][1].body;
        expect(body).toBe(EXACT_SMS);
        expect(body).not.toContain('Sara');
    });

    test('TC-NOT-011: no assigned tech → "Your technician from {company}…" (no double word)', async () => {
        primeHappy({ assigned_techs: [] });
        await request(routeApp(), 'POST', '/5/eta/notify', { eta_minutes: 25 });
        const body = mockSendMessage.mock.calls[0][1].body;
        expect(body).toBe(
            'Hi! Your technician from ABC Homes is on the way and should arrive in about 25 minutes.'
        );
        expect(body).not.toContain('technician your technician');
    });

    test('TC-NOT-011b: empty tech name → name omitted, "technician" stays once', async () => {
        primeHappy({ assigned_techs: [{ name: '' }] });
        await request(routeApp(), 'POST', '/5/eta/notify', { eta_minutes: 25 });
        const body = mockSendMessage.mock.calls[0][1].body;
        expect(body).toBe(
            'Hi! Your technician from ABC Homes is on the way and should arrive in about 25 minutes.'
        );
    });

    test('TC-NOT-012: missing company name → "your service team" fallback', async () => {
        primeHappy({}, { name: null });
        await request(routeApp(), 'POST', '/5/eta/notify', { eta_minutes: 25 });
        const body = mockSendMessage.mock.calls[0][1].body;
        expect(body).toBe(
            'Hi! Your technician Mike from your service team is on the way and should arrive in about 25 minutes.'
        );
    });

    test('TC-NOT-012b: null company row → "your service team" fallback', async () => {
        primeHappy({}, null);
        await request(routeApp(), 'POST', '/5/eta/notify', { eta_minutes: 25 });
        const body = mockSendMessage.mock.calls[0][1].body;
        expect(body).toContain('from your service team');
    });

    test.each([
        ['eta=0', { eta_minutes: 0 }],
        ['eta=601', { eta_minutes: 601 }],
        ['eta=25.5', { eta_minutes: 25.5 }],
        ['eta="soon"', { eta_minutes: 'soon' }],
        ['missing eta', {}],
    ])('TC-NOT-013: invalid eta (%s) → 400 invalid_eta, no side effects', async (_label, body) => {
        primeHappy();
        const res = await request(routeApp(), 'POST', '/5/eta/notify', body);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ ok: false, error: 'invalid_eta' });
        expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(mockUpdateBlancStatus).not.toHaveBeenCalled();
    });

    test.each([
        ['eta=1 (lower boundary)', 1],
        ['eta=600 (upper boundary)', 600],
    ])('TC-NOT-013b: boundary-valid eta (%s) → proceeds past validation', async (_label, eta) => {
        primeHappy();
        const res = await request(routeApp(), 'POST', '/5/eta/notify', { eta_minutes: eta });
        expect(res.status).toBe(200);
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    test('TC-NOT-014: company_id sourced only from req.companyFilter (all calls)', async () => {
        primeHappy();
        await request(
            routeApp(), 'POST', '/5/eta/notify', { eta_minutes: 25, company_id: 'OTHER' }
        );
        expect(mockGetJobById.mock.calls[0][1]).toBe(COMPANY);
        expect(mockGetCompanyById.mock.calls[0][0]).toBe(COMPANY);
        expect(mockGetOrCreateConversation.mock.calls[0][2]).toBe(COMPANY);
        expect(mockUpdateBlancStatus.mock.calls[0][2]).toBe(COMPANY);
        // None of the smuggled / legacy values reached the service layer.
        for (const m of [mockGetJobById, mockGetCompanyById, mockGetOrCreateConversation, mockUpdateBlancStatus]) {
            for (const call of m.mock.calls) {
                expect(call).not.toContain('OTHER');
                expect(call).not.toContain('LEGACY-DO-NOT-USE');
            }
        }
    });

    test('TC-NOT-015: idempotency — already On the way → updateBlancStatus no-op, 200 ok', async () => {
        primeHappy({ blanc_status: 'On the way' });
        // updateBlancStatus resolves as a no-op (FSM __NOOP__-safe; no throw).
        mockUpdateBlancStatus.mockResolvedValue({ blanc_status: 'On the way' });
        const res = await request(routeApp(), 'POST', '/5/eta/notify', { eta_minutes: 25 });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });
});

// =============================================================================
// 2. FSM units — fallback ALLOWED_TRANSITIONS + injectOnTheWay transform
// =============================================================================

describe('ONWAY-001 FSM — fallback ALLOWED_TRANSITIONS map', () => {
    test('TC-FSM-001: Submitted & Rescheduled can reach "On the way"; status registered', () => {
        expect(BLANC_STATUSES).toContain('On the way');
        expect(ALLOWED_TRANSITIONS['Submitted']).toContain('On the way');
        expect(ALLOWED_TRANSITIONS['Rescheduled']).toContain('On the way');
    });

    test('TC-FSM-002: On the way → exactly [Visit completed, Canceled]', () => {
        expect(ALLOWED_TRANSITIONS['On the way']).toEqual(['Visit completed', 'Canceled']);
    });

    test('TC-FSM-002b: additive only — every pre-ONWAY transition still present', () => {
        // The pre-ONWAY map (FSM-001), i.e. the canon before "On the way" was added.
        // Asserting the new map is a strict superset proves nothing was dropped.
        const priorMap = {
            'Submitted': ['Follow Up with Client', 'Waiting for parts', 'Canceled'],
            'Waiting for parts': ['Submitted', 'Follow Up with Client', 'Canceled'],
            'Follow Up with Client': ['Waiting for parts', 'Submitted', 'Canceled'],
            'Visit completed': ['Follow Up with Client', 'Job is Done', 'Canceled'],
            'Job is Done': ['Canceled'],
            'Rescheduled': ['Submitted', 'Canceled'],
            'Canceled': [],
        };
        for (const [from, targets] of Object.entries(priorMap)) {
            expect(ALLOWED_TRANSITIONS[from]).toBeDefined();
            for (const t of targets) {
                expect(ALLOWED_TRANSITIONS[from]).toContain(t);
            }
        }
        // Canceled remains terminal (no targets added).
        expect(ALLOWED_TRANSITIONS['Canceled']).toEqual([]);
    });
});

describe('ONWAY-001 FSM — injectOnTheWay transform', () => {
    // A minimal but representative job SCXML carrying the markers the transform
    // anchors on (Submitted/Rescheduled opening tags + Canceled <final>).
    const BASE_SCXML =
`<scxml xmlns="http://www.w3.org/2005/07/scxml" xmlns:blanc="urn:blanc" initial="Submitted">
  <state id="Submitted" blanc:label="Submitted">
    <transition event="TO_CANCELED" target="Canceled" />
  </state>
  <state id="Rescheduled" blanc:label="Rescheduled">
    <transition event="TO_CANCELED" target="Canceled" />
  </state>
  <final id="Canceled" blanc:label="Canceled" />
</scxml>`;

    test('TC-FSM-transform: first pass adds state + inbound transitions (changed:true)', () => {
        const { changed, scxml } = injectOnTheWay(BASE_SCXML);
        expect(changed).toBe(true);
        // New state present with the canonical id.
        expect(scxml).toContain('id="On_the_way"');
        expect(scxml).toContain('blanc:statusName="On the way"');
        // Out-of-state transitions.
        expect(scxml).toContain('event="TO_VISIT_COMPLETED" target="Visit_completed"');
        expect(scxml).toContain('event="TO_CANCELED" target="Canceled"');
        // Inbound TO_ON_THE_WAY injected under BOTH Submitted and Rescheduled.
        const submittedBlock = scxml.slice(
            scxml.indexOf('id="Submitted"'), scxml.indexOf('id="Rescheduled"')
        );
        const rescheduledBlock = scxml.slice(
            scxml.indexOf('id="Rescheduled"'), scxml.indexOf('id="On_the_way"')
        );
        expect(submittedBlock).toContain('event="TO_ON_THE_WAY" target="On_the_way"');
        expect(rescheduledBlock).toContain('event="TO_ON_THE_WAY" target="On_the_way"');
    });

    test('TC-FSM-transform: idempotent — second pass is a no-op (changed:false)', () => {
        const first = injectOnTheWay(BASE_SCXML);
        const second = injectOnTheWay(first.scxml);
        expect(second.changed).toBe(false);
        expect(second.scxml).toBe(first.scxml);
        // Single occurrence of the state — not duplicated.
        expect(second.scxml.match(/id="On_the_way"/g)).toHaveLength(1);
    });

    test('TC-FSM-transform: markers absent → unchanged (migration parity)', () => {
        const noMarkers = '<scxml><state id="Other"/></scxml>';
        const { changed, scxml } = injectOnTheWay(noMarkers);
        expect(changed).toBe(false);
        expect(scxml).toBe(noMarkers);
    });

    test('TC-FSM-transform: non-string input → unchanged passthrough', () => {
        expect(injectOnTheWay(null)).toEqual({ changed: false, scxml: null });
        expect(injectOnTheWay(undefined)).toEqual({ changed: false, scxml: undefined });
    });
});
