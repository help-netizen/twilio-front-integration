/**
 * agentSkillsBookOnLead.test.js — AGENT-SKILLS-002 T7 (Part B — the new bookOnLead write)
 *
 * Mocked-unit proof of the `bookOnLead` write skill through the real `runSkill`
 * choke-point, with the verification gate + reused services mocked. Proves the
 * update-vs-create core, ownership, malformed-slot refusal, and the L1 gate
 * (spec §3.4 / edge table B / task T3):
 *   - B1/B3/B4  UPDATE the newest open lead's hold (LeadDateTime/LeadEndDateTime
 *               [+coords]); `created:false`; NO duplicate lead ever created while an
 *               open lead exists (updateLead called, createLead NOT called).
 *   - B2        no open lead → delegate to the createLead skill (created:true) —
 *               exactly ONE create, no double-create, updateLead NOT called.
 *   - B5        malformed/absent chosenSlot → soft refusal, NO write of any kind.
 *   - B6        tzCombine throws → refusal, NO write.
 *   - B8        lat/lng one-finite → neither coord written (both-or-nothing).
 *   - B9        defensive ownership re-assert: a lead whose ContactId ≠ the verified
 *               contact → refusal, NO write (the scoped read makes this near-impossible,
 *               but the guard is proven load-bearing here).
 *   - L1 gate   an L1 (phone-identified) caller books; an L0/unresolved caller is
 *               refused by the choke-point and the skill never runs (no write).
 *
 * The gate's `assert` stays REAL (so a genuine L0 context throws exactly as in
 * production → the choke-point's soft needsVerification shape); only `deriveLevel`
 * is mocked to control the level. leadsService/slotEngineService/eventService are
 * mocked so every refusal case can assert "no write happened".
 */

'use strict';

const AGENT = '../backend/src/services/agentSkills';
const CO = '00000000-0000-0000-0000-000000000001';
const CONTACT = 501;

// The gate: default-grant L1 so the happy paths run; override per-test for the L0 block.
// assert() is REAL so a genuine sub-L1 context throws exactly as in production.
jest.mock('../backend/src/services/agentSkills/verificationGate', () => {
    const REAL = jest.requireActual('../backend/src/services/agentSkills/verificationGate');
    return { ...REAL, deriveLevel: jest.fn() };
});
const gate = require('../backend/src/services/agentSkills/verificationGate');

// leadsService: the read (getOpenLeadsByContact) + the two write paths (updateLead for
// the existing-lead branch, createLead for the fallback). All observed so refusals can
// assert "no write". createLead here stands in for what the createLead SKILL calls.
jest.mock('../backend/src/services/leadsService', () => ({
    getOpenLeadsByContact: jest.fn(async () => []),
    updateLead: jest.fn(async () => ({})),
    createLead: jest.fn(async () => ({ UUID: 'new-lead-uuid' })),
}));
// slotEngineService: resolveTimezone + tzCombine (the hold-body compose). tzCombine
// returns a deterministic ISO so we can assert what was written; a case overrides it to throw.
jest.mock('../backend/src/services/slotEngineService', () => ({
    resolveTimezone: jest.fn(async () => 'America/New_York'),
    tzCombine: jest.fn((date, hhmm) => `${date}T${hhmm}:00.000Z`),
}));
jest.mock('../backend/src/services/eventService', () => ({ logEvent: jest.fn(() => {}) }));

const leadsService = require('../backend/src/services/leadsService');
const slotEngineService = require('../backend/src/services/slotEngineService');
const eventService = require('../backend/src/services/eventService');
const { runSkill } = require(AGENT);

const SLOT = { date: '2026-07-16', start: '13:00', end: '15:00' };

/** A rowToLead-shaped open lead (PascalCase, ISO LeadDateTime/LeadEndDateTime). */
function openLead(overrides = {}) {
    return { UUID: 'lead-uuid-1', ContactId: CONTACT, Status: 'Review', LeadDateTime: null, LeadEndDateTime: null, ...overrides };
}

beforeEach(() => {
    jest.clearAllMocks();
    gate.deriveLevel.mockResolvedValue({ level: 'L1', contactId: CONTACT, customerName: 'Jane Doe', matchedPhone: '6175551212' });
    leadsService.getOpenLeadsByContact.mockResolvedValue([]);
    slotEngineService.tzCombine.mockImplementation((date, hhmm) => `${date}T${hhmm}:00.000Z`);
});

// ════════════════════════════════════════════════════════════════════════════
// B1/B3/B4 — UPDATE the existing open lead (never a duplicate)
// ════════════════════════════════════════════════════════════════════════════

describe('bookOnLead — UPDATE the existing open lead (B1/B3/B4)', () => {
    test('B1: 1 open lead → updateLead(uuid, hold, companyId); created:false; createLead NOT called (no dup)', async () => {
        leadsService.getOpenLeadsByContact.mockResolvedValue([openLead({ UUID: 'lead-A' })]);
        const out = await runSkill('bookOnLead', CO, { source: 'test' }, { phone: '+16175551212', chosenSlot: SLOT });

        expect(out).toMatchObject({ ok: true, success: true, created: false, leadId: 'lead-A' });
        expect(out.bookedWindow).toMatch(/between 1pm and 3pm/i);
        // the hold body carries the tz-combined LeadDateTime/LeadEndDateTime, company-scoped
        expect(leadsService.updateLead).toHaveBeenCalledTimes(1);
        const [uuid, hold, companyId] = leadsService.updateLead.mock.calls[0];
        expect(uuid).toBe('lead-A');
        expect(companyId).toBe(CO);
        expect(hold).toMatchObject({ LeadDateTime: '2026-07-16T13:00:00.000Z', LeadEndDateTime: '2026-07-16T15:00:00.000Z' });
        // NO duplicate lead created while an open lead exists (the P0 guarantee)
        expect(leadsService.createLead).not.toHaveBeenCalled();
    });

    test('B3: >1 open lead → UPDATE the NEWEST (list[0]); still no create', async () => {
        // getOpenLeadsByContact returns newest-first (lead_date_time DESC, id DESC) — the
        // skill takes [0]. We assert it targets the first, not any later, lead.
        leadsService.getOpenLeadsByContact.mockResolvedValue([openLead({ UUID: 'newest' }), openLead({ UUID: 'older' })]);
        const out = await runSkill('bookOnLead', CO, {}, { phone: '+16175551212', chosenSlot: SLOT });
        expect(out).toMatchObject({ ok: true, created: false, leadId: 'newest' });
        expect(leadsService.updateLead).toHaveBeenCalledWith('newest', expect.any(Object), CO);
        expect(leadsService.createLead).not.toHaveBeenCalled();
    });

    test('B4: lead already holds a LeadDateTime → UPDATE overwrites with the newly-confirmed slot (re-hold)', async () => {
        leadsService.getOpenLeadsByContact.mockResolvedValue([openLead({ UUID: 'lead-A', LeadDateTime: '2026-01-01T10:00:00.000Z', LeadEndDateTime: '2026-01-01T12:00:00.000Z' })]);
        const out = await runSkill('bookOnLead', CO, {}, { phone: '+16175551212', chosenSlot: SLOT });
        expect(out.created).toBe(false);
        const [, hold] = leadsService.updateLead.mock.calls[0];
        // the NEW slot wins (the latest confirmed window)
        expect(hold.LeadDateTime).toBe('2026-07-16T13:00:00.000Z');
    });

    test('B8: only one of lat/lng finite → neither coord written (both-or-nothing)', async () => {
        leadsService.getOpenLeadsByContact.mockResolvedValue([openLead({ UUID: 'lead-A' })]);
        await runSkill('bookOnLead', CO, {}, { phone: '+16175551212', chosenSlot: SLOT, lat: 42.36 /* lng missing */ });
        const [, hold] = leadsService.updateLead.mock.calls[0];
        expect(hold).not.toHaveProperty('Latitude');
        expect(hold).not.toHaveProperty('Longitude');
    });

    test('both coords finite → both written (Latitude/Longitude)', async () => {
        leadsService.getOpenLeadsByContact.mockResolvedValue([openLead({ UUID: 'lead-A' })]);
        await runSkill('bookOnLead', CO, {}, { phone: '+16175551212', chosenSlot: SLOT, lat: 42.36, lng: -71.06 });
        const [, hold] = leadsService.updateLead.mock.calls[0];
        expect(hold).toMatchObject({ Latitude: 42.36, Longitude: -71.06 });
    });

    test('audit: a lead_slot_held event is logged (non-fatal) on a successful UPDATE hold', async () => {
        leadsService.getOpenLeadsByContact.mockResolvedValue([openLead({ UUID: 'lead-A' })]);
        await runSkill('bookOnLead', CO, {}, { phone: '+16175551212', chosenSlot: SLOT });
        expect(eventService.logEvent).toHaveBeenCalledWith(CO, 'lead', 'lead-A', 'lead_slot_held', expect.objectContaining({ actor: 'AI Phone', created: false }), 'system');
    });

    test('a logEvent hiccup does NOT turn a successful hold into a failure (the write already landed)', async () => {
        leadsService.getOpenLeadsByContact.mockResolvedValue([openLead({ UUID: 'lead-A' })]);
        eventService.logEvent.mockImplementation(() => { throw new Error('events down'); });
        const out = await runSkill('bookOnLead', CO, {}, { phone: '+16175551212', chosenSlot: SLOT });
        expect(out).toMatchObject({ ok: true, success: true, created: false });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// B2 — no open lead → createLead delegation (exactly one create)
// ════════════════════════════════════════════════════════════════════════════

describe('bookOnLead — no open lead → createLead delegation (B2)', () => {
    test('B2: 0 open leads → createLead once (created:true); updateLead NOT called (no double-create)', async () => {
        leadsService.getOpenLeadsByContact.mockResolvedValue([]);
        leadsService.createLead.mockResolvedValue({ UUID: 'fresh-lead' });
        const out = await runSkill('bookOnLead', CO, { source: 'test' }, {
            phone: '+16175551212', chosenSlot: SLOT,
            firstName: 'Jane', lastName: 'Doe', zip: '02101', unitType: 'Refrigerator', problemDescription: 'not cooling',
        });
        expect(out).toMatchObject({ ok: true, success: true, created: true, leadId: 'fresh-lead' });
        // exactly ONE create via the createLead skill; no UPDATE
        expect(leadsService.createLead).toHaveBeenCalledTimes(1);
        expect(leadsService.updateLead).not.toHaveBeenCalled();
        // the createLead body carried the chosen slot as a real hold (JobSource 'AI Phone')
        const body = leadsService.createLead.mock.calls[0][0];
        expect(body).toMatchObject({ JobSource: 'AI Phone', LeadDateTime: '2026-07-16T13:00:00.000Z', LeadEndDateTime: '2026-07-16T15:00:00.000Z' });
    });

    test('B2 failure: createLead fallback yields no lead → refusal, never a false success', async () => {
        leadsService.getOpenLeadsByContact.mockResolvedValue([]);
        // createLead skill returns { success:false } when the phone is missing (its own guard);
        // simulate by making the underlying create throw twice (retry exhausted) → skill success:false.
        leadsService.createLead.mockRejectedValue(new Error('lead insert failed'));
        const out = await runSkill('bookOnLead', CO, {}, { phone: '+16175551212', chosenSlot: SLOT, firstName: 'Jane', zip: '02101' });
        expect(out.ok).toBe(false);
        expect(out.success).toBeUndefined();
        expect(leadsService.updateLead).not.toHaveBeenCalled();
    }, 10000);
});

// ════════════════════════════════════════════════════════════════════════════
// B5/B6 — malformed slot / tzCombine fault → refusal, no write
// ════════════════════════════════════════════════════════════════════════════

describe('bookOnLead — confirm-before-write (B5/B6)', () => {
    test('B5: malformed chosenSlot (no end) → refusal + needsConfirmation, NO read/write', async () => {
        const out = await runSkill('bookOnLead', CO, {}, { phone: '+16175551212', chosenSlot: { date: '2026-07-16', start: '13:00' } });
        expect(out).toMatchObject({ ok: false, needsConfirmation: true });
        expect(leadsService.getOpenLeadsByContact).not.toHaveBeenCalled();
        expect(leadsService.updateLead).not.toHaveBeenCalled();
        expect(leadsService.createLead).not.toHaveBeenCalled();
    });

    test('B5: absent chosenSlot → refusal, NO write', async () => {
        const out = await runSkill('bookOnLead', CO, {}, { phone: '+16175551212' });
        expect(out).toMatchObject({ ok: false, needsConfirmation: true });
        expect(leadsService.updateLead).not.toHaveBeenCalled();
        expect(leadsService.createLead).not.toHaveBeenCalled();
    });

    test('B6: tzCombine throws (bad tz/slot) → refusal, NO write of any kind', async () => {
        leadsService.getOpenLeadsByContact.mockResolvedValue([openLead({ UUID: 'lead-A' })]);
        slotEngineService.tzCombine.mockImplementation(() => { throw new Error('bad zone'); });
        const out = await runSkill('bookOnLead', CO, {}, { phone: '+16175551212', chosenSlot: SLOT });
        expect(out.ok).toBe(false);
        expect(leadsService.updateLead).not.toHaveBeenCalled();
        expect(leadsService.createLead).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// B9 — defensive ownership re-assert
// ════════════════════════════════════════════════════════════════════════════

describe('bookOnLead — ownership (B9)', () => {
    test('B9: a returned lead whose ContactId ≠ the verified contact → refusal, NO write', async () => {
        // The company+contact-scoped read makes this near-impossible, but the defensive
        // re-assert (`String(lead.ContactId) === String(contactId)`) must refuse rather
        // than mutate a lead we can't prove ownership of.
        leadsService.getOpenLeadsByContact.mockResolvedValue([openLead({ UUID: 'foreign-lead', ContactId: 999 })]);
        const out = await runSkill('bookOnLead', CO, {}, { phone: '+16175551212', chosenSlot: SLOT });
        expect(out.ok).toBe(false);
        expect(leadsService.updateLead).not.toHaveBeenCalled();
        expect(leadsService.createLead).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L1 gate — an identified caller books; L0 is refused (no write)
// ════════════════════════════════════════════════════════════════════════════

describe('bookOnLead — the L1 gate (registry requiredLevel L1)', () => {
    test('L0 (unresolved) caller → refused by the choke-point, bookOnLead NEVER runs (no read/write)', async () => {
        gate.deriveLevel.mockResolvedValue({ level: 'L0', contactId: null, customerName: null });
        const out = await runSkill('bookOnLead', CO, { source: 'test' }, { phone: '+15550000000', chosenSlot: SLOT });
        expect(out).toMatchObject({ ok: false, needsVerification: true });
        expect(leadsService.getOpenLeadsByContact).not.toHaveBeenCalled();
        expect(leadsService.updateLead).not.toHaveBeenCalled();
        expect(leadsService.createLead).not.toHaveBeenCalled();
    });

    test('L1 (phone-identified) caller → passes the gate and books (contactId from the SERVER context, not input)', async () => {
        // The verified contact is 501 (from deriveLevel); a hostile input.contactId is ignored.
        gate.deriveLevel.mockResolvedValue({ level: 'L1', contactId: CONTACT, customerName: 'Jane Doe' });
        leadsService.getOpenLeadsByContact.mockResolvedValue([openLead({ UUID: 'lead-A' })]);
        const out = await runSkill('bookOnLead', CO, {}, { phone: '+16175551212', contactId: 'attacker-999', chosenSlot: SLOT });
        expect(out).toMatchObject({ ok: true, created: false });
        // the read + update were scoped to the SERVER-verified contact 501, never the claim
        expect(leadsService.getOpenLeadsByContact).toHaveBeenCalledWith(CONTACT, CO);
    });

    test('L2 caller also books (higher-than-required level passes the gate)', async () => {
        gate.deriveLevel.mockResolvedValue({ level: 'L2', contactId: CONTACT, customerName: 'Jane Doe' });
        leadsService.getOpenLeadsByContact.mockResolvedValue([openLead({ UUID: 'lead-A' })]);
        const out = await runSkill('bookOnLead', CO, {}, { phone: '+16175551212', name: 'Jane Doe', zip: '02101', chosenSlot: SLOT });
        expect(out).toMatchObject({ ok: true, created: false });
    });
});
