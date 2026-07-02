/**
 * ONBTEL-001 Part C — C5 softphone token fail-closed (Jest, task ONBTEL-T12).
 *
 * TC-C-20…TC-C-26: only the DEFAULT company may mint on master env creds;
 * any other company without provisioned subaccount softphone creds gets a
 * 409 SOFTPHONE_NOT_PROVISIONED instead of the old silent env fallback.
 * Route GET /api/voice/token maps { httpStatus, code } errors; 401 and
 * { allowed:false } branches stay ahead of minting.
 *
 * Strategy (Docs/test-cases/ONBTEL-001.md §8): telephonyTenantService mocked
 * (getSoftphoneCreds + DEFAULT_COMPANY_ID); REAL twilio AccessToken minted on
 * fake TWILIO_* env strings — the JWT payload is decoded to prove WHICH creds
 * signed it (sub=accountSid, iss=apiKeySid). Route exercised via supertest.
 */

// ---------------------------------------------------------------------------
// Env (must exist before voiceService mints env-based tokens)
// ---------------------------------------------------------------------------

const ENV_ACCOUNT_SID = 'ACmasterenv0000000000000000000000000';
const ENV_API_KEY = 'SKenvkey0000000000000000000000000000';
const ENV_API_SECRET = 'env_api_secret_00000000000000000000';
const ENV_TWIML_APP_SID = 'APenvapp0000000000000000000000000000';

process.env.TWILIO_ACCOUNT_SID = ENV_ACCOUNT_SID;
process.env.TWILIO_API_KEY = ENV_API_KEY;
process.env.TWILIO_API_SECRET = ENV_API_SECRET;
process.env.TWILIO_TWIML_APP_SID = ENV_TWIML_APP_SID;

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001'; // Boston Masters (seed)
const COMPANY_A = '11111111-1111-1111-1111-111111111111';

const SUB_ACCOUNT_SID = 'ACsub1110000000000000000000000000000';
const SUB_API_KEY = 'SKsubkey1110000000000000000000000000';
const SUB_TWIML_APP_SID = 'APsubapp1110000000000000000000000000';

const EXACT_409_MESSAGE =
    'SoftPhone is not provisioned for this company — connect telephony and run softphone setup.';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetSoftphoneCreds = jest.fn();
jest.mock('../backend/src/services/telephonyTenantService', () => ({
    getSoftphoneCreds: (...args) => mockGetSoftphoneCreds(...args),
    DEFAULT_COMPANY_ID: '00000000-0000-0000-0000-000000000001',
}));

const mockDbQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
}));

const mockGroupsForUser = jest.fn();
jest.mock('../backend/src/services/groupRouting', () => ({
    groupsForUser: (...args) => mockGroupsForUser(...args),
    resolveGroupForNumber: jest.fn(),
}));

// routes/voice.js top-level deps not exercised here — inert stubs
jest.mock('../backend/src/services/callAvailability', () => ({ isContactBusy: jest.fn() }));
jest.mock('../backend/src/services/agentPresence', () => ({ setAgentStatus: jest.fn() }));
jest.mock('../backend/src/services/walletService', () => ({ isServiceBlocked: jest.fn() }));

// NOTE: 'twilio' is intentionally NOT mocked — real AccessToken minting is the
// point (we assert which account/key signed the JWT).

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

const express = require('express');
const request = require('supertest');
const { generateTokenForCompany } = require('../backend/src/services/voiceService');
const { tokenRouter } = require('../backend/src/routes/voice');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeJwtPayload(token) {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
}

function appAs({ user, companyId } = {}) {
    const app = express();
    app.use((req, _res, next) => {
        req.user = user;
        req.companyFilter = companyId ? { company_id: companyId } : undefined;
        next();
    });
    app.use('/api/voice', tokenRouter);
    return app;
}

const AUTHED_USER = { crmUser: { id: 'crm-user-1' }, sub: 'kc-sub-1', email: 'agent@test.local' };

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
    console.log.mockRestore();
    console.error.mockRestore();
});

beforeEach(() => {
    jest.clearAllMocks();
    process.env.TWILIO_ACCOUNT_SID = ENV_ACCOUNT_SID;
    process.env.TWILIO_API_KEY = ENV_API_KEY;
    process.env.TWILIO_API_SECRET = ENV_API_SECRET;
    process.env.TWILIO_TWIML_APP_SID = ENV_TWIML_APP_SID;

    mockGetSoftphoneCreds.mockResolvedValue(null);
    mockDbQuery.mockResolvedValue({ rows: [{ allowed: true }] }); // phone_calls_allowed
    mockGroupsForUser.mockResolvedValue([{ id: 'g1', name: 'Sales' }]);
});

// ---------------------------------------------------------------------------
// Service — generateTokenForCompany (TC-C-20…TC-C-23)
// ---------------------------------------------------------------------------

describe('voiceService.generateTokenForCompany — C5 fail-closed', () => {
    test('TC-C-20: DEFAULT company → env-creds token via the generateToken path; creds lookup NEVER consulted (Boston Masters byte-identical)', async () => {
        const result = await generateTokenForCompany(DEFAULT_COMPANY_ID, 'ident-default-1');

        // Branch decided on companyId BEFORE any creds access
        expect(mockGetSoftphoneCreds).not.toHaveBeenCalled();

        expect(result.identity).toBe('ident-default-1');
        expect(typeof result.token).toBe('string');
        expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());

        const payload = decodeJwtPayload(result.token);
        expect(payload.sub).toBe(ENV_ACCOUNT_SID);   // master account
        expect(payload.iss).toBe(ENV_API_KEY);       // master API key
        expect(payload.grants.identity).toBe('ident-default-1');
        expect(JSON.stringify(payload.grants)).toContain(ENV_TWIML_APP_SID);
    });

    test('TC-C-21: non-default company, creds null → throws 409 SOFTPHONE_NOT_PROVISIONED with the exact message; NO silent env fallback (no token ever minted)', async () => {
        mockGetSoftphoneCreds.mockResolvedValue(null);

        // rejects === the env generateToken fallback did NOT run (a resolved
        // value here would mean a token was silently minted on master creds)
        await expect(generateTokenForCompany(COMPANY_A, 'ident-a')).rejects.toMatchObject({
            httpStatus: 409,
            code: 'SOFTPHONE_NOT_PROVISIONED',
            message: EXACT_409_MESSAGE,
        });

        expect(mockGetSoftphoneCreds).toHaveBeenCalledTimes(1);
        expect(mockGetSoftphoneCreds).toHaveBeenCalledWith(COMPANY_A);
    });

    test('TC-C-22: provisioned creds → token minted on the SUBACCOUNT creds, not env', async () => {
        mockGetSoftphoneCreds.mockResolvedValue({
            accountSid: SUB_ACCOUNT_SID,
            apiKeySid: SUB_API_KEY,
            apiKeySecret: 'sub_api_secret_111111111111111111',
            twimlAppSid: SUB_TWIML_APP_SID,
        });

        const result = await generateTokenForCompany(COMPANY_A, 'ident-a-9');
        expect(result.identity).toBe('ident-a-9');

        const payload = decodeJwtPayload(result.token);
        expect(payload.sub).toBe(SUB_ACCOUNT_SID);   // subaccount, NOT env master
        expect(payload.iss).toBe(SUB_API_KEY);
        expect(payload.sub).not.toBe(ENV_ACCOUNT_SID);
        expect(payload.iss).not.toBe(ENV_API_KEY);
        expect(JSON.stringify(payload.grants)).toContain(SUB_TWIML_APP_SID);
        expect(JSON.stringify(payload.grants)).not.toContain(ENV_TWIML_APP_SID);
    });

    test.each([[undefined], [null], ['']])(
        'TC-C-23: falsy companyId (%p) → goes through getSoftphoneCreds → 409, never the env fallback',
        async (companyId) => {
            mockGetSoftphoneCreds.mockResolvedValue(null);

            await expect(generateTokenForCompany(companyId, 'ident-x')).rejects.toMatchObject({
                httpStatus: 409,
                code: 'SOFTPHONE_NOT_PROVISIONED',
            });
            expect(mockGetSoftphoneCreds).toHaveBeenCalledWith(companyId);
        }
    );
});

// ---------------------------------------------------------------------------
// Route — GET /api/voice/token (TC-C-24, TC-C-25)
// ---------------------------------------------------------------------------

describe('GET /api/voice/token — error mapping and pre-mint gates', () => {
    test('TC-C-24a: service throws { httpStatus:409, code } → res.status(409).json({ error, code })', async () => {
        mockGetSoftphoneCreds.mockResolvedValue(null); // real service throws the 409

        const resp = await request(appAs({ user: AUTHED_USER, companyId: COMPANY_A }))
            .get('/api/voice/token');

        expect(resp.status).toBe(409);
        expect(resp.body).toEqual({
            error: EXACT_409_MESSAGE,
            code: 'SOFTPHONE_NOT_PROVISIONED',
        });
    });

    test('TC-C-24b: service throws a generic Error → 500 "Failed to generate voice token" (as before)', async () => {
        mockGetSoftphoneCreds.mockRejectedValue(new Error('creds lookup exploded'));

        const resp = await request(appAs({ user: AUTHED_USER, companyId: COMPANY_A }))
            .get('/api/voice/token');

        expect(resp.status).toBe(500);
        expect(resp.body).toEqual({ error: 'Failed to generate voice token' });
    });

    test('TC-C-25a: no userId / no companyId → 401 before any DB or creds access (regression)', async () => {
        // no user at all
        let resp = await request(appAs({ user: undefined, companyId: COMPANY_A })).get('/api/voice/token');
        expect(resp.status).toBe(401);
        expect(resp.body).toEqual({ error: 'User not authenticated' });

        // user present but no company context
        resp = await request(appAs({ user: AUTHED_USER, companyId: null })).get('/api/voice/token');
        expect(resp.status).toBe(401);
        expect(resp.body).toEqual({ error: 'User not authenticated' });

        expect(mockDbQuery).not.toHaveBeenCalled();
        expect(mockGetSoftphoneCreds).not.toHaveBeenCalled();
    });

    test('TC-C-25b: phone_calls_allowed=false → 200 { allowed:false }, no token minted (regression)', async () => {
        mockDbQuery.mockResolvedValue({ rows: [{ allowed: false }] });

        const resp = await request(appAs({ user: AUTHED_USER, companyId: COMPANY_A }))
            .get('/api/voice/token');

        expect(resp.status).toBe(200);
        expect(resp.body).toEqual({ allowed: false });
        expect(mockGetSoftphoneCreds).not.toHaveBeenCalled();
    });

    test('TC-C-25c: zero groups → 200 { allowed:false }, no token minted (regression)', async () => {
        mockGroupsForUser.mockResolvedValue([]);

        const resp = await request(appAs({ user: AUTHED_USER, companyId: COMPANY_A }))
            .get('/api/voice/token');

        expect(resp.status).toBe(200);
        expect(resp.body).toEqual({ allowed: false });
        expect(mockGetSoftphoneCreds).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// SQL contract of the REAL getSoftphoneCreds (TC-C-26)
// ---------------------------------------------------------------------------

describe("telephonyTenantService.getSoftphoneCreds — status='connected' filter", () => {
    test("TC-C-26: real query filters status='connected' → suspended tenant yields no rows → null (→ 409 via the TC-C-21 path)", async () => {
        // The service is jest-mocked above for the consumers; pull the REAL
        // implementation and run it against the mocked db. (Mocked jest checks
        // the SQL contract only — live-DB behavior belongs to T13 migration-DB.)
        const realTts = jest.requireActual('../backend/src/services/telephonyTenantService');

        mockDbQuery.mockResolvedValueOnce({ rows: [] }); // suspended row filtered out by the WHERE

        const creds = await realTts.getSoftphoneCreds(COMPANY_A);
        expect(creds).toBeNull();

        const call = mockDbQuery.mock.calls.find(([sql]) => /FROM company_telephony/.test(String(sql)));
        expect(call).toBeTruthy();
        expect(call[0]).toMatch(/WHERE company_id = \$1/);
        expect(call[0]).toMatch(/status = 'connected'/);
        expect(call[1]).toEqual([COMPANY_A]);

        // Chained consequence (contract mirror of TC-C-21): a null from this
        // exact suspended-tenant shape makes generateTokenForCompany throw 409.
        mockGetSoftphoneCreds.mockResolvedValue(null);
        await expect(generateTokenForCompany(COMPANY_A, 'ident-susp')).rejects.toMatchObject({
            httpStatus: 409,
            code: 'SOFTPHONE_NOT_PROVISIONED',
        });
    });
});
