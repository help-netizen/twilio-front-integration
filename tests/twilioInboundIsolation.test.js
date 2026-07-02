/**
 * ONBTEL-001 Part C — inbound tenant isolation (Jest, task ONBTEL-T12).
 *
 * C1  (fail-closed company resolution) + C4 (wallet gate on the resolved
 *     company) in handleVoiceInbound — TC-C-01…TC-C-11.
 * C2b (master phone-number sync binds DEFAULT company, never the requester)
 *     in GET/PUT /api/phone-settings — TC-C-30…TC-C-33.
 *
 * Strategy (Docs/test-cases/ONBTEL-001.md §7): direct handleVoiceInbound(req,res)
 * calls with res.type/send/status mocks, NODE_ENV=development except TC-C-11a;
 * telephonyTenantService / db.connection / walletService / groupRouting /
 * callFlowRuntime / inbox+missed-call infrastructure all mocked;
 * console.warn spied for the normative rejection-log shape.
 */

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001'; // Boston Masters (seed)
const COMPANY_A = '11111111-1111-1111-1111-111111111111';
const COMPANY_B = '22222222-2222-2222-2222-222222222222';

const MASTER_SID = 'ACmaster0000000000000000000000000000';
const SUB_SID = 'ACsub1110000000000000000000000000000';
const GHOST_SID = 'ACghost99900000000000000000000000000';

const VOICEMAIL_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Record /></Response>';
const GROUP_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Dial>GROUP-FLOW</Dial></Response>';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
}));

const mockInsertInboxEvent = jest.fn();
const mockFindOrCreateTimeline = jest.fn();
const mockUpsertCall = jest.fn();
jest.mock('../backend/src/db/queries', () => ({
    insertInboxEvent: (...args) => mockInsertInboxEvent(...args),
    findOrCreateTimeline: (...args) => mockFindOrCreateTimeline(...args),
    upsertCall: (...args) => mockUpsertCall(...args),
}));

const mockResolveCompanyByAccountSid = jest.fn();
const mockGetAuthTokenForAccountSid = jest.fn();
jest.mock('../backend/src/services/telephonyTenantService', () => ({
    resolveCompanyByAccountSid: (...args) => mockResolveCompanyByAccountSid(...args),
    getAuthTokenForAccountSid: (...args) => mockGetAuthTokenForAccountSid(...args),
    DEFAULT_COMPANY_ID: '00000000-0000-0000-0000-000000000001',
}));

const mockIsServiceBlocked = jest.fn();
jest.mock('../backend/src/services/walletService', () => ({
    isServiceBlocked: (...args) => mockIsServiceBlocked(...args),
}));

const mockResolveGroupForNumber = jest.fn();
jest.mock('../backend/src/services/groupRouting', () => ({
    resolveGroupForNumber: (...args) => mockResolveGroupForNumber(...args),
}));

const mockStartExecution = jest.fn();
const mockBuildVoicemailTwiml = jest.fn();
jest.mock('../backend/src/services/callFlowRuntime', () => ({
    startExecution: (...args) => mockStartExecution(...args),
    buildVoicemailTwiml: (...args) => mockBuildVoicemailTwiml(...args),
    getExecution: jest.fn(),
    advance: jest.fn(),
    eventFromDialStatus: jest.fn(),
    vapiEventFromDialStatus: jest.fn(),
    buildHangupTwiml: jest.fn(),
}));

const mockPublishCallUpdate = jest.fn();
jest.mock('../backend/src/services/realtimeService', () => ({
    publishCallUpdate: (...args) => mockPublishCallUpdate(...args),
    broadcast: jest.fn(),
}));

// Signature validation (TC-C-11a production path only)
const mockValidateRequest = jest.fn();
jest.mock('twilio', () => {
    const factory = jest.fn(() => ({}));
    factory.validateRequest = (...args) => mockValidateRequest(...args);
    return factory;
});

// C2b deps: the phone-settings sync lists the MASTER Twilio account
const mockTwilioNumbersList = jest.fn();
jest.mock('../backend/src/services/twilioClient', () => ({
    getTwilioClient: () => ({ incomingPhoneNumbers: { list: (...args) => mockTwilioNumbersList(...args) } }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

const express = require('express');
const request = require('supertest');
const { handleVoiceInbound } = require('../backend/src/webhooks/twilioWebhooks');
const phoneSettingsRouter = require('../backend/src/routes/phoneSettings');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRes() {
    const res = {};
    res.type = jest.fn(() => res);
    res.send = jest.fn(() => res);
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
}

function makeReq(body = {}, headers = {}) {
    return {
        body,
        headers,
        query: {},
        protocol: 'https',
        get: (h) => (h === 'host' ? 'api.test.local' : ''),
        originalUrl: '/webhooks/twilio/voice-inbound',
    };
}

function inboundBody(overrides = {}) {
    return {
        CallSid: 'CA_inbound_001',
        From: '+16175551000',
        To: '+15085550001',
        AccountSid: MASTER_SID,
        ...overrides,
    };
}

/** All db.query calls that hit the phone_number_settings company lookup. */
function pnsLookups() {
    return mockDbQuery.mock.calls.filter(
        ([sql]) => /SELECT company_id FROM phone_number_settings/.test(String(sql))
    );
}

function rejectionWarns() {
    return console.warn.mock.calls.filter(([first]) => String(first).includes('inbound_call.rejected'));
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    console.log.mockRestore();
    console.warn.mockRestore();
    console.error.mockRestore();
});

beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'development'; // skip signature validation except TC-C-11a
    process.env.TWILIO_ACCOUNT_SID = MASTER_SID;
    process.env.TWILIO_AUTH_TOKEN = 'master_auth_token';

    // Defaults: unknown everything, wallet fine, no group → voicemail
    mockDbQuery.mockResolvedValue({ rows: [] });
    mockInsertInboxEvent.mockResolvedValue({ id: 1 });
    mockResolveCompanyByAccountSid.mockResolvedValue(null);
    mockIsServiceBlocked.mockResolvedValue(false);
    mockResolveGroupForNumber.mockResolvedValue(null);
    mockBuildVoicemailTwiml.mockReturnValue(VOICEMAIL_TWIML);
    mockStartExecution.mockResolvedValue(GROUP_TWIML);
    mockFindOrCreateTimeline.mockResolvedValue({ id: 42, contact_id: 7 });
    mockUpsertCall.mockResolvedValue({ call_sid: 'CA_inbound_001', status: 'no-answer' });
    mockValidateRequest.mockReturnValue(true);
    mockTwilioNumbersList.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// C1 + C4 — handleVoiceInbound (TC-C-01…TC-C-11)
// ---------------------------------------------------------------------------

describe('handleVoiceInbound — C1 fail-closed resolution + C4 wallet gate', () => {
    test('TC-C-01: master AccountSid → DEFAULT company, NEVER rejected — even with the pns lookup failing (Boston Masters byte-identical)', async () => {
        mockResolveCompanyByAccountSid.mockResolvedValue(DEFAULT_COMPANY_ID);
        // The To number has no phone_number_settings row AND the lookup itself
        // would blow up — a SID hit must short-circuit it entirely.
        mockDbQuery.mockRejectedValue(new Error('pns lookup down'));

        const res = makeRes();
        await handleVoiceInbound(makeReq(inboundBody({ To: '+15085559999' })), res);

        expect(res.status).not.toHaveBeenCalled(); // 200, not 4xx/5xx
        expect(res.type).toHaveBeenCalledWith('text/xml');
        expect(res.send).toHaveBeenCalledTimes(1);
        expect(res.send).toHaveBeenCalledWith(VOICEMAIL_TWIML);
        expect(String(res.send.mock.calls[0][0])).not.toContain('<Reject');

        // Routed exactly as today: group lookup → none → generic voicemail
        expect(mockResolveGroupForNumber).toHaveBeenCalledWith('+15085559999');
        expect(mockBuildVoicemailTwiml).toHaveBeenCalled();
        expect(mockIsServiceBlocked).toHaveBeenCalledWith(DEFAULT_COMPANY_ID);
        expect(rejectionWarns()).toHaveLength(0);
    });

    test('TC-C-02: unknown AccountSid + unknown To → bare <Reject/> (no reason), 6-field warn log, no missed-call record, ingest BEFORE resolve', async () => {
        mockResolveCompanyByAccountSid.mockResolvedValue(null);
        mockDbQuery.mockResolvedValue({ rows: [] }); // no pns row either

        const res = makeRes();
        await handleVoiceInbound(
            makeReq(inboundBody({ AccountSid: GHOST_SID, To: '+15085559999', From: '+16175551000', CallSid: 'CA_unknown_1' })),
            res
        );

        // 200 text/xml with EXACTLY the bare Reject (no reason="busy")
        expect(res.status).not.toHaveBeenCalled();
        expect(res.type).toHaveBeenCalledWith('text/xml');
        expect(res.send).toHaveBeenCalledTimes(1);
        expect(res.send).toHaveBeenCalledWith('<Response><Reject/></Response>');

        // Normative log shape: one warn, first arg tags the event, second arg
        // carries ALL six fields
        const warns = rejectionWarns();
        expect(warns).toHaveLength(1);
        expect(warns[0][1]).toEqual({
            event: 'inbound_call.rejected',
            reason: 'unknown_number',
            call_sid: 'CA_unknown_1',
            account_sid: GHOST_SID,
            to: '+15085559999',
            from: '+16175551000',
        });

        // No company → no orphan timeline / missed-call record
        expect(mockFindOrCreateTimeline).not.toHaveBeenCalled();
        expect(mockUpsertCall).not.toHaveBeenCalled();

        // Audit trail preserved: webhook_inbox ingest ran, and BEFORE resolution
        expect(mockInsertInboxEvent).toHaveBeenCalledTimes(1);
        expect(mockInsertInboxEvent.mock.invocationCallOrder[0])
            .toBeLessThan(mockResolveCompanyByAccountSid.mock.invocationCallOrder[0]);

        // Routing never reached
        expect(mockResolveGroupForNumber).not.toHaveBeenCalled();
        expect(mockStartExecution).not.toHaveBeenCalled();
    });

    test('TC-C-03: BOTH lookups throwing → fail-closed Reject (not 500)', async () => {
        mockResolveCompanyByAccountSid.mockRejectedValue(new Error('company_telephony down'));
        mockDbQuery.mockRejectedValue(new Error('phone_number_settings down'));

        const res = makeRes();
        await handleVoiceInbound(makeReq(inboundBody({ AccountSid: GHOST_SID })), res);

        expect(res.status).not.toHaveBeenCalled(); // notably NOT 500
        expect(res.send).toHaveBeenCalledWith('<Response><Reject/></Response>');
        const warns = rejectionWarns();
        expect(warns).toHaveLength(1);
        expect(warns[0][1]).toMatchObject({ reason: 'unknown_number' });
    });

    test('TC-C-04: connected subaccount resolves by SID — To fallback NEVER queried (short-circuit), normal group routing', async () => {
        mockResolveCompanyByAccountSid.mockResolvedValue(COMPANY_A);
        mockResolveGroupForNumber.mockResolvedValue({ group: { id: 'g1', name: 'Sales' }, flow: { id: 'f1' } });

        const res = makeRes();
        // To deliberately has NO pns row — must not matter
        await handleVoiceInbound(makeReq(inboundBody({ AccountSid: SUB_SID, To: '+15085559999' })), res);

        expect(mockResolveCompanyByAccountSid).toHaveBeenCalledWith(SUB_SID);
        expect(pnsLookups()).toHaveLength(0); // short-circuit: SID hit skips the To lookup
        expect(mockStartExecution).toHaveBeenCalledWith(expect.objectContaining({
            callSid: 'CA_inbound_001',
            fromNumber: '+16175551000',
            toNumber: '+15085559999',
            group: { id: 'g1', name: 'Sales' },
            flow: { id: 'f1' },
        }));
        expect(res.send).toHaveBeenCalledWith(GROUP_TWIML);
        expect(String(res.send.mock.calls[0][0])).not.toContain('<Reject');
        expect(rejectionWarns()).toHaveLength(0);
    });

    test('TC-C-05: suspended subaccount (SID resolve → null) + known To → falls back to the number owner → normal routing (ALB-107 canon)', async () => {
        mockResolveCompanyByAccountSid.mockResolvedValue(null); // status != connected
        mockDbQuery.mockResolvedValue({ rows: [{ company_id: COMPANY_A }] });

        const res = makeRes();
        await handleVoiceInbound(makeReq(inboundBody({ AccountSid: SUB_SID, To: '+15085550001' })), res);

        const lookups = pnsLookups();
        expect(lookups).toHaveLength(1);
        expect(lookups[0][1]).toEqual(['+15085550001']);
        expect(mockIsServiceBlocked).toHaveBeenCalledWith(COMPANY_A);
        expect(mockResolveGroupForNumber).toHaveBeenCalledWith('+15085550001');
        expect(res.send).toHaveBeenCalledWith(VOICEMAIL_TWIML);
        expect(rejectionWarns()).toHaveLength(0);
    });

    test('TC-C-06: suspended subaccount + unknown To → Reject with unknown_number warn', async () => {
        mockResolveCompanyByAccountSid.mockResolvedValue(null);
        mockDbQuery.mockResolvedValue({ rows: [] });

        const res = makeRes();
        await handleVoiceInbound(makeReq(inboundBody({ AccountSid: SUB_SID, To: '+15085559999' })), res);

        expect(res.send).toHaveBeenCalledWith('<Response><Reject/></Response>');
        const warns = rejectionWarns();
        expect(warns).toHaveLength(1);
        expect(warns[0][1]).toMatchObject({ reason: 'unknown_number', account_sid: SUB_SID });
        expect(mockResolveGroupForNumber).not.toHaveBeenCalled();
    });

    test('TC-C-07: wallet-blocked resolved company → busy-Reject + missed call with companyId; ZERO pns lookups on SID resolve; routing gated', async () => {
        mockResolveCompanyByAccountSid.mockResolvedValue(COMPANY_A);
        mockIsServiceBlocked.mockResolvedValue(true);

        const res = makeRes();
        await handleVoiceInbound(makeReq(inboundBody({ AccountSid: SUB_SID })), res);

        expect(res.type).toHaveBeenCalledWith('text/xml');
        expect(res.send).toHaveBeenCalledWith('<Response><Reject reason="busy"/></Response>');

        // recordMissedInbound got the RESOLVED company (no second lookup)
        expect(mockFindOrCreateTimeline).toHaveBeenCalledWith('+16175551000', COMPANY_A);
        expect(mockUpsertCall).toHaveBeenCalledWith(expect.objectContaining({
            callSid: 'CA_inbound_001',
            direction: 'inbound',
            status: 'no-answer',
            isFinal: true,
            companyId: COMPANY_A,
        }));
        expect(mockPublishCallUpdate).toHaveBeenCalled();

        // "Second lookup removed": SID resolve → 0 companyIdForNumber queries
        expect(pnsLookups()).toHaveLength(0);

        // Gate sits BEFORE routing
        expect(mockResolveGroupForNumber).not.toHaveBeenCalled();
        expect(mockStartExecution).not.toHaveBeenCalled();
    });

    test('TC-C-07b: wallet-blocked company resolved via To fallback → companyIdForNumber SQL runs EXACTLY once for the whole request', async () => {
        mockResolveCompanyByAccountSid.mockResolvedValue(null);
        mockDbQuery.mockResolvedValue({ rows: [{ company_id: COMPANY_A }] });
        mockIsServiceBlocked.mockResolvedValue(true);

        const res = makeRes();
        await handleVoiceInbound(makeReq(inboundBody({ AccountSid: SUB_SID, To: '+15085550001' })), res);

        expect(res.send).toHaveBeenCalledWith('<Response><Reject reason="busy"/></Response>');
        // At most one lookup per request — the old duplicate lookup inside the
        // missed-call branch is gone
        expect(pnsLookups()).toHaveLength(1);
        expect(mockFindOrCreateTimeline).toHaveBeenCalledWith('+16175551000', COMPANY_A);
    });

    test('TC-C-08: isServiceBlocked throwing → .catch(false) fail-open → routing continues', async () => {
        mockResolveCompanyByAccountSid.mockResolvedValue(COMPANY_A);
        mockIsServiceBlocked.mockRejectedValue(new Error('wallet service down'));

        const res = makeRes();
        await handleVoiceInbound(makeReq(inboundBody({ AccountSid: SUB_SID })), res);

        expect(mockResolveGroupForNumber).toHaveBeenCalled();
        expect(res.send).toHaveBeenCalledWith(VOICEMAIL_TWIML);
        expect(String(res.send.mock.calls[0][0])).not.toContain('<Reject');
        expect(mockFindOrCreateTimeline).not.toHaveBeenCalled();
    });

    test('TC-C-09: DEFAULT company wallet-blocked (hypothetical) → busy-Reject — the null-company bypass is gone', async () => {
        mockResolveCompanyByAccountSid.mockResolvedValue(DEFAULT_COMPANY_ID);
        mockIsServiceBlocked.mockResolvedValue(true);

        const res = makeRes();
        await handleVoiceInbound(makeReq(inboundBody({ To: '+15085559999' })), res);

        expect(mockIsServiceBlocked).toHaveBeenCalledWith(DEFAULT_COMPANY_ID);
        expect(res.send).toHaveBeenCalledWith('<Response><Reject reason="busy"/></Response>');
        expect(mockFindOrCreateTimeline).toHaveBeenCalledWith('+16175551000', DEFAULT_COMPANY_ID);
        expect(mockResolveGroupForNumber).not.toHaveBeenCalled();
    });

    test('TC-C-10: SIP outbound branch untouched — <Dial> TwiML, company resolution / reject logic never invoked', async () => {
        const res = makeRes();
        await handleVoiceInbound(
            makeReq(inboundBody({ From: 'sip:agent7@blanc.sip.twilio.com', To: '+15085551234' })),
            res
        );

        expect(mockResolveCompanyByAccountSid).not.toHaveBeenCalled();
        expect(mockIsServiceBlocked).not.toHaveBeenCalled();
        expect(pnsLookups()).toHaveLength(0);
        expect(mockResolveGroupForNumber).not.toHaveBeenCalled();

        const sent = String(res.send.mock.calls[0][0]);
        expect(sent).toContain('<Dial');
        expect(sent).toContain('+15085551234</Number>');
        expect(sent).not.toContain('<Reject');
        expect(mockInsertInboxEvent).toHaveBeenCalledTimes(1); // ingest still runs
    });

    test('TC-C-11a: production + invalid signature → 403 BEFORE ingest (regression, handler order §3.1)', async () => {
        process.env.NODE_ENV = 'production';
        mockValidateRequest.mockReturnValue(false);

        const res = makeRes();
        await handleVoiceInbound(makeReq(inboundBody(), { 'x-twilio-signature': 'bogus-signature' }), res);

        expect(mockValidateRequest).toHaveBeenCalled(); // signature actually checked
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.send).toHaveBeenCalledWith('<Response><Reject/></Response>');
        expect(mockInsertInboxEvent).not.toHaveBeenCalled();
        expect(mockResolveCompanyByAccountSid).not.toHaveBeenCalled();
    });

    test('TC-C-11b: missing CallSid → 400 before ingest (regression)', async () => {
        const body = inboundBody();
        delete body.CallSid;

        const res = makeRes();
        await handleVoiceInbound(makeReq(body), res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.send).toHaveBeenCalledWith('<Response><Reject/></Response>');
        expect(mockInsertInboxEvent).not.toHaveBeenCalled();
        expect(mockResolveCompanyByAccountSid).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// C2b — /api/phone-settings master-sync binds DEFAULT (TC-C-30…TC-C-33)
// ---------------------------------------------------------------------------

describe('phone-settings sync — C2b DEFAULT bind (TC-C-30…TC-C-33)', () => {
    const MASTER_NUMBERS = [
        { phoneNumber: '+16175550001', friendlyName: 'Master main', sid: 'PN001' },
        { phoneNumber: '+16175550002', friendlyName: 'Master second', sid: 'PN002' },
    ];

    function appAs(companyId) {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { sub: 'user-1', email: 'tester@test.local' };
            // Real requirePermission middleware reads req.authz.permissions
            req.authz = { scope: 'tenant', permissions: ['tenant.telephony.manage'], scopes: {} };
            req.companyFilter = { company_id: companyId };
            next();
        });
        app.use('/api/phone-settings', phoneSettingsRouter);
        return app;
    }

    const upsertCalls = () =>
        mockDbQuery.mock.calls.filter(([sql]) => /INSERT INTO phone_number_settings/.test(String(sql)));
    const finalSelects = () =>
        mockDbQuery.mock.calls.filter(([sql]) =>
            /FROM phone_number_settings/.test(String(sql)) && /WHERE company_id = \$1/.test(String(sql)));

    beforeEach(() => {
        mockTwilioNumbersList.mockResolvedValue(MASTER_NUMBERS);
        // ensureTable() DDL + upserts resolve empty; the final SELECT is shaped per test
        mockDbQuery.mockResolvedValue({ rows: [] });
    });

    test('TC-C-30: sync requested by tenant COMPANY_B — upsert $1 binds DEFAULT_COMPANY_ID (not the requester); final SELECT stays scoped to the requester → master numbers not claimable/visible', async () => {
        const resp = await request(appAs(COMPANY_B)).get('/api/phone-settings');

        expect(resp.status).toBe(200);
        expect(resp.body).toEqual({ ok: true, data: [] });

        const ups = upsertCalls();
        expect(ups).toHaveLength(MASTER_NUMBERS.length);
        for (const [sql, params] of ups) {
            expect(params[0]).toBe(DEFAULT_COMPANY_ID);   // $1 — the INSERT/EXCLUDED bind
            expect(params).not.toContain(COMPANY_B);      // requester id never reaches the upsert
            expect(sql).toMatch(/VALUES \(\$1, \$2, \$3\)/);
        }
        expect(ups.map(([, p]) => p[1]).sort()).toEqual(['+16175550001', '+16175550002']);

        const sels = finalSelects();
        expect(sels).toHaveLength(1);
        expect(sels[0][1]).toEqual([COMPANY_B]); // requester's own scope, untouched
    });

    test('TC-C-31: Boston Masters admin (DEFAULT) — upsert binds his own id and his numbers come back (byte-identical behavior)', async () => {
        const ownRows = [
            { id: 1, company_id: DEFAULT_COMPANY_ID, phone_number: '+16175550001', friendly_name: 'Master main', routing_mode: 'client', client_identity: null, group_id: 'g1' },
            { id: 2, company_id: DEFAULT_COMPANY_ID, phone_number: '+16175550002', friendly_name: 'Master second', routing_mode: 'sip', client_identity: null, group_id: null },
        ];
        mockDbQuery.mockImplementation(async (sql) => {
            if (/FROM phone_number_settings/.test(String(sql)) && /WHERE company_id = \$1/.test(String(sql))) {
                return { rows: ownRows };
            }
            return { rows: [] };
        });

        const resp = await request(appAs(DEFAULT_COMPANY_ID)).get('/api/phone-settings');

        expect(resp.status).toBe(200);
        expect(resp.body.ok).toBe(true);
        expect(resp.body.data).toHaveLength(2);
        expect(resp.body.data.map(r => r.phone_number)).toEqual(['+16175550001', '+16175550002']);

        for (const [, params] of upsertCalls()) expect(params[0]).toBe(DEFAULT_COMPANY_ID);
        expect(finalSelects()[0][1]).toEqual([DEFAULT_COMPANY_ID]);
    });

    test("TC-C-32: upsert claims NULL-company rows via COALESCE(company_id, EXCLUDED.company_id) with EXCLUDED sourced from $1=DEFAULT — a foreign tenant's sync can no longer claim pre-147 NULL rows", async () => {
        // SQL-string contract (mocked jest checks the query text only — the
        // real COALESCE behavior against a live DB is T13 migration-DB scope).
        await request(appAs(COMPANY_B)).get('/api/phone-settings');

        const ups = upsertCalls();
        expect(ups.length).toBeGreaterThan(0);
        const [sql, params] = ups[0];
        expect(sql).toMatch(/ON CONFLICT \(phone_number\) DO UPDATE/);
        expect(sql).toMatch(/company_id = COALESCE\(phone_number_settings\.company_id,\s*EXCLUDED\.company_id\)/);
        // EXCLUDED.company_id resolves to $1 → DEFAULT, never the requester
        expect(params[0]).toBe(DEFAULT_COMPANY_ID);
        expect(params[0]).not.toBe(COMPANY_B);
    });

    test('TC-C-33: PUT /:id keeps AND company_id — COMPANY_B updating a DEFAULT-owned row hits 0 rows → 404', async () => {
        mockDbQuery.mockImplementation(async (sql) => {
            if (/UPDATE phone_number_settings/.test(String(sql))) return { rows: [] }; // foreign row filtered out
            return { rows: [] };
        });

        const resp = await request(appAs(COMPANY_B))
            .put('/api/phone-settings/55')
            .send({ routing_mode: 'client', client_identity: 'agent-1' });

        expect(resp.status).toBe(404);
        expect(resp.body).toEqual({ ok: false, error: 'Phone number not found' });

        const upd = mockDbQuery.mock.calls.find(([sql]) => /UPDATE phone_number_settings/.test(String(sql)));
        expect(upd).toBeTruthy();
        expect(upd[0]).toMatch(/WHERE id = \$3 AND company_id = \$4/);
        expect(upd[1]).toEqual(['client', 'agent-1', '55', COMPANY_B]);
    });
});
