/**
 * TENANCY-RBAC-GUARD-001 D5 — copyable T-blast regression for the real
 * outbound phone-keyed cancellation path.
 */

'use strict';

const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockGetClient = jest.fn(async () => ({ query: mockClientQuery, release: mockRelease }));
jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    getClient: mockGetClient,
}));
jest.mock('../backend/src/services/eventService', () => ({ logEvent: jest.fn() }));

const service = require('../backend/src/services/outboundCallCancellationService');

const COMPANY_A = '00000000-0000-0000-0000-000000000001';
const COMPANY_B = '00000000-0000-0000-0000-000000000002';
const SHARED_PHONE = '+16175551234';

const digits = (value) => String(value).replace(/\D/g, '');
const clone = (value) => JSON.parse(JSON.stringify(value));

let state;

function installStatefulDb() {
    state = {
        attempts: [
            {
                id: 11, company_id: COMPANY_A, scenario: 'lead_call', lead_uuid: 'LD-A',
                job_id: null, task_id: null, contact_id: 101, phone: SHARED_PHONE,
                attempt_no: 1, status: 'pending', reason: null, slot_json: null,
            },
            {
                id: 12, company_id: COMPANY_B, scenario: 'lead_call', lead_uuid: 'LD-B',
                job_id: null, task_id: null, contact_id: 202, phone: SHARED_PHONE,
                attempt_no: 1, status: 'pending', reason: null, slot_json: null,
            },
        ],
        leads: [
            { company_id: COMPANY_A, uuid: 'LD-A', structured_notes: [], updated_at: 'before-a' },
            { company_id: COMPANY_B, uuid: 'LD-B', structured_notes: [], updated_at: 'before-b' },
        ],
    };

    mockClientQuery.mockImplementation(async (sql, params = []) => {
        const text = String(sql);
        if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [], rowCount: 0 };

        if (/FROM outbound_call_attempts/.test(text) && /FOR UPDATE/.test(text)) {
            const [companyId, phoneDigits] = params;
            const hasTenantGuard = /WHERE company_id = \$1/.test(text);
            const rows = state.attempts.filter((row) =>
                (!hasTenantGuard || row.company_id === companyId)
                && digits(row.phone) === phoneDigits
                && ['pending', 'dialing'].includes(row.status)
            );
            return { rows: clone(rows), rowCount: rows.length };
        }

        if (/UPDATE outbound_call_attempts/.test(text) && /scenario = 'lead_call'/.test(text)) {
            const [companyId, ids, cause] = params;
            const hasTenantGuard = /WHERE company_id = \$1/.test(text);
            const changed = [];
            for (const row of state.attempts) {
                if ((!hasTenantGuard || row.company_id === companyId)
                    && ids.includes(row.id)
                    && row.scenario === 'lead_call'
                    && ['pending', 'dialing'].includes(row.status)) {
                    row.status = 'canceled';
                    row.reason = cause;
                    changed.push({ id: row.id, lead_uuid: row.lead_uuid });
                }
            }
            return { rows: changed, rowCount: changed.length };
        }

        if (/UPDATE leads/.test(text)) {
            const [companyId, uuids, noteText] = params;
            const hasTenantGuard = /WHERE company_id = \$1/.test(text);
            const changed = [];
            for (const row of state.leads) {
                if ((!hasTenantGuard || row.company_id === companyId) && uuids.includes(row.uuid)) {
                    row.structured_notes.push({ text: noteText, created_by: 'system' });
                    row.updated_at = 'after';
                    changed.push({ uuid: row.uuid });
                }
            }
            return { rows: changed, rowCount: changed.length };
        }

        throw new Error(`Unexpected SQL in T-blast harness: ${text}`);
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetClient.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
    installStatefulDb();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

test('T-blast: cancel by a shared phone in company A leaves company B byte-unchanged', async () => {
    const beforeB = clone({
        attempt: state.attempts.find((row) => row.company_id === COMPANY_B),
        lead: state.leads.find((row) => row.company_id === COMPANY_B),
    });

    await expect(service.cancel({
        companyId: COMPANY_A,
        rawPhone: SHARED_PHONE,
        cause: service.CAUSES.INBOUND_CALL,
    })).resolves.toEqual({ canceled: 1, marker: false });

    expect(state.attempts.find((row) => row.company_id === COMPANY_A)).toMatchObject({
        status: 'canceled',
        reason: service.CAUSES.INBOUND_CALL,
    });
    expect(state.leads.find((row) => row.company_id === COMPANY_A).structured_notes).toHaveLength(1);
    expect({
        attempt: state.attempts.find((row) => row.company_id === COMPANY_B),
        lead: state.leads.find((row) => row.company_id === COMPANY_B),
    }).toStrictEqual(beforeB);

    // Sabotage control: deleting any tenant predicate below makes this test red.
    const tenantQueries = mockClientQuery.mock.calls.filter(([sql]) =>
        /outbound_call_attempts|UPDATE leads/.test(String(sql))
    );
    expect(tenantQueries).toHaveLength(3);
    for (const [sql, params] of tenantQueries) {
        expect(String(sql)).toMatch(/WHERE company_id = \$1/);
        expect(params[0]).toBe(COMPANY_A);
    }
});
