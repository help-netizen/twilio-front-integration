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
 *   Layer 5 — Centralized callAvailability module used by all 3 check points
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
    // -----------------------------------------------------------------------
    describe('Layer 1a — Age filter (Client routing)', () => {
        it('should exclude stale ringing records from busy check via SQL age filter', async () => {
            process.env.SOFTPHONE_DEFAULT_IDENTITY = 'user_1';

            mockQuery.mockImplementation((sql) => {
                if (sql.includes('phone_number_settings')) {
                    return { rows: [{ routing_mode: 'client', client_identity: 'user_1' }] };
                }
                if (sql.includes('company_memberships')) {
                    return { rows: [{ identity: 'user_1' }] };
                }
                if (sql.includes('is_final = false') && sql.includes('client:%')) {
                    // Verify the SQL includes age filtering via STALE_FILTER_SQL
                    expect(sql).toContain('90 seconds');
                    expect(sql).toContain('4 hours');
                    return { rows: [] };
                }
                return { rows: [] };
            });

            const req = makeReq();
            const res = makeRes();
            await handleVoiceInbound(req, res);

            const twiml = res.send.mock.calls[0][0];
            expect(twiml).toContain('<Client');
            expect(twiml).toContain('user_1');
            expect(twiml).not.toContain('<Record');
        });
    });

    // -----------------------------------------------------------------------
    // Layer 1b — Age filter: SIP routing
    // -----------------------------------------------------------------------
    describe('Layer 1b — Age filter (SIP routing)', () => {
        it('should exclude stale ringing records from SIP busy check via SQL age filter', async () => {
            process.env.SIP_USERS = 'dispatcher';
            process.env.SIP_DOMAIN = 'test.sip.twilio.com';

            mockQuery.mockImplementation((sql) => {
                if (sql.includes('phone_number_settings')) {
                    return { rows: [{ routing_mode: 'sip', client_identity: null }] };
                }
                if (sql.includes('is_final = false') && sql.includes("sip:%")) {
                    expect(sql).toContain('90 seconds');
                    expect(sql).toContain('4 hours');
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

            const finalizeCalls = mockQuery.mock.calls.filter(
                ([sql]) => typeof sql === 'string' && sql.includes('parent_call_sid') && sql.includes('is_final = true')
            );
            expect(finalizeCalls.length).toBeGreaterThanOrEqual(1);

            const [sql, params] = finalizeCalls[0];
            expect(params[0]).toBe('CA_parent_002');
            expect(params[1]).toBe('no-answer');
            expect(sql).toContain('is_final = true');
        });
    });

    // -----------------------------------------------------------------------
    // Layer 2b — Child leg finalization: completed
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

            const finalizeCalls = mockQuery.mock.calls.filter(
                ([sql]) => typeof sql === 'string' && sql.includes('parent_call_sid') && sql.includes('is_final = true')
            );
            expect(finalizeCalls.length).toBeGreaterThanOrEqual(1);

            const [sql, params] = finalizeCalls[0];
            expect(params[0]).toBe('CA_parent_003');
            expect(sql).toContain("WHEN status = 'in-progress' THEN 'completed'");
            expect(params[1]).toBe('completed');

            const twiml = res.send.mock.calls[0][0];
            expect(twiml).toContain('<Hangup');
            expect(twiml).not.toContain('<Record');
        });
    });

    // -----------------------------------------------------------------------
    // Layer 3 — STALE_THRESHOLD_MINUTES
    // -----------------------------------------------------------------------
    describe('Layer 3 — STALE_THRESHOLD_MINUTES', () => {
        it('should be set to 3 minutes', () => {
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
                if (sql.includes('is_final = false') && sql.includes('client:%') && !sql.includes('UPDATE')) {
                    busyQueryCount++;
                    if (busyQueryCount === 1) {
                        // First query: DB says user_1 is busy (stale record)
                        return {
                            rows: [{
                                client_number: 'client:user_1',
                                call_sid: 'CA_stale_999',
                            }],
                        };
                    }
                    // Second query (after Twilio API fix): no longer busy
                    return { rows: [] };
                }
                if (sql.includes('UPDATE calls SET status')) {
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

            // After fixing, user_1 is free → should get <Dial><Client>
            const twiml = res.send.mock.calls[0][0];
            expect(twiml).toContain('<Client');
            expect(twiml).toContain('user_1');
            expect(twiml).not.toContain('<Record');
        });
    });

    // -----------------------------------------------------------------------
    // Layer 5 — Centralized callAvailability module
    // -----------------------------------------------------------------------
    describe('Layer 5 — Centralized callAvailability module', () => {
        it('should export all required functions', () => {
            const ca = require('../backend/src/services/callAvailability');
            expect(typeof ca.getBusyClientIdentities).toBe('function');
            expect(typeof ca.getBusySipUsers).toBe('function');
            expect(typeof ca.isContactBusy).toBe('function');
            expect(typeof ca.verifyAndFixStaleCalls).toBe('function');
            expect(typeof ca.STALE_FILTER_SQL).toBe('string');
            expect(ca.STALE_FILTER_SQL).toContain('90 seconds');
            expect(ca.STALE_FILTER_SQL).toContain('4 hours');
        });

        it('isContactBusy should return false when no active calls', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            const ca = require('../backend/src/services/callAvailability');
            const busy = await ca.isContactBusy('+15551234567', 'test');
            expect(busy).toBe(false);
        });

        it('isContactBusy should verify via Twilio API and return false if call is actually completed', async () => {
            mockQuery.mockImplementation((sql) => {
                if (sql.includes('UPDATE')) return { rowCount: 1, rows: [] };
                return { rows: [{ call_sid: 'CA_stale_123' }] };
            });
            mockTwilioFetch.mockResolvedValue({ status: 'completed', endTime: new Date().toISOString() });

            const ca = require('../backend/src/services/callAvailability');
            const busy = await ca.isContactBusy('+15551234567', 'test');
            expect(busy).toBe(false);
            expect(mockTwilioCallsFn).toHaveBeenCalledWith('CA_stale_123');
        });
    });
});
