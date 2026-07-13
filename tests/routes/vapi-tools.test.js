/**
 * VAPI Tools route tests — LQV2
 * Covers backend-testable cases from Docs/test-cases/LQV2-lead-qualifier-v2.md:
 *   Group 1  middleware/auth      TC-LQV2-001..004
 *   Group 2  dispatcher           TC-LQV2-005..007
 *   Group 3  checkServiceArea     TC-LQV2-008..011
 *   Group 4  validateAddress      TC-LQV2-012..016
 *   Group 5  checkAvailability    TC-LQV2-017..020
 *   Group 6  createLead           TC-LQV2-022a,022..029,029a
 *   Group 7  parallel tool calls  TC-LQV2-030
 *   Group 8  buildCallSummary     TC-LQV2-031..032 (via createLead body)
 *   Group 9  server mount         TC-LQV2-033
 *
 * System-prompt / LLM-evaluation cases (TC-038..057) live outside Jest
 * (tests/prompts/*) and are not covered here.
 */

const express = require('express');
const request = require('supertest');
const EventEmitter = require('events');

// ─── Mocks (must be declared before requiring the router) ──────────────────────

jest.mock('../../backend/src/services/territoryService', () => ({
    isZipInTerritory: jest.fn(),
}));
jest.mock('../../backend/src/services/leadsService', () => ({
    createLead: jest.fn(),
}));
jest.mock('../../backend/src/services/scheduleService', () => ({
    getAvailableSlots: jest.fn(),
}));
// VAPI-SLOT-ENGINE-001 (T2): recommendSlots gate + engine + tz-combine.
jest.mock('../../backend/src/services/marketplaceService', () => ({
    SMART_SLOT_ENGINE_APP_KEY: 'smart-slot-engine',
    isAppConnected: jest.fn(),
}));
jest.mock('../../backend/src/services/slotEngineService', () => ({
    getRecommendations: jest.fn(),
    resolveTimezone: jest.fn(),
    tzCombine: jest.fn(),
}));
jest.mock('https', () => ({ get: jest.fn() }));

const https = require('https');
// SAFE_FALLBACK: the ONLY shape the skill layer leaks on any error/unknown-tool
// path (imported from the source of truth so these assertions track its wording).
const { SAFE_FALLBACK } = require('../../backend/src/services/agentSkills/resultShapes');
const territoryService = require('../../backend/src/services/territoryService');
const leadsService = require('../../backend/src/services/leadsService');
const scheduleService = require('../../backend/src/services/scheduleService');
const marketplaceService = require('../../backend/src/services/marketplaceService');
const slotEngineService = require('../../backend/src/services/slotEngineService');
const vapiToolsRouter = require('../../backend/src/routes/vapi-tools');

// ─── Helpers ───────────────────────────────────────────────────────────────────

const SECRET = 'test-secret';

function makeApp() {
    // /api/vapi-tools is mounted with NO auth middleware (public endpoint).
    const app = express();
    app.use(express.json());
    app.use('/api/vapi-tools', vapiToolsRouter);
    return app;
}

/** Build a VAPI tool-calls payload. */
function toolCall(name, args, id = 'tc1') {
    return {
        message: {
            type: 'tool-calls',
            toolCallList: [
                { id, function: { name, arguments: JSON.stringify(args) } },
            ],
            call: { customer: { number: '+16175551234' } },
        },
    };
}

/** Parse the JSON result string for the Nth tool call in the response. */
function resultOf(res, idx = 0) {
    return JSON.parse(res.body.results[idx].result);
}

/** Make https.get invoke its callback with a fake response emitting `payload`. */
function mockGeocode(payload) {
    https.get.mockImplementation((url, cb) => {
        const fakeRes = new EventEmitter();
        // Defer emission so the .on() handlers are registered first.
        process.nextTick(() => {
            fakeRes.emit('data', JSON.stringify(payload));
            fakeRes.emit('end');
        });
        const req = { on: jest.fn().mockReturnThis() };
        cb(fakeRes);
        return req;
    });
}

/** Make https.get emit a connection error. */
function mockGeocodeError(message) {
    https.get.mockImplementation((url, cb) => {
        const req = new EventEmitter();
        process.nextTick(() => req.emit('error', new Error(message)));
        // .get returns the request emitter so `.on('error', reject)` works
        return req;
    });
}

let app;
beforeEach(() => {
    jest.clearAllMocks();
    process.env.VAPI_TOOLS_SECRET = SECRET;
    process.env.GOOGLE_GEOCODING_KEY = 'test-geocoding-key';
    delete process.env.VITE_GOOGLE_MAPS_API_KEY; // ensure dedicated key is used
    app = makeApp();
});

// ════════════════════════════════════════════════════════════════════════════
// Group 1 — Middleware & auth
// ════════════════════════════════════════════════════════════════════════════

describe('Group 1 — middleware/auth', () => {
    // TC-LQV2-001
    test('correct x-vapi-secret → status-update acknowledged with {}', async () => {
        const res = await request(app)
            .post('/api/vapi-tools')
            .set('x-vapi-secret', SECRET)
            .send({ message: { type: 'status-update' } });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({});
    });

    // TC-LQV2-002
    test('wrong x-vapi-secret → 401', async () => {
        const res = await request(app)
            .post('/api/vapi-tools')
            .set('x-vapi-secret', 'wrong')
            .send({ message: { type: 'status-update' } });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: 'Unauthorized' });
    });

    // TC-LQV2-003
    test('missing x-vapi-secret → 401', async () => {
        const res = await request(app)
            .post('/api/vapi-tools')
            .send({ message: { type: 'status-update' } });
        expect(res.status).toBe(401);
    });

    // TC-LQV2-004 (RBAC-AUDIT-001 R2 hardening): missing secret must fail closed.
    test('no VAPI_TOOLS_SECRET in env → 503, request refused', async () => {
        delete process.env.VAPI_TOOLS_SECRET;
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = await request(app)
            .post('/api/vapi-tools')
            .send({ message: { type: 'status-update' } });
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: 'vapi tools not configured' });
        expect(errSpy).toHaveBeenCalled();
        errSpy.mockRestore();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Group 2 — Dispatcher & non-tool messages
// ════════════════════════════════════════════════════════════════════════════

describe('Group 2 — dispatcher', () => {
    const auth = (r) => r.set('x-vapi-secret', SECRET);

    // TC-LQV2-005
    test('non tool-calls message types → {}', async () => {
        for (const type of ['status-update', 'end-of-call-report']) {
            const res = await auth(request(app).post('/api/vapi-tools'))
                .send({ message: { type } });
            expect(res.status).toBe(200);
            expect(res.body).toEqual({});
        }
    });

    // TC-LQV2-006 / ASK-DEG-07 (G6): unknown tool → well-formed results[] with the
    // skill-layer SAFE_FALLBACK (never a `{ error }` leak, never a 500). The tool
    // name is NOT echoed back to the caller.
    test('unknown tool name → SAFE_FALLBACK in a well-formed result (no error leak)', async () => {
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('unknownTool', {}));
        expect(res.status).toBe(200);
        expect(resultOf(res)).toEqual(SAFE_FALLBACK);
        expect(res.body.results[0].toolCallId).toBe('tc1');
    });

    // TC-LQV2-007
    test('invalid JSON arguments → parsed as {} (zip missing)', async () => {
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send({
                message: {
                    type: 'tool-calls',
                    toolCallList: [
                        { id: 'tc1', function: { name: 'checkServiceArea', arguments: 'not valid json' } },
                    ],
                },
            });
        expect(res.status).toBe(200);
        // empty args → zip missing → handler returns the "zip is required" branch
        expect(resultOf(res)).toEqual({ inServiceArea: false, error: 'zip is required' });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Group 3 — checkServiceArea
// ════════════════════════════════════════════════════════════════════════════

describe('Group 3 — checkServiceArea', () => {
    const auth = (r) => r.set('x-vapi-secret', SECRET);

    // TC-LQV2-008
    test('zip in service area → inServiceArea true with area/city/state', async () => {
        territoryService.isZipInTerritory.mockResolvedValue({
            inside: true, area: 'Boston', city: 'Boston', state: 'MA', zip: '02101', mode: 'list',
        });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('checkServiceArea', { zip: '02101' }));
        expect(resultOf(res)).toEqual({
            inServiceArea: true, area: 'Boston', city: 'Boston', state: 'MA', zip: '02101',
        });
    });

    // TC-LQV2-009
    test('zip outside service area → inServiceArea false (echoes the normalized zip)', async () => {
        territoryService.isZipInTerritory.mockResolvedValue({
            inside: false, area: '', city: '', state: '', zip: '03801', mode: 'list',
        });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('checkServiceArea', { zip: '03801' }));
        expect(resultOf(res)).toEqual({ inServiceArea: false, zip: '03801' });
    });

    // TC-LQV2-010
    test('zip not provided → inServiceArea false + error, no DB call', async () => {
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('checkServiceArea', {}));
        expect(resultOf(res)).toEqual({ inServiceArea: false, error: 'zip is required' });
        expect(territoryService.isZipInTerritory).not.toHaveBeenCalled();
    });

    // TC-LQV2-011 / ASK-VAPI-22 (G6): a DB error inside the skill degrades to the
    // skill-layer SAFE_FALLBACK — HTTP 200, graceful, and CRITICALLY the internal
    // error message ('DB connection failed') is NEVER surfaced to the caller.
    test('DB error → SAFE_FALLBACK, HTTP 200, no err.message leak', async () => {
        territoryService.isZipInTerritory.mockRejectedValue(new Error('DB connection failed'));
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('checkServiceArea', { zip: '02101' }));
        expect(res.status).toBe(200);
        expect(resultOf(res)).toEqual(SAFE_FALLBACK);
        // The leak (@ old vapi-tools.js:380 `result = { error: err.message }`) is gone.
        expect(JSON.stringify(res.body)).not.toContain('DB connection failed');
        errSpy.mockRestore();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Group 4 — validateAddress
// ════════════════════════════════════════════════════════════════════════════

describe('Group 4 — validateAddress', () => {
    const auth = (r) => r.set('x-vapi-secret', SECRET);

    // TC-LQV2-012
    test('valid address → valid true with standardized + correctedZip', async () => {
        mockGeocode({
            status: 'OK',
            results: [{
                formatted_address: '45 Tremont St Apt 3, Boston, MA 02108, USA',
                geometry: { location: { lat: 42.357, lng: -71.059 } },
                address_components: [
                    { types: ['postal_code'], short_name: '02108', long_name: '02108' },
                ],
            }],
        });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('validateAddress', { street: '45 Tremont St', apt: '3', city: 'Boston', state: 'MA', zip: '02108' }));
        expect(resultOf(res)).toEqual({
            valid: true,
            standardized: '45 Tremont St Apt 3, Boston, MA 02108',
            correctedZip: '02108',
            lat: 42.357,
            lng: -71.059,
        });
    });

    // TC-LQV2-013
    test('ZERO_RESULTS → valid false', async () => {
        mockGeocode({ status: 'ZERO_RESULTS', results: [] });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('validateAddress', { street: '999 Fake St', city: 'Nowhere' }));
        expect(resultOf(res)).toEqual({ valid: false });
    });

    // TC-LQV2-014
    test('network error → valid false, never throws', async () => {
        mockGeocodeError('Network timeout');
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('validateAddress', { street: '45 Tremont St' }));
        expect(res.status).toBe(200);
        expect(resultOf(res)).toEqual({ valid: false });
        errSpy.mockRestore();
    });

    // TC-LQV2-015
    test('correctedZip differs from entered zip', async () => {
        mockGeocode({
            status: 'OK',
            results: [{
                formatted_address: '100 Some St, Boston, MA 02115, USA',
                geometry: { location: { lat: 42.34, lng: -71.09 } },
                address_components: [{ types: ['postal_code'], short_name: '02115' }],
            }],
        });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('validateAddress', { street: '100 Some St', zip: '02101' }));
        const out = resultOf(res);
        expect(out.valid).toBe(true);
        expect(out.correctedZip).toBe('02115');
    });

    // TC-LQV2-016
    test('missing geocoding key → valid false, never calls https', async () => {
        delete process.env.GOOGLE_GEOCODING_KEY;
        delete process.env.VITE_GOOGLE_MAPS_API_KEY;
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('validateAddress', { street: '45 Tremont St' }));
        const out = resultOf(res);
        expect(out.valid).toBe(false);
        expect(https.get).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    test('falls back to VITE_GOOGLE_MAPS_API_KEY when GOOGLE_GEOCODING_KEY unset', async () => {
        delete process.env.GOOGLE_GEOCODING_KEY;
        process.env.VITE_GOOGLE_MAPS_API_KEY = 'fallback-key';
        mockGeocode({ status: 'ZERO_RESULTS', results: [] });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('validateAddress', { street: '45 Tremont St' }));
        expect(resultOf(res)).toEqual({ valid: false });
        expect(https.get).toHaveBeenCalled(); // fallback key was used → request made
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Group 5 — checkAvailability
// ════════════════════════════════════════════════════════════════════════════

describe('Group 5 — checkAvailability', () => {
    const auth = (r) => r.set('x-vapi-secret', SECRET);

    // TC-LQV2-017
    test('success → delegates to scheduleService and returns slots', async () => {
        const slots = [
            { date: '2026-06-10', label: 'Tuesday, June 10th between 10am and 1pm', start: '10:00', end: '13:00' },
        ];
        scheduleService.getAvailableSlots.mockResolvedValue({ slots });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('checkAvailability', { zip: '02101', unitType: 'Refrigerator' }));
        expect(resultOf(res)).toEqual({ slots });
        expect(scheduleService.getAvailableSlots).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ days: 5, slotDurationMin: 120, maxSlots: 3 }),
        );
    });

    // TC-LQV2-018
    test('no slots → empty array with error', async () => {
        scheduleService.getAvailableSlots.mockResolvedValue({ slots: [], error: 'No availability found in the next 5 days' });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('checkAvailability', { zip: '02101' }));
        expect(resultOf(res)).toEqual({ slots: [], error: 'No availability found in the next 5 days' });
    });

    // TC-LQV2-020 (scheduleService throws → graceful)
    test('scheduleService throws → slots [] with error, HTTP 200', async () => {
        scheduleService.getAvailableSlots.mockRejectedValue(new Error('schedule unreachable'));
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('checkAvailability', { zip: '02101' }));
        expect(res.status).toBe(200);
        expect(resultOf(res)).toEqual({ slots: [], error: 'schedule unreachable' });
        errSpy.mockRestore();
    });

    test('days override is forwarded', async () => {
        scheduleService.getAvailableSlots.mockResolvedValue({ slots: [] });
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('checkAvailability', { zip: '02101', days: 10 }));
        expect(scheduleService.getAvailableSlots).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ days: 10 }),
        );
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Group 6 — createLead
// ════════════════════════════════════════════════════════════════════════════

describe('Group 6 — createLead', () => {
    const auth = (r) => r.set('x-vapi-secret', SECRET);
    const fullArgs = {
        firstName: 'John', lastName: 'Smith', phone: '+16175551234',
        zip: '02101', city: 'Boston', state: 'MA',
        unitType: 'Refrigerator', brand: 'Samsung', unitAge: '5 years',
        problemDescription: 'not cooling', preferredSlot: 'Tuesday June 10th 10am-1pm',
        addressValidated: true,
    };

    // TC-LQV2-022
    test('success → all mapped fields, JobSource AI Phone, full Comments', async () => {
        leadsService.createLead.mockResolvedValue({ uuid: 'lead-uuid-001' });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', fullArgs));
        expect(resultOf(res)).toEqual({ success: true, leadId: 'lead-uuid-001' });

        const [body, companyId] = leadsService.createLead.mock.calls[0];
        expect(body.JobSource).toBe('AI Phone');
        expect(body.JobType).toBe('Refrigerator Repair');
        expect(body.FirstName).toBe('John');
        expect(body.Phone).toBe('+16175551234');
        expect(body.PostalCode).toBe('02101');
        expect(body.Comments).toBe(
            'Unit: Refrigerator | Brand: Samsung | Age: 5 years | Problem: not cooling | Fee agreed: Yes | Slot: Tuesday June 10th 10am-1pm | Address validated: yes',
        );
        expect(typeof companyId).toBe('string');
    });

    // TC-LQV2-022a
    test('email provided → included in body', async () => {
        leadsService.createLead.mockResolvedValue({ uuid: 'x' });
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', { ...fullArgs, email: 'john@example.com' }));
        expect(leadsService.createLead.mock.calls[0][0].Email).toBe('john@example.com');
    });

    test('no email → Email key absent', async () => {
        leadsService.createLead.mockResolvedValue({ uuid: 'x' });
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', fullArgs));
        expect(leadsService.createLead.mock.calls[0][0]).not.toHaveProperty('Email');
    });

    // Regression: street/apt must reach the lead as Address/Unit
    test('street + apt → mapped to Address/Unit', async () => {
        leadsService.createLead.mockResolvedValue({ uuid: 'x' });
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', { ...fullArgs, street: '12 Walpole St', apt: '2B' }));
        const body = leadsService.createLead.mock.calls[0][0];
        expect(body.Address).toBe('12 Walpole St');
        expect(body.Unit).toBe('2B');
        expect(body.City).toBe('Boston');
    });

    test('no street → Address/Unit keys absent (cold/escalation lead)', async () => {
        leadsService.createLead.mockResolvedValue({ uuid: 'x' });
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', fullArgs));
        const body = leadsService.createLead.mock.calls[0][0];
        expect(body).not.toHaveProperty('Address');
        expect(body).not.toHaveProperty('Unit');
    });

    // TC-LQV2-023
    test('phone missing → success false, createLead not called', async () => {
        const { phone, ...noPhone } = fullArgs;
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', noPhone));
        expect(resultOf(res)).toEqual({ success: false, error: 'Phone number is required to create lead' });
        expect(leadsService.createLead).not.toHaveBeenCalled();
    });

    // Disqualified (invalid) lead: logged for refund tracking, no phone required
    test('disqualified out_of_area → flagged lead, phone not required', async () => {
        leadsService.createLead.mockResolvedValue({ uuid: 'dq' });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', {
                firstName: 'Jane', lastName: 'Caller', zip: '03801', unitType: 'Refrigerator',
                disqualified: true, disqualReason: 'out_of_area',
            }));
        expect(resultOf(res)).toEqual({ success: true, leadId: 'dq' });
        const body = leadsService.createLead.mock.calls[0][0];
        expect(body.JobSource).toBe('AI Phone (Invalid)');
        expect(body.Comments).toMatch(/^INVALID LEAD — out_of_area\./);
    });

    // TC-LQV2-024
    test('phone too short → success false', async () => {
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', { ...fullArgs, phone: '123' }));
        expect(resultOf(res)).toEqual({ success: false, error: 'Phone number is required to create lead' });
    });

    // TC-LQV2-025
    test('JobSource always AI Phone regardless of input', async () => {
        leadsService.createLead.mockResolvedValue({ uuid: 'x' });
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', { ...fullArgs, JobSource: 'Walk-in', jobSource: 'Web' }));
        expect(leadsService.createLead.mock.calls[0][0].JobSource).toBe('AI Phone');
    });

    // TC-LQV2-026
    test('escalationRequested true → reflected in Comments', async () => {
        leadsService.createLead.mockResolvedValue({ uuid: 'x' });
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', { ...fullArgs, escalationRequested: true }));
        expect(leadsService.createLead.mock.calls[0][0].Comments).toContain('escalation_requested: true');
    });

    // TC-LQV2-027
    test('createLead fails twice → retry once, success false, HTTP 200', async () => {
        leadsService.createLead.mockRejectedValue(new Error('db down'));
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', fullArgs));
        expect(res.status).toBe(200);
        expect(resultOf(res).success).toBe(false);
        expect(leadsService.createLead).toHaveBeenCalledTimes(2);
        errSpy.mockRestore();
    }, 10000);

    // TC-LQV2-028
    test('first attempt fails, retry succeeds', async () => {
        leadsService.createLead
            .mockRejectedValueOnce(new Error('transient'))
            .mockResolvedValueOnce({ uuid: 'lead-uuid-002' });
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', fullArgs));
        expect(resultOf(res)).toEqual({ success: true, leadId: 'lead-uuid-002' });
        expect(leadsService.createLead).toHaveBeenCalledTimes(2);
        errSpy.mockRestore();
    }, 10000);

    // TC-LQV2-029
    test('preferredSlot null → Comments shows pending callback', async () => {
        leadsService.createLead.mockResolvedValue({ uuid: 'x' });
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', { ...fullArgs, preferredSlot: null }));
        expect(leadsService.createLead.mock.calls[0][0].Comments).toContain('Slot: pending callback');
    });

    // TC-LQV2-029a
    test('addressValidated false → Comments shows Address validated: no', async () => {
        leadsService.createLead.mockResolvedValue({ uuid: 'x' });
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', { ...fullArgs, addressValidated: false }));
        expect(leadsService.createLead.mock.calls[0][0].Comments).toContain('Address validated: no');
    });

    // TC-LQV2-031/032 — buildCallSummary edge cases (via body)
    test('age missing → Comments shows Age: unknown', async () => {
        leadsService.createLead.mockResolvedValue({ uuid: 'x' });
        const { unitAge, ...noAge } = fullArgs;
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', noAge));
        expect(leadsService.createLead.mock.calls[0][0].Comments).toContain('Age: unknown');
    });

    test('callerName fallback splits into first/last when names absent', async () => {
        leadsService.createLead.mockResolvedValue({ uuid: 'x' });
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', { phone: '+16175551234', callerName: 'Jane Doe' }));
        const body = leadsService.createLead.mock.calls[0][0];
        expect(body.FirstName).toBe('Jane');
        expect(body.LastName).toBe('Doe');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Group 10 — recommendSlots (VAPI-SLOT-ENGINE-001 T2)
// ════════════════════════════════════════════════════════════════════════════

describe('Group 10 — recommendSlots', () => {
    const auth = (r) => r.set('x-vapi-secret', SECRET);

    /** A pinned-wrapper recommendation shape (slotEngineService output). */
    function rec(date, start, end, tech = 'Alex', confidence = 'high') {
        return {
            date,
            time_frame: { start, end },
            technicians: tech ? [{ id: 't1', name: tech }] : [],
            confidence,
        };
    }

    beforeEach(() => {
        // Default: app connected + engine ok (individual tests override).
        marketplaceService.isAppConnected.mockResolvedValue(true);
        slotEngineService.getRecommendations.mockResolvedValue({ recommendations: [], engine_status: 'ok' });
        slotEngineService.resolveTimezone.mockResolvedValue('America/New_York');
    });

    // Gating — app NOT connected → fallback, engine NEVER called.
    test('app not connected → {available:false,fallback:true}, engine not called', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(false);
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('recommendSlots', { zip: '02101' }));
        expect(resultOf(res)).toEqual({ available: false, slots: [], fallback: true });
        expect(slotEngineService.getRecommendations).not.toHaveBeenCalled();
    });

    // Safe-fail — engine_status 'unavailable'.
    test('engine_status unavailable → fallback', async () => {
        slotEngineService.getRecommendations.mockResolvedValue({ recommendations: [rec('2026-07-08', '10:00', '13:00')], engine_status: 'unavailable' });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('recommendSlots', { zip: '02101' }));
        expect(resultOf(res)).toEqual({ available: false, slots: [], fallback: true });
    });

    // Safe-fail — empty recommendations.
    test('empty recommendations → fallback', async () => {
        slotEngineService.getRecommendations.mockResolvedValue({ recommendations: [], engine_status: 'ok' });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('recommendSlots', { lat: 42.35, lng: -71.06 }));
        expect(resultOf(res)).toEqual({ available: false, slots: [], fallback: true });
    });

    // Safe-fail — getRecommendations throws (never 500, never propagates).
    test('getRecommendations throws → fallback, HTTP 200', async () => {
        slotEngineService.getRecommendations.mockRejectedValue(new Error('NEW_JOB_LOCATION_REQUIRED'));
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('recommendSlots', {}));
        expect(res.status).toBe(200);
        expect(resultOf(res)).toEqual({ available: false, slots: [], fallback: true });
        errSpy.mockRestore();
    });

    // Happy path — rank order preserved, key + label + fields mapped.
    test('happy path → maps recs to keyed slots with label + techName + confidence', async () => {
        slotEngineService.getRecommendations.mockResolvedValue({
            recommendations: [rec('2026-07-08', '10:00', '13:00', 'Alex', 'high')],
            engine_status: 'ok',
        });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('recommendSlots', { lat: 42.35, lng: -71.06, unitType: 'Refrigerator' }));
        const out = resultOf(res);
        expect(out.available).toBe(true);
        expect(out.slots).toHaveLength(1);
        expect(out.slots[0]).toEqual({
            key: '2026-07-08|10:00|13:00',
            date: '2026-07-08',
            start: '10:00',
            end: '13:00',
            label: 'Wednesday, July 8, 10 AM to 1 PM', // f73636d formatSlotLabel: full weekday/month + 12h
            techName: 'Alex',
            confidence: 'high',
        });
    });

    // Cap — > 3 recs → sliced to 3.
    test('more than 3 recs → capped to 3', async () => {
        slotEngineService.getRecommendations.mockResolvedValue({
            recommendations: [
                rec('2026-07-08', '10:00', '13:00'),
                rec('2026-07-08', '13:00', '16:00'),
                rec('2026-07-09', '09:00', '12:00'),
                rec('2026-07-09', '12:00', '15:00'),
                rec('2026-07-10', '10:00', '13:00'),
            ],
            engine_status: 'ok',
        });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('recommendSlots', { zip: '02101' }));
        const out = resultOf(res);
        expect(out.available).toBe(true);
        expect(out.slots).toHaveLength(3);
        expect(out.slots.map(s => s.key)).toEqual([
            '2026-07-08|10:00|13:00', '2026-07-08|13:00|16:00', '2026-07-09|09:00|12:00',
        ]);
    });

    // excludeSlots — offered keys filtered out (deeper mode).
    test('excludeSlots filters offered keys', async () => {
        slotEngineService.getRecommendations.mockResolvedValue({
            recommendations: [
                rec('2026-07-08', '10:00', '13:00'),
                rec('2026-07-09', '09:00', '12:00'),
            ],
            engine_status: 'ok',
        });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('recommendSlots', { zip: '02101', excludeSlots: ['2026-07-08|10:00|13:00'] }));
        const out = resultOf(res);
        expect(out.slots.map(s => s.key)).toEqual(['2026-07-09|09:00|12:00']);
    });

    // Dedup — same window from two techs collapses to one key/offer.
    test('same window from two techs dedups to one slot', async () => {
        slotEngineService.getRecommendations.mockResolvedValue({
            recommendations: [
                rec('2026-07-08', '10:00', '13:00', 'Alex'),
                rec('2026-07-08', '10:00', '13:00', 'Sam'),
            ],
            engine_status: 'ok',
        });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('recommendSlots', { zip: '02101' }));
        const out = resultOf(res);
        expect(out.slots).toHaveLength(1);
        expect(out.slots[0].techName).toBe('Alex'); // first one wins
    });

    // All recs excluded → fallback (deeper mode exhausted the horizon).
    test('all recs excluded → fallback', async () => {
        slotEngineService.getRecommendations.mockResolvedValue({
            recommendations: [rec('2026-07-08', '10:00', '13:00')],
            engine_status: 'ok',
        });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('recommendSlots', { zip: '02101', excludeSlots: ['2026-07-08|10:00|13:00'] }));
        expect(resultOf(res)).toEqual({ available: false, slots: [], fallback: true });
    });

    // Location resolution — lat/lng preferred when both finite.
    test('lat+lng passed to engine as new_job.lat/lng (no address)', async () => {
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('recommendSlots', { lat: 42.35, lng: -71.06, unitType: 'Dryer', durationMinutes: 90 }));
        const [companyId, input] = slotEngineService.getRecommendations.mock.calls[0];
        expect(typeof companyId).toBe('string');
        expect(input.new_job).toMatchObject({
            lat: 42.35, lng: -71.06, job_type: 'Dryer Repair', duration_minutes: 90,
        });
        expect(input.new_job).not.toHaveProperty('address');
    });

    // Location resolution — zip becomes new_job.address when no coords; duration default.
    test('zip only → new_job.address = zip, default duration + job_type', async () => {
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('recommendSlots', { zip: '02101' }));
        const input = slotEngineService.getRecommendations.mock.calls[0][1];
        expect(input.new_job.address).toBe('02101');
        expect(input.new_job).not.toHaveProperty('lat');
        expect(input.new_job.duration_minutes).toBe(120);
        expect(input.new_job.job_type).toBe('Appliance Repair');
    });

    // daysAhead extends latest_allowed_date in the getRecommendations input.
    test('daysAhead → latest_allowed_date set in engine input (company-local)', async () => {
        // Freeze "now" so today+daysAhead is deterministic.
        const RealDate = Date;
        const fixedNow = new RealDate('2026-07-04T12:00:00Z');
        jest.spyOn(global, 'Date').mockImplementation((...a) => (a.length ? new RealDate(...a) : fixedNow));
        global.Date.UTC = RealDate.UTC;
        global.Date.now = () => fixedNow.getTime();
        try {
            await auth(request(app).post('/api/vapi-tools'))
                .send(toolCall('recommendSlots', { zip: '02101', daysAhead: 5 }));
            const input = slotEngineService.getRecommendations.mock.calls[0][1];
            // 2026-07-04 (America/New_York) + 5 days = 2026-07-09.
            expect(input.new_job.latest_allowed_date).toBe('2026-07-09');
        } finally {
            global.Date.mockRestore();
        }
    });

    // vapiSecretAuth still enforced for the new tool.
    test('wrong x-vapi-secret → 401 (recommendSlots behind the secret)', async () => {
        const res = await request(app)
            .post('/api/vapi-tools')
            .set('x-vapi-secret', 'wrong')
            .send(toolCall('recommendSlots', { zip: '02101' }));
        expect(res.status).toBe(401);
        expect(slotEngineService.getRecommendations).not.toHaveBeenCalled();
    });

    // Envelope shape preserved.
    test('envelope = {results:[{toolCallId, result:JSON.stringify(...)}]}', async () => {
        slotEngineService.getRecommendations.mockResolvedValue({
            recommendations: [rec('2026-07-08', '10:00', '13:00')],
            engine_status: 'ok',
        });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('recommendSlots', { zip: '02101' }, 'tcX'));
        expect(res.body.results).toHaveLength(1);
        expect(res.body.results[0].toolCallId).toBe('tcX');
        expect(typeof res.body.results[0].result).toBe('string');
        expect(JSON.parse(res.body.results[0].result).available).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Group 11 — createLead slot-persist (VAPI-SLOT-ENGINE-001 T2)
// ════════════════════════════════════════════════════════════════════════════

describe('Group 11 — createLead slot-persist', () => {
    const auth = (r) => r.set('x-vapi-secret', SECRET);
    const baseArgs = {
        firstName: 'John', lastName: 'Smith', phone: '+16175551234',
        zip: '02101', city: 'Boston', state: 'MA', unitType: 'Refrigerator',
        preferredSlot: 'Tuesday July 8th 10am-1pm', addressValidated: true,
    };

    beforeEach(() => {
        slotEngineService.resolveTimezone.mockResolvedValue('America/New_York');
        // Deterministic tzCombine mock: date+time → a fixed ISO per field.
        slotEngineService.tzCombine.mockImplementation((date, hhmm) => `${date}T${hhmm}:00.000Z-COMBINED`);
        leadsService.createLead.mockResolvedValue({ uuid: 'lead-slot-1' });
    });

    // WITH chosenSlot + coords → all four columns + Comments kept.
    test('chosenSlot + lat/lng → LeadDateTime/LeadEndDateTime/Latitude/Longitude in body', async () => {
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', {
                ...baseArgs,
                chosenSlot: { date: '2026-07-08', start: '10:00', end: '13:00' },
                lat: 42.35, lng: -71.06,
            }));
        expect(resultOf(res)).toEqual({ success: true, leadId: 'lead-slot-1' });
        const body = leadsService.createLead.mock.calls[0][0];
        expect(slotEngineService.tzCombine).toHaveBeenCalledWith('2026-07-08', '10:00', 'America/New_York');
        expect(slotEngineService.tzCombine).toHaveBeenCalledWith('2026-07-08', '13:00', 'America/New_York');
        expect(body.LeadDateTime).toBe('2026-07-08T10:00:00.000Z-COMBINED');
        expect(body.LeadEndDateTime).toBe('2026-07-08T13:00:00.000Z-COMBINED');
        expect(body.Latitude).toBe(42.35);
        expect(body.Longitude).toBe(-71.06);
        // Comments summary still recorded for human context.
        expect(body.Comments).toContain('Slot: Tuesday July 8th 10am-1pm');
    });

    // Edge 7 — chosenSlot present, coords absent → only the two datetime columns.
    test('chosenSlot without lat/lng → only LeadDateTime/LeadEndDateTime (no coords)', async () => {
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', {
                ...baseArgs,
                chosenSlot: { date: '2026-07-08', start: '10:00', end: '13:00' },
            }));
        const body = leadsService.createLead.mock.calls[0][0];
        expect(body.LeadDateTime).toBe('2026-07-08T10:00:00.000Z-COMBINED');
        expect(body.LeadEndDateTime).toBe('2026-07-08T13:00:00.000Z-COMBINED');
        expect(body).not.toHaveProperty('Latitude');
        expect(body).not.toHaveProperty('Longitude');
    });

    // Back-compat — NO chosenSlot → none of the four keys, tzCombine never called.
    test('no chosenSlot → body has none of the four slot fields (byte-identical to today)', async () => {
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', baseArgs));
        const body = leadsService.createLead.mock.calls[0][0];
        expect(body).not.toHaveProperty('LeadDateTime');
        expect(body).not.toHaveProperty('LeadEndDateTime');
        expect(body).not.toHaveProperty('Latitude');
        expect(body).not.toHaveProperty('Longitude');
        expect(slotEngineService.tzCombine).not.toHaveBeenCalled();
    });

    // Edge 6 — malformed chosenSlot → treated as absent, lead still created, no fields.
    test('malformed chosenSlot (bad HH:MM) → treated as absent, lead created with NULL slot cols', async () => {
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', {
                ...baseArgs,
                chosenSlot: { date: '2026-07-08', start: '10am', end: '1pm' },
                lat: 42.35, lng: -71.06,
            }));
        expect(resultOf(res)).toEqual({ success: true, leadId: 'lead-slot-1' });
        const body = leadsService.createLead.mock.calls[0][0];
        expect(body).not.toHaveProperty('LeadDateTime');
        expect(body).not.toHaveProperty('LeadEndDateTime');
        expect(body).not.toHaveProperty('Latitude');
        expect(body).not.toHaveProperty('Longitude');
        expect(slotEngineService.tzCombine).not.toHaveBeenCalled();
    });

    // Edge 6 — chosenSlot missing a field → treated as absent.
    test('chosenSlot missing end → treated as absent', async () => {
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('createLead', {
                ...baseArgs,
                chosenSlot: { date: '2026-07-08', start: '10:00' },
            }));
        const body = leadsService.createLead.mock.calls[0][0];
        expect(body).not.toHaveProperty('LeadDateTime');
        expect(slotEngineService.tzCombine).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Group 7 — Parallel tool calls
// ════════════════════════════════════════════════════════════════════════════

describe('Group 7 — parallel tool calls', () => {
    const auth = (r) => r.set('x-vapi-secret', SECRET);

    // TC-LQV2-030
    test('multiple tool calls in one request → all processed in order', async () => {
        territoryService.isZipInTerritory
            .mockResolvedValueOnce({
                inside: true, area: 'Boston', city: 'Boston', state: 'MA', zip: '02101', mode: 'list',
            })
            .mockResolvedValueOnce({
                inside: false, area: '', city: '', state: '', zip: '03801', mode: 'list',
            });
        const res = await auth(request(app).post('/api/vapi-tools')).send({
            message: {
                type: 'tool-calls',
                toolCallList: [
                    { id: 'tc1', function: { name: 'checkServiceArea', arguments: '{"zip":"02101"}' } },
                    { id: 'tc2', function: { name: 'checkServiceArea', arguments: '{"zip":"03801"}' } },
                ],
            },
        });
        expect(res.body.results).toHaveLength(2);
        expect(res.body.results[0].toolCallId).toBe('tc1');
        expect(res.body.results[1].toolCallId).toBe('tc2');
        expect(JSON.parse(res.body.results[0].result).inServiceArea).toBe(true);
        expect(JSON.parse(res.body.results[1].result).inServiceArea).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Group 9 — Server mount (public, no auth middleware)
// ════════════════════════════════════════════════════════════════════════════

describe('Group 9 — public mount', () => {
    // TC-LQV2-033
    test('route works without Authorization header (only x-vapi-secret)', async () => {
        territoryService.isZipInTerritory.mockResolvedValue({
            inside: true, area: 'Boston', city: 'Boston', state: 'MA', zip: '02101', mode: 'list',
        });
        const res = await request(app)
            .post('/api/vapi-tools')
            .set('x-vapi-secret', SECRET)
            // deliberately NO Authorization header
            .send(toolCall('checkServiceArea', { zip: '02101' }));
        expect(res.status).toBe(200);
        expect(resultOf(res).inServiceArea).toBe(true);
    });

    // TC-LQV2-033 (source-level): server.js mounts /api/vapi-tools WITHOUT auth middleware
    test('server.js mounts /api/vapi-tools without authenticate/requireCompanyAccess', () => {
        const fs = require('fs');
        const path = require('path');
        const serverSrc = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');
        // Must mount the router directly, with no auth middleware between path and router.
        expect(serverSrc).toMatch(/app\.use\(\s*['"]\/api\/vapi-tools['"]\s*,\s*vapiToolsRouter\s*\)/);
        expect(serverSrc).not.toMatch(/\/api\/vapi-tools['"]\s*,\s*authenticate/);
    });
});
