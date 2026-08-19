'use strict';

const guard = require('../backend/src/services/inboundSlotBookingGuardService');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const PROVIDER_CALL = 'vapi-call-guard-1';
const SLOT = {
    key: '2026-08-21|10:00|12:00',
    date: '2026-08-21',
    start: '10:00',
    end: '12:00',
};

function input(chosenSlot = SLOT) {
    return {
        chosenSlot,
        [guard.TRANSPORT_FIELD]: {
            required: true,
            providerCallId: PROVIDER_CALL,
        },
    };
}

function auditRows(invocations) {
    return jest.fn(async (sql, params) => {
        expect(String(sql)).toContain('WHERE company_id = $1 AND provider_call_id = $2');
        expect(params).toEqual([COMPANY, PROVIDER_CALL]);
        return { rows: [{ invocations }] };
    });
}

function offeredInvocation(overrides = {}) {
    return {
        tool_call_id: 'recommend-1',
        arguments: { zip: '01721', targetDay: '2026-08-21', excludeSlots: ['old'] },
        result: { available: true, slots: [SLOT] },
        ...overrides,
    };
}

test('non-Vapi callers keep their existing booking path', async () => {
    const query = jest.fn();
    const result = await guard.validateChosenSlot(COMPANY, { chosenSlot: SLOT }, { query });
    expect(result).toEqual({ required: false, allowed: true });
    expect(query).not.toHaveBeenCalled();
});

test('a slot absent from the exact audited tool result fails closed before an engine call', async () => {
    const recommendSlots = { run: jest.fn() };
    const result = await guard.validateChosenSlot(COMPANY, input(), {
        query: auditRows([offeredInvocation({
            result: {
                available: true,
                slots: [{ ...SLOT, key: '2026-08-21|13:00|15:00', start: '13:00', end: '15:00' }],
            },
        })]),
        recommendSlots,
    });
    expect(result).toEqual({ required: true, allowed: false });
    expect(recommendSlots.run).not.toHaveBeenCalled();
});

test('an exactly offered slot must also be returned by a fresh tenant-scoped day run', async () => {
    const recommendSlots = {
        run: jest.fn(async () => ({
            available: true,
            slots: [{ ...SLOT, key: '2026-08-21|13:00|15:00', start: '13:00', end: '15:00' }],
        })),
    };
    const result = await guard.validateChosenSlot(COMPANY, input(), {
        query: auditRows([offeredInvocation()]),
        recommendSlots,
    });
    expect(result).toEqual({ required: true, allowed: false });
    expect(recommendSlots.run).toHaveBeenCalledWith(COMPANY, {}, {
        zip: '01721',
        targetDay: '2026-08-21',
    });
});

test('exact prior offer plus exact fresh engine return passes', async () => {
    const recommendSlots = {
        run: jest.fn(async () => ({ available: true, slots: [SLOT] })),
    };
    const result = await guard.validateChosenSlot(COMPANY, input(), {
        query: auditRows([offeredInvocation()]),
        recommendSlots,
    });
    expect(result).toEqual({ required: true, allowed: true });
});

test.each([
    { available: false, slots: [], fallback: true },
    { available: false, slots: [], fallback: false, reason: 'out_of_area' },
])('fresh fallback/coverage result fails closed: %j', async (fresh) => {
    const result = await guard.validateChosenSlot(COMPANY, input(), {
        query: auditRows([offeredInvocation()]),
        recommendSlots: { run: jest.fn(async () => fresh) },
    });
    expect(result).toEqual({ required: true, allowed: false });
});

test('audit read failure is operationally logged and fails closed', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await guard.validateChosenSlot(COMPANY, input(), {
        query: jest.fn(async () => { throw new Error('db unavailable'); }),
    });
    expect(result).toEqual({ required: true, allowed: false });
    expect(error).toHaveBeenCalledWith(
        '[inboundSlotBookingGuard] re-validation unavailable',
        expect.objectContaining({ companyId: COMPANY, providerCallId: PROVIDER_CALL }),
    );
    error.mockRestore();
});
