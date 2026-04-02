/**
 * Bug #6: Stale call records cause incorrect voicemail routing
 *
 * Tests for the 4 layers of protection against stale ringing/in-progress
 * records that falsely mark operators as busy:
 *
 *   Layer 1 — Age filter: SQL WHERE clause filters out stale ringing records
 *             (>90 seconds) and stale in-progress records (>4 hours)
 *   Layer 2 — Child leg finalization: handleDialAction finalizes all child
 *             legs with is_final=true when dial completes
 *   Layer 3 — STALE_THRESHOLD_MINUTES=3 (reconcileStale.js)
 *   Layer 4 — Twilio API fallback: when all operators appear busy, verify
 *             each "busy" call via Twilio REST API before routing to voicemail
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const mockInsertInboxEvent = jest.fn().mockResolvedValue({ id: 1 });
const mockGetCallByCallSid = jest.fn().mockResolvedValue(null);
jest.mock('../backend/src/db/queries', () => ({
    insertInboxEvent: mockInsertInboxEvent,
    getCallByCallSid: mockGetCallByCallSid,
}));

const mockTwilioFetch = jest.fn();
const mockTwilioCallsFn = jest.fn(() => ({ fetch: mockTwilioFetch }));
jest.mock('twilio', () => {
    const factory = () => ({ calls: mockTwilioCallsFn });
    factory.validateRequest = () => true;
    return factory;
});

jest.mock('../backend/src/services/realtimeService', () => ({
    publishCallUpdate: jest.fn(),
    broadcast: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(bodyOverrides = {}, queryOverrides = {}) {
    return {
        headers: { 'x-twilio-signature': 'valid' },
        body: {
            CallSid: 'CA_parent_001',
            From: '+15551112222',
            To: '+15553334444',
            ...bodyOverrides,
        },
        query: { ...queryOverrides },
        protocol: 'https',
        get: () => 'test.example.com',
        originalUrl: '/webhooks/twilio/voice-inbound',
    };
}

function makeRes() {
    const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(),
        type: jest.fn().mockReturnThis(),
    };
    return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const { handleVoiceInbound, handleDialAction } = require('../backend/src/webhooks/twilioWebhooks');

describe('Bug #6 — Stale call records / voicemail routing', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.NODE_ENV = 'development'; // skip Twilio signature validation
        process.env.TWILIO_ACCOUNT_SID = 'ACtest';
        process.env.TWILIO_AUTH_TOKEN = 'test_token';
        delete process.env.SOFTPHONE_DEFAULT_IDENTITY;
    });

    // -----------------------------------------------------------------------
    // Layer 1a — Age filter: Client routing
    // A ringing record older than 90s should be excluded from the busy check.
    // -----------------------------------------------------------------------
    describe('Layer 1a — Age filter (Client routing)', () => {
        it('should exclude stale ringing records from busy check via SQL age filter', async () => {
            process.env.SOFTPHONE_DEFAULT_IDENTITY = 'user_1';

            // Call 1: phone_number_settings -> client routing
            // Call 2: allowed identities
            // Call 3: busy check query
            let queryCallCount = 0;
            mockQuery.mockImplementation((sql) => {
                queryCallCount++;
                if (sql.includes('phone_number_settings')) {
                    return { rows: [{ routing_mode: 'client', client_identity: 'user_1' }] };
                }
                if (sql.includes('company_memberships')) {
                    return { rows: [{ identity: 'user_1' }] };
                }
                if (sql.includes("status IN ('ringing', 'in-progress')") && sql.includes('client:%')) {
                    // Verify the SQL includes age filtering for ringing records
                    expect(sql).toContain("status = 'ringing' AND started_at > NOW() - INTERVAL '90 seconds'");
                    expect(sql).toContain("status = 'in-progress' AND started_at > NOW() - INTERVAL '4 hours'");
                    // DB returns no rows because the stale ringing record is filtered out by the SQL WHERE clause
                    return { rows: [] };
                }
                return { rows: [] };
            });

            const req = makeReq();
            const res = makeRes();
            await handleVoiceInbound(req, res);

            // Should dial the user, NOT go to voicemail
            expect(res.send).toHaveBeenCalledTimes(1);
            const twiml = res.send.mock.calls[0][0];
            expect(twiml).toContain('<Client');
            expect(twiml).toContain('user_1');
            expect(twiml).not.toContain('<Record');
        });
    });

    // -----------------------------------------------------------------------
    // Layer 1b — Age filter: SIP routing
    // Same as above but for SIP path.
    // -----------------------------------------------------------------------
    describe('Layer 1b — Age filter (SIP routing)', () => {
        it('should exclude stale ringing records from SIP busy check via SQL age filter', async () => {
            process.env.SIP_USERS = 'dispatcher';
            process.env.SIP_DOMAIN = 'test.sip.twilio.com';

            mockQuery.mockImplementation((sql) => {
                if (sql.includes('phone_number_settings')) {
                    return { rows: [{ routing_mode: 'sip', client_identity: null }] };
                }
                if (sql.includes("to_number LIKE 'sip:%'")) {
                    // Verify the SQL includes age filtering
                    expect(sql).toContain("status = 'ringing' AND started_at > NOW() - INTERVAL '90 seconds'");
                    expect(sql).toContain("status IN ('in-progress', 'voicemail_recording') AND started_at > NOW() - INTERVAL '4 hours'");
                    // Stale record is filtered out by SQL — no busy rows returned
                    return { rows: [] };
                }
                return { rows: [] };
            });

            const req = makeReq();
            const res = makeRes();
            await handleVoiceInbound(req, res);

            const twiml = res.send.mock.calls[0][0];
            expect(twiml).toContain('<Sip');
            expect(twiml).toContain('dispatcher@test.sip.twilio.com');
            expect(twiml).not.toContain('<Record');
        });
    });

    // -----------------------------------------------------------------------
    // Layer 2a — Child leg finalization: no-answer
    // handleDialAction must set is_final=true on all child legs.
    // -----------------------------------------------------------------------
    describe('Layer 2a — Child leg finalization (no-answer)', () => {
        it('should finalize child legs with is_final=true when DialCallStatus is no-answer', async () => {
            mockQuery.mockResolvedValue({ rowCount: 2, rows: [] });

            const req = makeReq({
                DialCallStatus: 'no-answer',
                CallSid: 'CA_parent_002',
            });
            req.originalUrl = '/webhooks/twilio/voice-dial-action';
            const res = makeRes();

            await handleDialAction(req, res);

            // Find the UPDATE calls SET ... WHERE parent_call_sid query
            const finalizeCalls = mockQuery.mock.calls.filter(
                ([sql]) => typeof sql === 'string' && sql.includes('parent_call_sid') && sql.includes('is_final = true')
            );
            expect(finalizeCalls.length).toBeGreaterThanOrEqual(1);

            const [sql, params] = finalizeCalls[0];
            // Parent SID passed as $1
            expect(params[0]).toBe('CA_parent_002');
            // Non-answered status should map to 'no-answer' for $2
            expect(params[1]).toBe('no-answer');
            // SQL should set is_final = true
            expect(sql).toContain('is_final = true');
        });
    });

    // -----------------------------------------------------------------------
    // Layer 2b — Child leg finalization: completed
    // When DialCallStatus is 'completed', in-progress children get status='completed'.
    // -----------------------------------------------------------------------
    describe('Layer 2b — Child leg finalization (completed)', () => {
        it('should set in-progress children to completed when DialCallStatus is completed', async () => {
            mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

            const req = makeReq({
                DialCallStatus: 'completed',
                CallSid: 'CA_parent_003',
            });
            req.originalUrl = '/webhooks/twilio/voice-dial-action';
            const res = makeRes();

            await handleDialAction(req, res);

            // Find the child finalization query
            const finalizeCalls = mockQuery.mock.calls.filter(
                ([sql]) => typeof sql === 'string' && sql.includes('parent_call_sid') && sql.includes('is_final = true')
            );
            expect(finalizeCalls.length).toBeGreaterThanOrEqual(1);

            const [sql, params] = finalizeCalls[0];
            expect(params[0]).toBe('CA_parent_003');
            // The SQL uses CASE: in-progress -> 'completed', else $2
            // For completed dial status, $2 = 'completed'
            expect(sql).toContain("WHEN status = 'in-progress' THEN 'completed'");
            expect(params[1]).toBe('completed');

            // Response should be a hangup (not voicemail)
            const twiml = res.send.mock.calls[0][0];
            expect(twiml).toContain('<Hangup');
            expect(twiml).not.toContain('<Record');
        });
    });

    // -----------------------------------------------------------------------
    // Layer 3 — STALE_THRESHOLD_MINUTES
    // The reconcileStale module must use 3 minutes, not the old 10.
    // -----------------------------------------------------------------------
    describe('Layer 3 — STALE_THRESHOLD_MINUTES', () => {
        it('should be set to 3 minutes', () => {
            // Read the module source and verify the constant
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(
                path.join(__dirname, '..', 'backend', 'src', 'services', 'reconcileStale.js'),
                'utf8'
            );
            const match = src.match(/STALE_THRESHOLD_MINUTES\s*=\s*(\d+)/);
            expect(match).not.toBeNull();
            expect(parseInt(match[1], 10)).toBe(3);
        });
    });

    // -----------------------------------------------------------------------
    // Layer 4 — Twilio API fallback
    // When all clients appear busy per DB, verify via Twilio REST API.
    // If Twilio says the call is actually completed, fix the DB and route
    // to the now-free operator instead of voicemail.
    // -----------------------------------------------------------------------
    describe('Layer 4 — Twilio API fallback', () => {
        it('should verify stale records via Twilio API when all clients appear busy', async () => {
            process.env.SOFTPHONE_DEFAULT_IDENTITY = 'user_1';

            let busyQueryCount = 0;
            mockQuery.mockImplementation((sql, params) => {
                if (sql.includes('phone_number_settings')) {
                    return { rows: [{ routing_mode: 'client', client_identity: 'user_1' }] };
                }
                if (sql.includes('company_memberships')) {
                    return { rows: [{ identity: 'user_1' }] };
                }
                if (sql.includes("status IN ('ringing', 'in-progress')") && sql.includes('client:%')) {
                    busyQueryCount++;
                    // First query: DB says user_1 is busy (stale record)
                    return {
                        rows: [{
                            client_number: 'client:user_1',
                            call_sid: 'CA_stale_999',
                        }],
                    };
                }
                if (sql.includes('UPDATE calls SET status')) {
                    // The fix query that marks the stale record as completed
                    return { rowCount: 1, rows: [] };
                }
                return { rows: [] };
            });

            // Twilio API says the "busy" call is actually completed
            mockTwilioFetch.mockResolvedValue({
                status: 'completed',
                endTime: new Date().toISOString(),
            });

            const req = makeReq();
            const res = makeRes();
            await handleVoiceInbound(req, res);

            // Twilio API should have been called with the stale SID
            expect(mockTwilioCallsFn).toHaveBeenCalledWith('CA_stale_999');
            expect(mockTwilioFetch).toHaveBeenCalled();

            // The stale record should be updated in DB
            const updateCalls = mockQuery.mock.calls.filter(
                ([sql, params]) =>
                    typeof sql === 'string' &&
                    sql.includes('UPDATE calls SET status') &&
                    params && params.includes('CA_stale_999')
            );
            expect(updateCalls.length).toBeGreaterThanOrEqual(1);

            // After fixing the stale record, user_1 is no longer busy.
            // allBusy should be recalculated to false, so we should get a Dial to user_1.
            const twiml = res.send.mock.calls[0][0];
            expect(twiml).toContain('<Client');
            expect(twiml).toContain('user_1');
            expect(twiml).not.toContain('<Record');
        });
    });
});
