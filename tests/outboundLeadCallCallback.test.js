/**
 * OUTBOUND-CALL-CANCEL-001 — one company/phone cancellation transaction for
 * lead_call + parts_visit, with declarative scenario side effects.
 */

'use strict';

const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockGetClient = jest.fn(async () => ({ query: mockClientQuery, release: mockRelease }));
const mockPoolQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({
    query: mockPoolQuery,
    getClient: mockGetClient,
}));
jest.mock('../backend/src/services/eventService', () => ({ logEvent: jest.fn() }));
jest.mock('../backend/src/services/zenbookerClient', () => ({ addJobNote: jest.fn() }));

const eventService = require('../backend/src/services/eventService');
const zenbookerClient = require('../backend/src/services/zenbookerClient');
const service = require('../backend/src/services/outboundCallCancellationService');

const CO = '00000000-0000-0000-0000-000000000001';
const OTHER_CO = '00000000-0000-0000-0000-000000000002';
const PHONE = '+16175551234';
const AT = '2026-07-18T12:00:00.000Z';
const ACTIONS = [
    { type: 'robot_call', label: '🤖 Let the robot call' },
    { type: 'manual_call', label: "📞 I'll call myself" },
];

const leadRow = (over = {}) => ({
    id: 11,
    company_id: CO,
    scenario: 'lead_call',
    job_id: null,
    lead_uuid: 'LD-1',
    task_id: null,
    contact_id: 501,
    phone: PHONE,
    attempt_no: 1,
    status: 'pending',
    slot_json: null,
    ...over,
});

const partsRow = (over = {}) => ({
    id: 21,
    company_id: CO,
    scenario: 'parts_visit',
    job_id: 5,
    lead_uuid: null,
    task_id: 7,
    contact_id: 501,
    phone: PHONE,
    attempt_no: 1,
    status: 'pending',
    slot_json: null,
    ...over,
});

let state;

function arrange({
    activeRows = [leadRow()],
    noteErrorTarget = null,
    noteTargetExists = true,
    markerInserted = true,
    zenbookerJobId = null,
} = {}) {
    state = {
        activeRows,
        noteErrorTarget,
        noteTargetExists,
        markerInserted,
        markerCalls: 0,
        zenbookerJobId,
    };
    mockClientQuery.mockImplementation(async (sql) => {
        const text = String(sql);
        if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [], rowCount: 0 };
        if (/FROM outbound_call_attempts/.test(text) && /FOR UPDATE/.test(text)) {
            return { rows: state.activeRows };
        }
        if (/UPDATE outbound_call_attempts/.test(text) && /scenario = 'lead_call'/.test(text)) {
            const rows = state.activeRows
                .filter((row) => row.scenario === 'lead_call' && ['pending', 'dialing'].includes(row.status))
                .map((row) => ({ id: row.id, lead_uuid: row.lead_uuid }));
            return { rows, rowCount: rows.length };
        }
        if (/UPDATE outbound_call_attempts/.test(text) && /scenario = 'parts_visit'/.test(text)) {
            const rows = state.activeRows
                .filter((row) => row.scenario === 'parts_visit' && row.status === 'pending')
                .map((row) => ({ id: row.id }));
            return { rows, rowCount: rows.length };
        }
        if (/INSERT INTO outbound_call_attempts/.test(text)) {
            state.markerCalls += 1;
            const inserted = typeof state.markerInserted === 'function'
                ? state.markerInserted(state.markerCalls)
                : state.markerInserted;
            return inserted ? { rows: [{ id: 22 }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/UPDATE leads/.test(text)) {
            if (state.noteErrorTarget === 'lead_call') throw new Error('lead note failed');
            const rows = state.noteTargetExists
                ? [...new Set(state.activeRows.filter((row) => row.lead_uuid).map((row) => row.lead_uuid))]
                    .map((uuid) => ({ uuid }))
                : [];
            return { rows, rowCount: rows.length };
        }
        if (/UPDATE jobs/.test(text)) {
            if (state.noteErrorTarget === 'parts_visit') throw new Error('job note failed');
            return state.noteTargetExists
                ? { rows: [{ id: 5, zenbooker_job_id: state.zenbookerJobId }], rowCount: 1 }
                : { rows: [], rowCount: 0 };
        }
        if (/SELECT actions FROM tasks/.test(text)) {
            return { rows: [{ actions: ACTIONS }], rowCount: 1 };
        }
        if (/SELECT id FROM tasks/.test(text)) return { rows: [{ id: 7 }], rowCount: 1 };
        if (/UPDATE tasks SET actions/.test(text)) return { rows: [{ id: 7 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
    });
}

function findClientCall(pattern) {
    return mockClientQuery.mock.calls.find(([sql]) => pattern.test(String(sql)));
}

function clientCalls(pattern) {
    return mockClientQuery.mock.calls.filter(([sql]) => pattern.test(String(sql)));
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetClient.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    zenbookerClient.addJobNote.mockResolvedValue({});
    arrange();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

const MATRIX = [
    {
        scenario: 'lead_call',
        row: leadRow,
        cause: service.CAUSES.DISPATCHER_CALL,
        note: 'Scheduled automated calls canceled — customer answered a dispatcher call.',
    },
    {
        scenario: 'lead_call',
        row: leadRow,
        cause: service.CAUSES.INBOUND_CALL,
        note: 'Scheduled automated calls canceled — customer called in.',
    },
    {
        scenario: 'lead_call',
        row: leadRow,
        cause: service.CAUSES.INBOUND_SMS,
        note: 'Scheduled automated calls canceled — customer replied by SMS.',
    },
    {
        scenario: 'parts_visit',
        row: partsRow,
        cause: service.CAUSES.DISPATCHER_CALL,
        note: `AI: robot call canceled — customer was already reached by phone (outbound call completed at ${AT}).`,
        stamp: 'Canceled — customer was already reached by phone.',
    },
    {
        scenario: 'parts_visit',
        row: partsRow,
        cause: service.CAUSES.INBOUND_CALL,
        note: `AI: robot call canceled — customer was already reached by phone (inbound call completed at ${AT}).`,
        stamp: 'Canceled — customer was already reached by phone.',
    },
    {
        scenario: 'parts_visit',
        row: partsRow,
        cause: service.CAUSES.INBOUND_SMS,
        note: 'AI: robot call canceled — customer replied by SMS.',
        stamp: 'Canceled — customer replied by SMS.',
    },
];

describe('scenario × customer-contact-cause matrix', () => {
    test.each(MATRIX)('$scenario × $cause', async ({ scenario, row, cause, note, stamp }) => {
        arrange({ activeRows: [row()] });

        await expect(service.cancel({
            companyId: CO,
            rawPhone: '(617) 555-1234',
            cause,
            contactAt: AT,
        })).resolves.toEqual({ canceled: 1, marker: false });

        const active = findClientCall(/FROM outbound_call_attempts[\s\S]*FOR UPDATE/);
        expect(active[0]).toMatch(/WHERE company_id = \$1/);
        expect(active[0]).toMatch(/regexp_replace\(COALESCE\(phone, ''\), '\\D', '', 'g'\) = \$2/);
        expect(active[0]).toMatch(/length\(\$2\) = 11 AND left\(\$2, 1\) = '1'/);
        expect(active[0]).toMatch(/right\(regexp_replace[\s\S]*= right\(\$2, 10\)/);
        expect(active[0]).toMatch(/status IN \('pending', 'dialing'\)/);
        expect(active[0]).not.toMatch(/AND scenario =/);
        expect(active[1]).toEqual([CO, '16175551234']);

        const attemptWrite = findClientCall(/UPDATE outbound_call_attempts/);
        expect(attemptWrite[0]).toMatch(/company_id = \$1/);
        expect(attemptWrite[1]).toContain(cause);

        if (scenario === 'lead_call') {
            const noteWrite = findClientCall(/UPDATE leads/);
            expect(noteWrite[0]).toMatch(/SET structured_notes/);
            expect(noteWrite[0]).toMatch(/'created_by', 'system'/);
            expect(noteWrite[1]).toEqual([CO, ['LD-1'], note]);
            expect(findClientCall(/UPDATE jobs/)).toBeUndefined();
            expect(findClientCall(/UPDATE tasks SET actions/)).toBeUndefined();
            expect(eventService.logEvent).toHaveBeenCalledWith(
                CO, 'lead', 'LD-1', 'outbound_lead_call_canceled', { reason: cause }, 'system',
            );
        } else {
            const noteWrite = findClientCall(/UPDATE jobs/);
            expect(noteWrite[0]).toMatch(/WHERE company_id = \$1 AND id = \$2/);
            expect(noteWrite[0]).toMatch(/'created_by', 'system'/);
            expect(noteWrite[1][0]).toBe(CO);
            expect(noteWrite[1][1]).toBe(5);
            expect(noteWrite[1][3]).toBe(note);

            const stampWrite = findClientCall(/UPDATE tasks SET actions/);
            const robot = JSON.parse(stampWrite[1][2]).find((action) => action.type === 'robot_call');
            expect(robot).toMatchObject({ state: 'canceled', reason: stamp });
            expect(JSON.parse(stampWrite[1][2]).find((action) => action.type === 'manual_call'))
                .toEqual({ type: 'manual_call', label: "📞 I'll call myself" });
            expect(eventService.logEvent).toHaveBeenCalledWith(
                CO,
                'job',
                5,
                'outbound_call_canceled',
                { canceled: 1, marker: false, kind: 'customer_contact', reason: cause },
                'system',
            );
        }
        expect(mockClientQuery.mock.calls[0][0]).toBe('BEGIN');
        expect(mockClientQuery.mock.calls.at(-1)[0]).toBe('COMMIT');
        expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    test('one phone with lead_call + parts_visit active → both scenarios commit and note together', async () => {
        arrange({ activeRows: [leadRow(), partsRow()] });

        const out = await service.cancel({
            companyId: CO,
            rawPhone: PHONE,
            cause: service.CAUSES.INBOUND_SMS,
            contactAt: AT,
        });

        expect(out).toEqual({ canceled: 2, marker: false });
        expect(clientCalls(/UPDATE leads/)).toHaveLength(1);
        expect(clientCalls(/UPDATE jobs/)).toHaveLength(1);
        expect(clientCalls(/UPDATE tasks SET actions/)).toHaveLength(1);
        expect(eventService.logEvent).toHaveBeenCalledTimes(2);
        expect(mockClientQuery.mock.calls.at(-1)[0]).toBe('COMMIT');
    });
});

describe('parts_visit declared side effects', () => {
    test('dialing row stays in-flight; unified-reason marker + suffix note + task stamp are atomic', async () => {
        arrange({ activeRows: [partsRow({ id: 31, attempt_no: 2, status: 'dialing' })] });

        const out = await service.cancel({
            companyId: CO,
            rawPhone: PHONE,
            cause: service.CAUSES.INBOUND_SMS,
            contactAt: AT,
        });

        expect(out).toEqual({ canceled: 0, marker: true });
        expect(findClientCall(/UPDATE outbound_call_attempts/)).toBeUndefined();
        const marker = findClientCall(/INSERT INTO outbound_call_attempts/);
        expect(marker[0]).toMatch(/scenario\)/);
        expect(marker[0]).toMatch(/NOT EXISTS/);
        expect(marker[1]).toEqual([
            CO, 5, 7, 501, PHONE, 2, null,
            'customer_replied_by_sms', 'parts_visit', 31,
        ]);
        expect(findClientCall(/UPDATE jobs/)[1][3]).toBe(
            'AI: robot call canceled — customer replied by SMS.'
            + ' A call already in progress will not be retried.',
        );
        const robot = JSON.parse(findClientCall(/UPDATE tasks SET actions/)[1][2])
            .find((action) => action.type === 'robot_call');
        expect(robot.reason).toBe('Canceled — customer replied by SMS.');
    });

    test('repeat contact while the same dialing row already has a newer marker → no second note/stamp/event', async () => {
        arrange({
            activeRows: [partsRow({ id: 31, attempt_no: 2, status: 'dialing' })],
            markerInserted: (callNo) => callNo === 1,
        });

        const first = await service.cancel({ companyId: CO, rawPhone: PHONE, cause: service.CAUSES.INBOUND_SMS });
        const second = await service.cancel({ companyId: CO, rawPhone: PHONE, cause: service.CAUSES.INBOUND_SMS });

        expect(first).toEqual({ canceled: 0, marker: true });
        expect(second).toEqual({ canceled: 0, marker: false });
        expect(clientCalls(/UPDATE jobs/)).toHaveLength(1);
        expect(clientCalls(/UPDATE tasks SET actions/)).toHaveLength(1);
        expect(eventService.logEvent).toHaveBeenCalledTimes(1);
    });

    test('job note still syncs to Zenbooker after the local transaction commits', async () => {
        arrange({ activeRows: [partsRow()], zenbookerJobId: 'ZB-5' });
        zenbookerClient.addJobNote.mockResolvedValue({ id: 'ZBN-9' });

        await service.cancel({ companyId: CO, rawPhone: PHONE, cause: service.CAUSES.INBOUND_CALL, contactAt: AT });

        expect(zenbookerClient.addJobNote).toHaveBeenCalledWith('ZB-5', {
            text: `AI: robot call canceled — customer was already reached by phone (inbound call completed at ${AT}).`,
        });
        const [sql, params] = mockPoolQuery.mock.calls.find(([query]) => /UPDATE jobs j/.test(query));
        expect(sql).toMatch(/j.company_id = \$1 AND j.id = \$2/);
        expect(params[0]).toBe(CO);
        expect(params[1]).toBe(5);
        expect(params[3]).toBe('ZBN-9');
    });
});

describe('transaction, tenant, and declaration invariants', () => {
    test.each(['lead_call', 'parts_visit'])('%s note failure → ROLLBACKs cancellation and emits nothing', async (scenario) => {
        arrange({
            activeRows: [scenario === 'lead_call' ? leadRow() : partsRow()],
            noteErrorTarget: scenario,
        });

        await expect(service.cancel({
            companyId: CO,
            rawPhone: PHONE,
            cause: service.CAUSES.INBOUND_CALL,
            contactAt: AT,
        })).resolves.toEqual({ canceled: 0, marker: false });

        expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
        expect(mockClientQuery).not.toHaveBeenCalledWith('COMMIT');
        expect(eventService.logEvent).not.toHaveBeenCalled();
    });

    test('unknown future scenario → rollback before any attempt can be canceled without a declared note target', async () => {
        arrange({ activeRows: [{ ...partsRow(), scenario: 'future_agent' }] });

        await expect(service.cancel({
            companyId: CO,
            rawPhone: PHONE,
            cause: service.CAUSES.INBOUND_SMS,
        })).resolves.toEqual({ canceled: 0, marker: false });

        expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
        expect(findClientCall(/UPDATE outbound_call_attempts/)).toBeUndefined();
        expect(findClientCall(/UPDATE leads|UPDATE jobs/)).toBeUndefined();
    });

    test('no active rows → no note, task stamp, event, or marker', async () => {
        arrange({ activeRows: [] });
        const out = await service.cancel({ companyId: CO, rawPhone: PHONE, cause: service.CAUSES.INBOUND_SMS });
        expect(out).toEqual({ canceled: 0, marker: false });
        expect(findClientCall(/UPDATE leads|UPDATE jobs|UPDATE tasks|INSERT INTO/)).toBeUndefined();
        expect(eventService.logEvent).not.toHaveBeenCalled();
        expect(mockClientQuery.mock.calls.at(-1)[0]).toBe('COMMIT');
    });

    test('company is authoritative on the global lookup and every scenario side effect', async () => {
        arrange({ activeRows: [leadRow(), partsRow()] });
        await service.cancel({ companyId: CO, rawPhone: PHONE, cause: service.CAUSES.INBOUND_SMS });

        for (const [sql, params] of mockClientQuery.mock.calls) {
            if (!/outbound_call_attempts|UPDATE leads|UPDATE jobs|FROM tasks|UPDATE tasks/.test(String(sql))) continue;
            expect(String(sql)).toMatch(/company_id = \$1/);
            expect(params[0]).toBe(CO);
            expect(params).not.toContain(OTHER_CO);
        }
    });

    test('invalid phone/company/cause → no transaction', async () => {
        await service.cancel({ companyId: CO, rawPhone: '911', cause: service.CAUSES.INBOUND_SMS });
        await service.cancel({ rawPhone: PHONE, cause: service.CAUSES.INBOUND_SMS });
        await service.cancel({ companyId: CO, rawPhone: PHONE, cause: 'unknown' });
        expect(mockGetClient).not.toHaveBeenCalled();
    });

    test('declarative registry exposes only note targets and scenario-specific hooks', () => {
        expect(Object.keys(service.SCENARIO_HANDLERS)).toEqual(['lead_call', 'parts_visit']);
        expect(service.SCENARIO_HANDLERS.lead_call.noteTarget).toBe('leads.structured_notes');
        expect(service.SCENARIO_HANDLERS.parts_visit).toMatchObject({
            noteTarget: 'jobs.notes',
            sideEffects: ['canceled_marker_for_dialing', 'part_arrived_call_task_stamp'],
        });
    });
});

describe('shared completed-human-call trigger and AI/Sara exclusions', () => {
    const call = (over = {}) => ({
        call_sid: 'CA1',
        company_id: CO,
        direction: 'inbound',
        status: 'completed',
        is_final: true,
        parent_call_sid: null,
        duration_sec: 90,
        answered_at: '2026-07-18T11:58:30.000Z',
        ended_at: AT,
        answered_by: 'dana',
        from_number: PHONE,
        to_number: '+16175006181',
        ...over,
    });

    test.each([
        ['inbound', service.CAUSES.INBOUND_CALL, PHONE],
        ['outbound', service.CAUSES.DISPATCHER_CALL, '(617) 555-0199'],
    ])('%s completed human call reaches the global core with the unified cause', async (direction, cause, externalPhone) => {
        mockPoolQuery.mockResolvedValue({ rows: [] });
        arrange({ activeRows: [leadRow({ phone: direction === 'inbound' ? PHONE : externalPhone })] });

        const result = await service.cancelForCompletedCustomerCall(call({
            direction,
            from_number: direction === 'inbound' ? PHONE : '+16175006181',
            to_number: direction === 'outbound' ? externalPhone : '+16175006181',
        }));

        expect(result).toEqual({ canceled: 1, marker: false });
        expect(findClientCall(/UPDATE outbound_call_attempts/)[1]).toContain(cause);
        const cfe = mockPoolQuery.mock.calls.find(([sql]) => /FROM call_flow_executions/.test(sql));
        expect(cfe[0]).toMatch(/WHERE company_id = \$1 AND call_sid = \$2/);
        expect(cfe[1]).toEqual([CO, 'CA1']);
    });

    test.each([
        ['vapi synthetic', { call_sid: 'vapi:abc' }],
        ['answered_by ai', { answered_by: 'ai' }],
    ])('%s → no cancellation lookup', async (_label, over) => {
        await expect(service.cancelForCompletedCustomerCall(call(over)))
            .resolves.toEqual({ canceled: 0, marker: false });
        expect(mockGetClient).not.toHaveBeenCalled();
        expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    test('Sara-attended call → company-scoped discriminator preserves every agent plan', async () => {
        mockPoolQuery.mockResolvedValueOnce({
            rows: [{
                current_node_id: 'n2',
                context_json: '{"graph":{"states":[{"id":"n2","kind":"vapi_agent"}]}}',
            }],
        });

        await expect(service.cancelForCompletedCustomerCall(call()))
            .resolves.toEqual({ canceled: 0, marker: false });
        expect(mockGetClient).not.toHaveBeenCalled();
        expect(mockPoolQuery.mock.calls[0][1]).toEqual([CO, 'CA1']);
    });

    test('Sara forwarded to a human queue → cancellation proceeds', async () => {
        mockPoolQuery.mockResolvedValueOnce({
            rows: [{
                current_node_id: 'n3',
                context_json: '{"graph":{"states":[{"id":"n2","kind":"vapi_agent"},{"id":"n3","kind":"queue"}]}}',
            }],
        });
        arrange({ activeRows: [] });

        await service.cancelForCompletedCustomerCall(call());
        expect(mockGetClient).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['not final', { is_final: false }],
        ['not completed', { status: 'busy' }],
        ['child leg', { parent_call_sid: 'CA0' }],
        ['zero duration', { duration_sec: 0 }],
        ['not answered', { answered_at: null }],
        ['internal', { direction: 'internal' }],
    ])('%s → no cancellation lookup', async (_label, over) => {
        await service.cancelForCompletedCustomerCall(call(over));
        expect(mockGetClient).not.toHaveBeenCalled();
        expect(mockPoolQuery).not.toHaveBeenCalled();
    });
});
