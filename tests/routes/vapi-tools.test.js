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

jest.mock('../../backend/src/db/serviceTerritoryQueries', () => ({
    search: jest.fn(),
}));
jest.mock('../../backend/src/services/leadsService', () => ({
    createLead: jest.fn(),
    getLeadByPhone: jest.fn(),
}));
jest.mock('../../backend/src/services/scheduleService', () => ({
    getAvailableSlots: jest.fn(),
}));
jest.mock('../../backend/src/services/jobsService', () => ({
    listJobs: jest.fn(),
}));
jest.mock('https', () => ({ get: jest.fn() }));

const https = require('https');
const stQueries = require('../../backend/src/db/serviceTerritoryQueries');
const leadsService = require('../../backend/src/services/leadsService');
const scheduleService = require('../../backend/src/services/scheduleService');
const jobsService = require('../../backend/src/services/jobsService');
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

    // TC-LQV2-004
    test('no VAPI_TOOLS_SECRET in env → dev mode, request passes', async () => {
        delete process.env.VAPI_TOOLS_SECRET;
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const res = await request(app)
            .post('/api/vapi-tools')
            .send({ message: { type: 'status-update' } });
        expect(res.status).toBe(200);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
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

    // TC-LQV2-006
    test('unknown tool name → error in result', async () => {
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('unknownTool', {}));
        expect(res.status).toBe(200);
        expect(resultOf(res)).toEqual({ error: 'Unknown tool: unknownTool' });
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
        stQueries.search.mockResolvedValue({ zip: '02101', area: 'Boston', city: 'Boston', state: 'MA' });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('checkServiceArea', { zip: '02101' }));
        expect(resultOf(res)).toEqual({
            inServiceArea: true, area: 'Boston', city: 'Boston', state: 'MA', zip: '02101',
        });
    });

    // TC-LQV2-009
    test('zip outside service area → inServiceArea false', async () => {
        stQueries.search.mockResolvedValue(null);
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('checkServiceArea', { zip: '03801' }));
        expect(resultOf(res)).toEqual({ inServiceArea: false });
    });

    // TC-LQV2-010
    test('zip not provided → inServiceArea false + error, no DB call', async () => {
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('checkServiceArea', {}));
        expect(resultOf(res)).toEqual({ inServiceArea: false, error: 'zip is required' });
        expect(stQueries.search).not.toHaveBeenCalled();
    });

    // TC-LQV2-011
    test('DB error → error in result, HTTP still 200', async () => {
        stQueries.search.mockRejectedValue(new Error('DB connection failed'));
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('checkServiceArea', { zip: '02101' }));
        expect(res.status).toBe(200);
        expect(resultOf(res)).toEqual({ error: 'DB connection failed' });
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
// Group 7 — Parallel tool calls
// ════════════════════════════════════════════════════════════════════════════

describe('Group 7 — parallel tool calls', () => {
    const auth = (r) => r.set('x-vapi-secret', SECRET);

    // TC-LQV2-030
    test('multiple tool calls in one request → all processed in order', async () => {
        stQueries.search
            .mockResolvedValueOnce({ zip: '02101', area: 'Boston', city: 'Boston', state: 'MA' })
            .mockResolvedValueOnce(null);
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
        stQueries.search.mockResolvedValue({ zip: '02101', area: 'Boston', city: 'Boston', state: 'MA' });
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

// ════════════════════════════════════════════════════════════════════════════
// Group 10 — identifyCaller (v3 P1)
// ════════════════════════════════════════════════════════════════════════════

describe('Group 10 — identifyCaller', () => {
    const auth = (r) => r.set('x-vapi-secret', SECRET);

    test('no match → matchType new (does not push existing customer into a profile)', async () => {
        leadsService.getLeadByPhone.mockResolvedValue(null);
        jobsService.listJobs.mockResolvedValue({ results: [] });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('identifyCaller', {}));
        expect(resultOf(res)).toEqual({ matchType: 'new' });
    });

    test('lead match → existing with name, uses call metadata phone', async () => {
        leadsService.getLeadByPhone.mockResolvedValue({ first_name: 'John', last_name: 'Smith', contact_id: 'c1' });
        jobsService.listJobs.mockResolvedValue({ results: [] });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('identifyCaller', {}));
        const out = resultOf(res);
        expect(out.matchType).toBe('existing');
        expect(out.customerName).toBe('John Smith');
        expect(out.firstName).toBe('John');
        expect(out.verified).toBe(false);
        // phone came from call.customer.number in the toolCall() helper
        expect(leadsService.getLeadByPhone).toHaveBeenCalledWith('+16175551234', expect.any(String));
    });

    test('open jobs → nearest upcoming appointment with friendly status phrase', async () => {
        leadsService.getLeadByPhone.mockResolvedValue(null);
        jobsService.listJobs.mockResolvedValue({ results: [
            { customer_name: 'Jane Doe', service_name: 'Dryer Repair', blanc_status: 'Scheduled', start_date: '2026-06-20T14:00:00.000Z' },
            { customer_name: 'Jane Doe', service_name: 'Fridge Repair', blanc_status: 'Enroute', start_date: '2026-06-15T10:00:00.000Z' },
        ] });
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('identifyCaller', {}));
        const out = resultOf(res);
        expect(out.matchType).toBe('existing');
        expect(out.customerName).toBe('Jane Doe');
        expect(out.openJobsCount).toBe(2);
        // nearest by date is the Enroute fridge job
        expect(out.nextAppointment.statusLabel).toBe('your technician is on the way');
        expect(out.nextAppointment.service).toBe('Fridge Repair');
        // internal code never leaked
        expect(JSON.stringify(out)).not.toMatch(/Enroute|blanc_status/);
    });

    test('lookups throw → degrades to a safe result, never 500', async () => {
        leadsService.getLeadByPhone.mockRejectedValue(new Error('db down'));
        jobsService.listJobs.mockRejectedValue(new Error('db down'));
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('identifyCaller', {}));
        expect(res.status).toBe(200);
        expect(resultOf(res)).toEqual({ matchType: 'new' });
        errSpy.mockRestore();
    });

    test('explicit phone arg overrides call metadata', async () => {
        leadsService.getLeadByPhone.mockResolvedValue(null);
        jobsService.listJobs.mockResolvedValue({ results: [] });
        await auth(request(app).post('/api/vapi-tools'))
            .send(toolCall('identifyCaller', { phone: '+15085140320' }));
        expect(leadsService.getLeadByPhone).toHaveBeenCalledWith('+15085140320', expect.any(String));
    });
});
