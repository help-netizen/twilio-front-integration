'use strict';

jest.mock('../backend/src/services/leadsService', () => ({
    createLead: jest.fn(async () => ({ UUID: 'guarded-lead' })),
}));
jest.mock('../backend/src/services/slotEngineService', () => ({
    resolveTimezone: jest.fn(async () => 'America/New_York'),
    tzCombine: jest.fn((date, time) => `${date}T${time}:00.000Z`),
}));
jest.mock('../backend/src/services/agentSkills/skills/validateAddress', () => ({
    run: jest.fn(async () => ({ valid: true, correctedZip: '01721', lat: 42.1, lng: -71.2 })),
}));
jest.mock('../backend/src/services/inboundSlotBookingGuardService', () => ({
    TRANSPORT_FIELD: '__vapiInboundBookingGuard',
    validateChosenSlot: jest.fn(),
}));

const leadsService = require('../backend/src/services/leadsService');
const slotGuard = require('../backend/src/services/inboundSlotBookingGuardService');
const createLead = require('../backend/src/services/agentSkills/skills/createLead');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const SLOT = { date: '2026-08-21', start: '10:00', end: '12:00' };

function payload() {
    return {
        phone: '+15085550123',
        street: '1 Main St',
        city: 'Ashland',
        state: 'MA',
        zip: '01721',
        chosenSlot: SLOT,
        __vapiInboundBookingGuard: { required: true, providerCallId: 'call-create-guard' },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    leadsService.createLead.mockResolvedValue({ UUID: 'guarded-lead' });
});

test('inbound non-offered slot creates an unscheduled review lead but returns a non-booked signal', async () => {
    slotGuard.validateChosenSlot.mockResolvedValue({ required: true, allowed: false });

    const result = await createLead.run(COMPANY, {}, payload());

    expect(leadsService.createLead).toHaveBeenCalledTimes(1);
    const body = leadsService.createLead.mock.calls[0][0];
    expect(body).not.toHaveProperty('LeadDateTime');
    expect(body).not.toHaveProperty('LeadEndDateTime');
    expect(result).toMatchObject({
        success: false,
        leadId: 'guarded-lead',
        needsCallback: true,
    });
    expect(result.error).toMatch(/could not be confirmed/i);
});

test('inbound exact offered-and-live slot persists the hold', async () => {
    slotGuard.validateChosenSlot.mockResolvedValue({ required: true, allowed: true });

    const result = await createLead.run(COMPANY, {}, payload());

    expect(result).toEqual({ success: true, leadId: 'guarded-lead' });
    expect(leadsService.createLead.mock.calls[0][0]).toMatchObject({
        LeadDateTime: '2026-08-21T10:00:00.000Z',
        LeadEndDateTime: '2026-08-21T12:00:00.000Z',
    });
});
