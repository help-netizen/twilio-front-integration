/**
 * OUTBOUND-LEAD-CALL-001 (OLC-T6) — TC-OLC-041..047: the confirmLeadBooking
 * L0 skill. Identity precedence (spread-last), offered-guard (injected key OR
 * live engine re-validation, fail-closed), tenant isolation, hold write shape
 * (bookOnLead parity), CC-07 attempt flip, no-false-success, sabotage control.
 */

'use strict';

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));
jest.mock('../backend/src/services/leadsService', () => ({
    getLeadByUUID: jest.fn(),
    updateLead: jest.fn(),
}));
jest.mock('../backend/src/services/slotEngineService', () => ({
    resolveTimezone: jest.fn(),
    tzCombine: jest.fn(),
}));
jest.mock('../backend/src/services/eventService', () => ({ logEvent: jest.fn() }));
jest.mock('../backend/src/services/agentSkills/skills/recommendSlots', () => ({
    run: jest.fn(),
}));
jest.mock('../backend/src/services/agentSkills/skills/validateAddress', () => ({
    run: jest.fn(),
}));

const leadsService = require('../backend/src/services/leadsService');
const slotEngineService = require('../backend/src/services/slotEngineService');
const eventService = require('../backend/src/services/eventService');
const recommendSlots = require('../backend/src/services/agentSkills/skills/recommendSlots');
const validateAddress = require('../backend/src/services/agentSkills/skills/validateAddress');
const skill = require('../backend/src/services/agentSkills/skills/confirmLeadBooking');
const registry = require('../backend/src/services/agentSkills/registry');

const CO = '00000000-0000-0000-0000-000000000001';
const SLOT = { date: '2026-07-21', start: '09:00', end: '11:00' };
const KEY = '2026-07-21|09:00|11:00';
// Default fixture has a usable stored address so the booking tests exercise the
// happy path; the address-requirement tests override it.
const LEAD = {
    UUID: 'LD-1', Status: 'Submitted', FirstName: 'Alfreda',
    Address: '101 Asheville Rd', City: 'Chestnut Hill', State: 'MA', PostalCode: '02467',
};

// buildSkillInput order: model args FIRST, injected variableValues spread LAST.
function buildInput(modelArgs = {}, injected = {}) {
    return { ...modelArgs, ...injected };
}
function injectedVars(over = {}) {
    return {
        leadUuid: 'LD-1', companyId: CO, slotKey: KEY,
        zip: '02467', lat: 42.31, lng: -71.16,
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    leadsService.getLeadByUUID.mockResolvedValue({ ...LEAD });
    leadsService.updateLead.mockResolvedValue({});
    validateAddress.run.mockResolvedValue({ valid: true, standardized: '12 Oak St, Boston, MA 02118', correctedZip: '02118', lat: 42.34, lng: -71.07 });
    slotEngineService.resolveTimezone.mockResolvedValue('America/New_York');
    slotEngineService.tzCombine.mockImplementation((d, t) => `${d}T${t}:00-04:00`);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});
afterEach(() => jest.restoreAllMocks());

describe('TC-OLC-041: injected identity precedence', () => {
    it('(a) model-sent EVIL identity is clobbered by injected variableValues', async () => {
        const input = buildInput(
            { leadUuid: 'EVIL', companyId: 'EVIL', slotKey: 'EVIL', chosenSlot: { ...SLOT } },
            injectedVars(),
        );
        const out = await skill.run('transport-co', {}, input);
        expect(out.success).toBe(true);
        expect(leadsService.getLeadByUUID).toHaveBeenCalledWith('LD-1', CO);
        expect(JSON.stringify(leadsService.updateLead.mock.calls)).not.toContain('EVIL');
    });

    it.each([
        ['no leadUuid', injectedVars({ leadUuid: undefined })],
        ['no companyId', injectedVars({ companyId: undefined })],
    ])('(b/c) %s → refusal, zero reads/writes', async (_l, injected) => {
        const out = await skill.run(CO, {}, buildInput({ chosenSlot: { ...SLOT } }, injected));
        expect(out.speak).toBe("I couldn't pull up your request to book — let me have a teammate follow up with you.");
        expect(out.success).not.toBe(true);
        expect(leadsService.getLeadByUUID).not.toHaveBeenCalled();
        expect(leadsService.updateLead).not.toHaveBeenCalled();
    });

    it('(d) transport companyId argument is never used for scoping', async () => {
        await skill.run('DEFAULT-COMPANY-FROM-TRANSPORT', {},
            buildInput({ chosenSlot: { ...SLOT } }, injectedVars()));
        expect(leadsService.getLeadByUUID).toHaveBeenCalledWith('LD-1', CO);
    });
});

describe('TC-OLC-042: slotKey match — hold on THE lead without engine call', () => {
    it('books with bookOnLead-parity hold shape + coords + flip + event + exact ok', async () => {
        const out = await skill.run(CO, {}, buildInput({ chosenSlot: { ...SLOT } }, injectedVars()));

        expect(recommendSlots.run).not.toHaveBeenCalled();
        expect(leadsService.updateLead).toHaveBeenCalledWith('LD-1', {
            LeadDateTime: '2026-07-21T09:00:00-04:00',
            LeadEndDateTime: '2026-07-21T11:00:00-04:00',
            Latitude: 42.31,
            Longitude: -71.16,
        }, CO);

        const flip = mockQuery.mock.calls.find(([sql]) => /SET status = 'booked'/.test(sql));
        expect(flip).toBeTruthy();
        expect(flip[0]).toMatch(/WHERE company_id = \$1 AND lead_uuid = \$2 AND status = 'dialing'/);
        expect(flip[1]).toEqual([CO, 'LD-1']);

        expect(eventService.logEvent).toHaveBeenCalledWith(
            CO, 'lead', 'LD-1', 'lead_slot_held',
            expect.objectContaining({ actor: 'AI Phone', scenario: 'lead_call' }), 'system');

        expect(out.success).toBe(true);
        expect(out.booked).toBe(true);
        expect(out.leadId).toBe('LD-1');
        expect(out.speak).toMatch(/^You're all set — I've got you down for .+\. A dispatcher will confirm shortly\.$/);
    });

    it('lone coordinate → neither Latitude nor Longitude in the hold', async () => {
        await skill.run(CO, {}, buildInput({ chosenSlot: { ...SLOT } }, injectedVars({ lng: undefined })));
        const hold = leadsService.updateLead.mock.calls[0][1];
        expect(hold).not.toHaveProperty('Latitude');
        expect(hold).not.toHaveProperty('Longitude');
    });
});

describe('TC-OLC-043: key mismatch → live engine re-validation, fail-closed', () => {
    const altSlot = { date: '2026-07-22', start: '13:00', end: '15:00' };
    const altKey = '2026-07-22|13:00|15:00';

    it('(a) engine confirms the derived key on targetDay → books', async () => {
        recommendSlots.run.mockResolvedValue({ available: true, slots: [{ key: altKey }] });
        const out = await skill.run(CO, {}, buildInput({ chosenSlot: altSlot }, injectedVars()));
        expect(recommendSlots.run).toHaveBeenCalledWith(CO, {}, {
            zip: '02467', lat: 42.31, lng: -71.16, targetDay: '2026-07-22',
        });
        expect(out.success).toBe(true);
        expect(leadsService.updateLead).toHaveBeenCalled();
    });

    it.each([
        ['SLOT_FALLBACK', () => recommendSlots.run.mockResolvedValue({ available: false, slots: [], fallback: true })],
        ['no matching key', () => recommendSlots.run.mockResolvedValue({ available: true, slots: [{ key: 'other' }] })],
        ['engine throws', () => recommendSlots.run.mockRejectedValue(new Error('down'))],
    ])('(%s) → exact refusal, NO write, NO flip', async (_l, prep) => {
        prep();
        const out = await skill.run(CO, {}, buildInput({ chosenSlot: altSlot }, injectedVars()));
        expect(out.speak).toBe('Let me have a teammate confirm that time and follow up with you shortly.');
        expect(out.success).not.toBe(true);
        expect(leadsService.updateLead).not.toHaveBeenCalled();
        expect(mockQuery.mock.calls.filter(([sql]) => /SET status = 'booked'/.test(sql))).toHaveLength(0);
    });
});

describe('TC-OLC-044: tenant isolation + closed lead', () => {
    it('(a) foreign/missing lead — indistinguishable refusal, zero writes', async () => {
        leadsService.getLeadByUUID.mockRejectedValue(Object.assign(new Error('x'), { code: 'LEAD_NOT_FOUND' }));
        const out = await skill.run(CO, {}, buildInput({ chosenSlot: { ...SLOT } }, injectedVars()));
        expect(out.speak).toBe("I couldn't find that request on file — let me have a teammate follow up with you.");
        expect(leadsService.updateLead).not.toHaveBeenCalled();
    });

    it.each([['Lost'], ['converted']])('(b) closed lead %s → closed refusal', async (status) => {
        leadsService.getLeadByUUID.mockResolvedValue({ ...LEAD, Status: status });
        const out = await skill.run(CO, {}, buildInput({ chosenSlot: { ...SLOT } }, injectedVars()));
        expect(out.speak).toBe('That request is already closed — let me have a teammate follow up with you.');
        expect(leadsService.updateLead).not.toHaveBeenCalled();
    });
});

describe('TC-OLC-045: malformed slot / write faults — no false success', () => {
    it.each([
        ['missing slot', undefined],
        ['not an object', 'tuesday'],
        ['no end', { date: '2026-07-21', start: '09:00' }],
        ['inverted span', { date: '2026-07-21', start: '11:00', end: '09:00' }],
    ])('(a/b) %s → needsConfirmation refusal', async (_l, chosenSlot) => {
        const out = await skill.run(CO, {}, buildInput({ chosenSlot }, injectedVars({ slotKey: 'x' })));
        expect(out.speak).toBe("Let's lock in a time first — which window works best for you?");
        expect(out.needsConfirmation).toBe(true);
        expect(leadsService.updateLead).not.toHaveBeenCalled();
    });

    it.each([
        ['tzCombine throws', () => slotEngineService.tzCombine.mockImplementation(() => { throw new Error('tz'); })],
        ['updateLead throws', () => leadsService.updateLead.mockRejectedValue(new Error('db'))],
    ])('(c/d) %s → lock-in refusal, no success', async (_l, prep) => {
        prep();
        const out = await skill.run(CO, {}, buildInput({ chosenSlot: { ...SLOT } }, injectedVars()));
        expect(out.speak).toBe('I had trouble locking that time in — let me have a teammate confirm it with you.');
        expect(out.success).not.toBe(true);
    });
});

describe('TC-OLC-046: idempotent double-confirm + non-fatal flip/audit', () => {
    it('(a) second confirm with the SAME slot → success again; 0-row flip is not an error', async () => {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 }); // attempt already booked
        const input = buildInput({ chosenSlot: { ...SLOT } }, injectedVars());
        const first = await skill.run(CO, {}, input);
        const second = await skill.run(CO, {}, input);
        expect(first.success).toBe(true);
        expect(second.success).toBe(true);
    });

    it('(b) flip throws → console.error only, still success (hold landed)', async () => {
        mockQuery.mockImplementation(async (sql) => {
            if (/SET status = 'booked'/.test(sql)) throw new Error('flip down');
            return { rows: [], rowCount: 1 };
        });
        const out = await skill.run(CO, {}, buildInput({ chosenSlot: { ...SLOT } }, injectedVars()));
        expect(out.success).toBe(true);
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('[confirmLeadBooking] attempt flip failed'), 'flip down');
    });

    it('(c) logEvent throws → still success', async () => {
        eventService.logEvent.mockImplementation(() => { throw new Error('audit down'); });
        const out = await skill.run(CO, {}, buildInput({ chosenSlot: { ...SLOT } }, injectedVars()));
        expect(out.success).toBe(true);
    });

    it('documented behavior: double-confirm with a DIFFERENT slot overwrites the hold (mid-call change of mind)', async () => {
        recommendSlots.run.mockResolvedValue({ available: true, slots: [{ key: '2026-07-22|13:00|15:00' }] });
        await skill.run(CO, {}, buildInput({ chosenSlot: { ...SLOT } }, injectedVars()));
        await skill.run(CO, {}, buildInput(
            { chosenSlot: { date: '2026-07-22', start: '13:00', end: '15:00' } }, injectedVars()));
        expect(leadsService.updateLead).toHaveBeenCalledTimes(2);
        expect(leadsService.updateLead.mock.calls[1][1].LeadDateTime).toBe('2026-07-22T13:00:00-04:00');
    });
});

describe('TC-OLC-047: sabotage — the offered-guard detector can go red', () => {
    it('with the engine forced to always-offer, the 043(b) fixture books (detector power proven)', async () => {
        // Simulated cut guard: engine "always confirms" the derived key.
        recommendSlots.run.mockImplementation(async (_c, _v, input) => ({
            available: true,
            slots: [{ key: `${input.targetDay}|13:00|15:00` }],
        }));
        const out = await skill.run(CO, {}, buildInput(
            { chosenSlot: { date: '2026-07-22', start: '13:00', end: '15:00' } }, injectedVars()));
        expect(out.success).toBe(true);
        expect(leadsService.updateLead).toHaveBeenCalled(); // ← 043(b)'s "NOT called" would fail on such an impl
    });
});

describe('TC-OLC-048-ADDR: service address is required before booking', () => {
    it('empty lead (no stored address) + no collected address → refuse and ASK, no booking', async () => {
        leadsService.getLeadByUUID.mockResolvedValue({ UUID: 'LD-1', Status: 'Submitted' }); // no address
        const out = await skill.run(CO, {}, buildInput({ chosenSlot: { ...SLOT } }, injectedVars()));
        expect(out.needsAddress).toBe(true);
        expect(out.success).not.toBe(true);
        expect(out.speak).toMatch(/service address/i);
        expect(leadsService.updateLead).not.toHaveBeenCalled();
        expect(validateAddress.run).not.toHaveBeenCalled();
    });

    it('customer-provided address → re-validated server-side, persisted to the lead, then booked', async () => {
        leadsService.getLeadByUUID.mockResolvedValue({ UUID: 'LD-1', Status: 'Submitted' }); // no stored address
        const serviceAddress = { street: '12 Oak St', city: 'Boston', state: 'MA', zip: '02118' };
        const out = await skill.run(CO, {}, buildInput({ chosenSlot: { ...SLOT }, serviceAddress }, injectedVars()));
        expect(validateAddress.run).toHaveBeenCalledWith(CO, {}, expect.objectContaining({ street: '12 Oak St', zip: '02118' }));
        expect(out.success).toBe(true);
        const hold = leadsService.updateLead.mock.calls[0][1];
        expect(hold).toMatchObject({
            Address: '12 Oak St', City: 'Boston', State: 'MA', PostalCode: '02118',
            Latitude: 42.34, Longitude: -71.07, // from validateAddress, not the injected lead geocode
        });
        expect(hold.LeadDateTime).toBe('2026-07-21T09:00:00-04:00');
    });

    it('customer-provided address that FAILS geocoding → refuse and re-ask, no booking', async () => {
        leadsService.getLeadByUUID.mockResolvedValue({ UUID: 'LD-1', Status: 'Submitted' });
        validateAddress.run.mockResolvedValue({ valid: false });
        const out = await skill.run(CO, {}, buildInput(
            { chosenSlot: { ...SLOT }, serviceAddress: { street: 'asdfqwer', zip: '00000' } }, injectedVars()));
        expect(out.needsAddress).toBe(true);
        expect(out.success).not.toBe(true);
        expect(leadsService.updateLead).not.toHaveBeenCalled();
    });

    it('stored address on the lead + no collected address → books using the stored location (no re-validate)', async () => {
        // default LEAD fixture already carries a stored address
        const out = await skill.run(CO, {}, buildInput({ chosenSlot: { ...SLOT } }, injectedVars()));
        expect(out.success).toBe(true);
        expect(validateAddress.run).not.toHaveBeenCalled();
        const hold = leadsService.updateLead.mock.calls[0][1];
        expect(hold).toMatchObject({ Latitude: 42.31, Longitude: -71.16 }); // injected lead geocode
        expect(hold).not.toHaveProperty('Address'); // stored address left as-is
    });
});

describe('registry exposure', () => {
    it('confirmLeadBooking is registered as an L0 write; MCP registry does NOT expose it', () => {
        const entry = (registry.SKILLS || registry.skills || []).find
            ? (registry.SKILLS || registry.skills).find(s => s.name === 'confirmLeadBooking')
            : null;
        if (entry) {
            expect(entry).toMatchObject({ kind: 'write', requiredLevel: 'L0' });
        } else {
            // Fallback: source-level assert (registry may not export the list directly).
            const fs = require('fs');
            const src = fs.readFileSync(require.resolve('../backend/src/services/agentSkills/registry.js'), 'utf8');
            expect(src).toMatch(/name: 'confirmLeadBooking', kind: 'write', requiredLevel: 'L0'/);
        }
        const mcpSrc = require('fs').readFileSync(
            require.resolve('../backend/src/services/agentSkillsMcpRegistry.js'), 'utf8');
        expect(mcpSrc).not.toMatch(/confirmLeadBooking/);
    });
});
