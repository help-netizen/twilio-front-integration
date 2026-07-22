/**
 * agentSkillsGate.test.js — AGENT-SKILLS-001 T9 (P0 gate G1 — verification)
 *
 * Mocked-unit proof of the server-side, DB-derived L0/L1/L2 verification gate
 * (`verificationGate.deriveLevel` / `assert`) AND its enforcement at the
 * `index.runSkill` choke-point. Covers Group B (ASK-GATE-01…12) + AC-8 / E15.
 *
 * The one load-bearing rule (AC-8): a client/LLM `verified:true` / `level:'L2'`
 * NEVER raises the level — the gate reads ONLY the DB-derived resolver result +
 * server-side name/zip re-confirmation. Verification is stateless-per-call, so a
 * mid-call "downgrade" simply fails the gate again (fail-closed).
 *
 * Harness (project idiom, mirrors agentSkillsWriteSkills.test.js):
 *   - `identityResolver` is mocked so `deriveLevel` derivation is fully controlled;
 *     `verificationGate` itself runs REAL (its derivation + assert are the SUT).
 *   - The gated services (jobsService/estimatesService/invoicesService/eventService/
 *     scheduleService) are mocked so every "rejected" case asserts the gated
 *     function was NOT called (non-vacuous — no read/write happened).
 */

'use strict';

const AGENT = '../backend/src/services/agentSkills';
const CO = '00000000-0000-0000-0000-000000000001';
const CONTACT = 501;

// identityResolver mocked → deriveLevel derivation is fully controlled. We keep the
// REAL normalize* helpers (the gate's L2 name/zip re-confirmation uses them), so a
// wrong ZIP genuinely fails the second factor.
jest.mock('../backend/src/services/agentSkills/identityResolver', () => {
    const REAL = jest.requireActual('../backend/src/services/agentSkills/identityResolver');
    return { ...REAL, resolve: jest.fn() };
});
const identityResolver = require('../backend/src/services/agentSkills/identityResolver');

// Gated services mocked so rejection cases can assert "never called".
jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: jest.fn(),
    listJobs: jest.fn(async () => ({ results: [] })),
    cancelJob: jest.fn(),
    addNote: jest.fn(async () => ({ notes: [] })),
    BLANC_STATUSES: ['Submitted', 'Waiting for parts', 'Follow Up with Client', 'Visit completed', 'Job is Done', 'Rescheduled', 'Canceled', 'On the way'],
}));
jest.mock('../backend/src/services/estimatesService', () => ({
    listEstimates: jest.fn(async () => ({ rows: [] })),
    getEstimate: jest.fn(),
}));
jest.mock('../backend/src/services/invoicesService', () => ({
    listInvoices: jest.fn(async () => ({ rows: [] })),
    getInvoice: jest.fn(),
}));
jest.mock('../backend/src/services/eventService', () => ({
    getEntityHistory: jest.fn(async () => []),
    logEvent: jest.fn(() => {}),
}));
jest.mock('../backend/src/services/scheduleService', () => ({
    rescheduleItem: jest.fn(async () => ({})),
}));

const jobsService = require('../backend/src/services/jobsService');
const estimatesService = require('../backend/src/services/estimatesService');
const invoicesService = require('../backend/src/services/invoicesService');
const eventService = require('../backend/src/services/eventService');
const scheduleService = require('../backend/src/services/scheduleService');

const gate = require('../backend/src/services/agentSkills/verificationGate');
const { runSkill } = require(AGENT);

// --- resolver fixtures --------------------------------------------------------
const NO_MATCH = { matchType: 'new', contactId: null, customerName: null, matchedPhone: null, ambiguousCount: 0, contact: null };
function existing(overrides = {}) {
    return {
        matchType: 'existing',
        contactId: CONTACT,
        customerName: 'Jane Smith',
        matchedPhone: '6175551212',
        ambiguousCount: 0,
        contact: { id: CONTACT, name: 'Jane Smith', zips: ['02101'], streets: ['12 walpole st'] },
        ...overrides,
    };
}
function ambiguous(count = 2) {
    return { matchType: 'ambiguous', contactId: null, customerName: null, matchedPhone: '6175551212', ambiguousCount: count, contact: null };
}

beforeEach(() => {
    jest.clearAllMocks();
    identityResolver.resolve.mockResolvedValue(NO_MATCH);
});

// ════════════════════════════════════════════════════════════════════════════
// deriveLevel — L0/L1/L2 derivation from the DB (never the caller's word)
// ════════════════════════════════════════════════════════════════════════════

describe('verificationGate.deriveLevel — L-level derivation (G1 / §2.2)', () => {
    test('ASK-GATE-01: no match → L0 (contactId null)', async () => {
        identityResolver.resolve.mockResolvedValue(NO_MATCH);
        const ctx = await gate.deriveLevel(CO, { phone: '+15550000000' });
        expect(ctx.level).toBe('L0');
        expect(ctx.contactId).toBeNull();
    });

    test('ASK-GATE-02: single real phone match → L1, DB-derived contactId (not the caller-supplied one)', async () => {
        identityResolver.resolve.mockResolvedValue(existing());
        const ctx = await gate.deriveLevel(CO, { phone: '+16175551212', contactId: 'attacker-999' });
        expect(ctx.level).toBe('L1');
        expect(ctx.contactId).toBe(CONTACT); // the resolved id, NEVER the caller's claim
    });

    test('ASK-GATE-03: phone + confirmed name + ZIP → L2', async () => {
        identityResolver.resolve.mockResolvedValue(existing());
        const ctx = await gate.deriveLevel(CO, { phone: '+16175551212', name: 'Jane Smith', zip: '02101' });
        expect(ctx.level).toBe('L2');
    });

    test('ASK-GATE-03: phone + confirmed name + STREET (instead of ZIP) → L2', async () => {
        identityResolver.resolve.mockResolvedValue(existing());
        const ctx = await gate.deriveLevel(CO, { phone: '+16175551212', name: 'Jane Smith', street: '12 Walpole St' });
        expect(ctx.level).toBe('L2');
    });

    test('ASK-GATE-04: name matches but ZIP wrong → stays L1 (second factor not confirmed)', async () => {
        identityResolver.resolve.mockResolvedValue(existing());
        const ctx = await gate.deriveLevel(CO, { phone: '+16175551212', name: 'Jane Smith', zip: '99999' });
        expect(ctx.level).toBe('L1');
    });

    test('ASK-GATE-06: ambiguous (>1 contact on phone) → L0-with-marker, no auto-upgrade', async () => {
        identityResolver.resolve.mockResolvedValue(ambiguous(2));
        const ctx = await gate.deriveLevel(CO, { phone: '+16175551212', name: 'Jane Smith', zip: '02101' });
        expect(ctx.level).toBe('L0'); // ambiguous never rises, even with name+zip
        expect(ctx.ambiguous).toBe(true);
        expect(ctx.ambiguousCount).toBe(2);
    });

    test('ASK-GATE-07: masked/spoofed number matching nothing → L0; name+ZIP later rises to L2', async () => {
        identityResolver.resolve.mockResolvedValueOnce(NO_MATCH);
        const first = await gate.deriveLevel(CO, { phone: '+10000000000' });
        expect(first.level).toBe('L0');
        // Second question supplies confirmed name+ZIP → resolver now finds the contact.
        identityResolver.resolve.mockResolvedValueOnce(existing());
        const second = await gate.deriveLevel(CO, { name: 'Jane Smith', zip: '02101' });
        expect(second.level).toBe('L2');
    });

    test('AC-8: deriveLevel IGNORES client-asserted verified/level (only the resolver + re-confirm decide)', async () => {
        // Resolver says L1-only (name/zip not confirmable → no L2 second factor).
        identityResolver.resolve.mockResolvedValue(existing({ contact: { id: CONTACT, name: 'Jane Smith', zips: [], streets: [] } }));
        const ctx = await gate.deriveLevel(CO, { phone: '+16175551212', verified: true, level: 'L2', isVerified: true });
        expect(ctx.level).toBe('L1'); // the self-asserted L2 had no effect
        // And the resolver was called with ONLY the claim fields (no verified/level leaked in).
        const passedClaims = identityResolver.resolve.mock.calls[0][1];
        expect(passedClaims).not.toHaveProperty('verified');
        expect(passedClaims).not.toHaveProperty('level');
    });

    test('fail-closed: resolver throws → L0 (least privilege), never throws out', async () => {
        identityResolver.resolve.mockRejectedValue(new Error('pg ECONNREFUSED'));
        const ctx = await gate.deriveLevel(CO, { phone: '+16175551212' });
        expect(ctx.level).toBe('L0');
    });

    test('missing companyId → L0 (no cross-company match possible)', async () => {
        const ctx = await gate.deriveLevel(null, { phone: '+16175551212' });
        expect(ctx.level).toBe('L0');
        expect(identityResolver.resolve).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// assert() — typed throw when derived < required
// ════════════════════════════════════════════════════════════════════════════

describe('verificationGate.assert — typed verification_required (ASK-GATE-08)', () => {
    test('throws typed verification_required when derived < required', () => {
        expect(() => gate.assert('L2', { level: 'L1' })).toThrow();
        try {
            gate.assert('L2', { level: 'L1' });
        } catch (e) {
            expect(e.code).toBe('verification_required');
            expect(e.name).toBe('verification_required');
            expect(e.verificationRequired).toBe(true);
        }
    });

    test('equal or higher level passes (does NOT throw)', () => {
        expect(() => gate.assert('L1', { level: 'L1' })).not.toThrow();
        expect(() => gate.assert('L1', { level: 'L2' })).not.toThrow();
        expect(() => gate.assert('L0', { level: 'L0' })).not.toThrow();
        expect(gate.assert('L1', { level: 'L2' })).toBe(true);
    });

    test('accepts a bare level string as well as a context object', () => {
        expect(() => gate.assert('L2', 'L1')).toThrow();
        expect(() => gate.assert('L1', 'L2')).not.toThrow();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// runSkill choke-point — the gate throws → soft needsVerification, skill NOT run
// ════════════════════════════════════════════════════════════════════════════

describe('runSkill enforces the gate — assert throws → needsVerification, no skill run (§2.1)', () => {
    test('ASK-GATE-01: L0 caller → getJobStatus (L1) refused, listJobs/getJobById NEVER called', async () => {
        identityResolver.resolve.mockResolvedValue(NO_MATCH);
        const out = await runSkill('getJobStatus', CO, { source: 'test' }, { phone: '+15550000000', jobId: 7 });
        expect(out).toMatchObject({ ok: false, needsVerification: true });
        expect(jobsService.getJobById).not.toHaveBeenCalled();
        expect(jobsService.listJobs).not.toHaveBeenCalled();
    });

    test('ASK-GATE-01: L0 caller → identifyCaller STILL proceeds and returns matchType:new', async () => {
        identityResolver.resolve.mockResolvedValue({ ...NO_MATCH, matchedPhone: '5550000000' });
        const out = await runSkill('identifyCaller', CO, { source: 'test' }, { phone: '+15550000000' });
        expect(out.ok).toBe(true);
        expect(out.matchType).toBe('new');
        expect(out.verificationLevel).toBe('L0');
    });

    test('ASK-GATE-05 / E15: self-asserted verified:true on an L0 (unresolved) identity → reschedule refused, rescheduleItem NEVER called', async () => {
        // AGENT-SKILLS-002: rescheduleAppointment relaxed L2→L1, so an L1 caller now
        // PASSES it (see ASK-GATE-05b below). The AC-8 core is re-expressed at the
        // boundary that DIDN'T move: an L0/unresolved caller who self-asserts
        // verified:true / level:L2 is STILL refused (the gate re-derives L0 from the DB,
        // never trusts the claim). Reschedule stays L0-blocked.
        identityResolver.resolve.mockResolvedValue(NO_MATCH);
        const out = await runSkill('rescheduleAppointment', CO, { source: 'test' }, {
            phone: '+15550000000', verified: true, level: 'L2',
            jobId: 7, newPreferredSlot: { date: '2026-07-10', start: '10:00', end: '12:00' },
        });
        expect(out).toMatchObject({ ok: false, needsVerification: true });
        expect(scheduleService.rescheduleItem).not.toHaveBeenCalled();
        expect(jobsService.getJobById).not.toHaveBeenCalled();
    });

    test('ASK-GATE-05b: an L1 (phone-identified) caller now PASSES the gate for reschedule (L2→L1 relaxation), ownership then checked in-skill', async () => {
        // The relaxation lets an L1 caller THROUGH the gate; the skill then runs its
        // own ownership pre-check (getJobById + contact match). Here getJobById returns
        // null (no matching owned job) → the SKILL refuses — but crucially the gate did
        // NOT block, so getJobById WAS reached (proving L1 cleared the entry bar).
        identityResolver.resolve.mockResolvedValue(existing({ contact: { id: CONTACT, name: 'Jane Smith', zips: [], streets: [] } }));
        jobsService.getJobById.mockResolvedValue(null);
        const out = await runSkill('rescheduleAppointment', CO, { source: 'test' }, {
            phone: '+16175551212', jobId: 7, newPreferredSlot: { date: '2026-07-10', start: '10:00', end: '12:00' },
        });
        // Not a needsVerification refusal — the gate passed; the skill's own ownership
        // guard produced a plain refusal (no L2 step-up demanded).
        expect(out.ok).toBe(false);
        expect(out.needsVerification).toBeUndefined();
        expect(jobsService.getJobById).toHaveBeenCalled(); // gate passed → skill ran its pre-check
        expect(scheduleService.rescheduleItem).not.toHaveBeenCalled(); // ownership failed → no write
    });

    // AGENT-SKILLS-002 relaxed getEstimateSummary L2→L1 in the REGISTRY, and the body
    // guard `isVerifiedContext` in getEstimateSummary/getJobHistory/getInvoiceSummary was
    // relaxed from `ctx.level === 'L2'` to `(ctx.level === 'L1' || ctx.level === 'L2')`.
    // The relaxation is now FULLY EFFECTIVE end-to-end: an L1 phone-identified caller
    // clears the gate AND the body guard, reaching estimatesService (spec §2.1/§2.2 + T2
    // task note: "history/estimate/invoice отдают ok:true при L1"). This is now a plain
    // passing `test` (was `test.failing` while the L2 body-guard bug was live).
    test('ASK-GATE-04: L1 → getEstimateSummary PASSES the gate + body guard and reaches estimatesService', async () => {
        identityResolver.resolve.mockResolvedValue(existing({ contact: { id: CONTACT, name: 'Jane Smith', zips: [], streets: [] } }));
        estimatesService.getEstimate.mockResolvedValue({ id: 'e-1', contact_id: CONTACT, estimate_number: 'EST-1', status: 'sent', total: '100.00', items: [] });
        const out = await runSkill('getEstimateSummary', CO, { source: 'test' }, {
            phone: '+16175551212', estimateId: 'e-1',
        });
        expect(out.ok).toBe(true); // intended: gate + skill both pass at L1
        expect(out.needsVerification).toBeUndefined();
        expect(estimatesService.getEstimate).toHaveBeenCalled();
    });

    // ASK-GATE-04-current REMOVED (AGENT-SKILLS-002 reconciliation): it asserted the OLD
    // buggy behavior — that an L1 caller was refused by the L2 body guard (needsVerification,
    // service NOT reached). That bug is FIXED (body guard now accepts L1), so the intended
    // contract is covered by ASK-GATE-04 above. The L0-floor case (ASK-GATE-04b) stays valid.

    test('ASK-GATE-04b: an L0 (unidentified) caller is STILL refused getEstimateSummary — L1 remains the floor', async () => {
        // The relaxation lowered the bar to L1, not to L0. An unresolved caller still
        // gets an amount-free refusal without a name/ZIP challenge; the owner chose
        // phone-only disclosure and estimatesService is never reached.
        identityResolver.resolve.mockResolvedValue(NO_MATCH);
        const out = await runSkill('getEstimateSummary', CO, { source: 'test' }, { phone: '+15550000000', estimateId: 'e-1' });
        expect(out).toMatchObject({ ok: false, phoneMatchRequired: true });
        expect(out.needsVerification).toBeUndefined();
        expect(out.speak).not.toMatch(/name|zip|code|verify/i);
        expect(estimatesService.getEstimate).not.toHaveBeenCalled();
        expect(estimatesService.listEstimates).not.toHaveBeenCalled();
    });

    test('ASK-GATE-06: ambiguous identity → every L1+ skill refused, no sensitive read runs', async () => {
        identityResolver.resolve.mockResolvedValue(ambiguous(2));
        const out = await runSkill('getCustomerOverview', CO, { source: 'test' }, { phone: '+16175551212', contactId: CONTACT });
        expect(out).toMatchObject({ ok: false, needsVerification: true });
        expect(jobsService.listJobs).not.toHaveBeenCalled();
    });

    test('ASK-GATE-09: stateless re-derivation — mid-call downgrade fails closed (L1→L0)', async () => {
        // Statelessness proven on an L1 read with NO L2 body-guard (getCustomerOverview,
        // always-L1). Call 1 with a resolving phone → L1 → the read runs; Call 2 where the
        // resolver no longer finds the contact (masked/dropped phone) → re-derives L0 →
        // refused. The level is re-computed every call, never cached / stale-trusted.
        identityResolver.resolve.mockResolvedValueOnce(existing({ contact: { id: CONTACT, name: 'Jane Smith', zips: [], streets: [] } }));
        jobsService.listJobs.mockResolvedValue({ results: [] });
        const ok = await runSkill('getCustomerOverview', CO, {}, { phone: '+16175551212', contactId: CONTACT });
        expect(ok.ok).toBe(true);
        expect(jobsService.listJobs).toHaveBeenCalledTimes(1);
        // Call 2: the phone no longer resolves (e.g. masked) → resolver returns no match
        // → L0 → refused. Fail-closed, not stale-trust.
        jest.clearAllMocks();
        identityResolver.resolve.mockResolvedValueOnce(NO_MATCH);
        const refused = await runSkill('getCustomerOverview', CO, {}, { phone: '', contactId: CONTACT });
        expect(refused).toMatchObject({ ok: false, needsVerification: true });
        expect(jobsService.listJobs).not.toHaveBeenCalled();
    });

    test('ASK-GATE-10: an L0 (unidentified) caller hitting EACH now-L1 skill → uniform safe refusal, service NEVER called, NO disclosure', async () => {
        // AGENT-SKILLS-002: the five formerly-L2 skills (history/estimate/invoice/
        // reschedule/cancel) are now L1. The uniform-refusal + no-disclosure invariant
        // moves down to the L0 boundary: an UNIDENTIFIED caller is still refused all of
        // them (L1 is the floor), the corresponding service is never reached, and the
        // refusal leaks no amount/address/note text. This is the AC-8 core preserved.
        identityResolver.resolve.mockResolvedValue(NO_MATCH);
        const id = { phone: '+15550000000' };

        const hist = await runSkill('getJobHistory', CO, {}, { ...id, jobId: 7 });
        const est = await runSkill('getEstimateSummary', CO, {}, { ...id, estimateId: 'e-1' });
        const inv = await runSkill('getInvoiceSummary', CO, {}, { ...id, invoiceId: 'i-1' });
        const resch = await runSkill('rescheduleAppointment', CO, {}, { ...id, jobId: 7, newPreferredSlot: { date: '2026-07-10', start: '10:00', end: '12:00' } });
        const canc = await runSkill('cancelAppointment', CO, {}, { ...id, jobId: 7, reason: 'price', retentionAttempted: true });

        for (const out of [hist, resch, canc]) {
            expect(out).toMatchObject({ ok: false, needsVerification: true });
            expect(out.speak).toMatch(/verify a couple details/i);
            // no amount / address / note text leaked in the refusal
            expect(JSON.stringify(out)).not.toMatch(/\$\d|balance|walpole|02101/i);
        }
        for (const out of [est, inv]) {
            expect(out).toMatchObject({ ok: false, phoneMatchRequired: true });
            expect(out.needsVerification).toBeUndefined();
            expect(out.speak).not.toMatch(/name|zip|code|verify/i);
            expect(JSON.stringify(out)).not.toMatch(/\$\d|balance|walpole|02101/i);
        }
        expect(eventService.getEntityHistory).not.toHaveBeenCalled();
        expect(estimatesService.getEstimate).not.toHaveBeenCalled();
        expect(estimatesService.listEstimates).not.toHaveBeenCalled();
        expect(invoicesService.getInvoice).not.toHaveBeenCalled();
        expect(invoicesService.listInvoices).not.toHaveBeenCalled();
        expect(scheduleService.rescheduleItem).not.toHaveBeenCalled();
        expect(jobsService.cancelJob).not.toHaveBeenCalled();
    });

    test('ASK-GATE-10b: an L1 (phone-identified) caller PASSES the gate for the two relaxed WRITES (reschedule/cancel) — reaches the ownership pre-check', async () => {
        // The write skills carry NO L2 body-guard, so the L2→L1 relaxation is fully
        // effective for them: an identified L1 caller clears the gate and the skill's own
        // ownership pre-check runs (getJobById reached). Neither is a needsVerification
        // refusal — the relaxation actually opened reschedule + cancel at L1.
        identityResolver.resolve.mockResolvedValue(existing({ contact: { id: CONTACT, name: 'Jane Smith', zips: [], streets: [] } }));
        const id = { phone: '+16175551212' };
        jobsService.getJobById.mockResolvedValue(null); // ownership fails in-skill → plain refusal (NOT needsVerification)
        const resch = await runSkill('rescheduleAppointment', CO, {}, { ...id, jobId: 7, newPreferredSlot: { date: '2026-07-10', start: '10:00', end: '12:00' } });
        const canc = await runSkill('cancelAppointment', CO, {}, { ...id, jobId: 7, reason: 'price', retentionAttempted: true });
        for (const out of [resch, canc]) {
            expect(out.ok).toBe(false);
            expect(out.needsVerification).toBeUndefined(); // gate passed at L1; refusal is the in-skill ownership guard
        }
        expect(jobsService.getJobById).toHaveBeenCalled(); // gate passed → both writes reached their ownership pre-check
    });

    // Spec §2.1/§2.2: an L1 caller also PASSES the three sensitive READS. The L2 body-guards
    // in getJobHistory/getEstimateSummary/getInvoiceSummary were relaxed to accept L1
    // (isVerifiedContext now allows `ctx.level === 'L1' || ctx.level === 'L2'`), so the reads
    // reach their service at L1 — the relaxation is effective end-to-end. Now a plain
    // passing `test` (was `test.failing` while the body-guard bug was live).
    test('ASK-GATE-10c: L1 → the three sensitive reads reach their service (relaxation effective)', async () => {
        identityResolver.resolve.mockResolvedValue(existing({ contact: { id: CONTACT, name: 'Jane Smith', zips: [], streets: [] } }));
        const id = { phone: '+16175551212' };
        jobsService.getJobById.mockResolvedValue({ id: 7, contact_id: CONTACT, blanc_status: 'Submitted', notes: [] });
        eventService.getEntityHistory.mockResolvedValue([]);
        estimatesService.getEstimate.mockResolvedValue({ id: 'e-1', contact_id: CONTACT, estimate_number: 'EST-1', status: 'sent', total: '10.00', items: [] });
        invoicesService.getInvoice.mockResolvedValue({ id: 'i-1', contact_id: CONTACT, invoice_number: 'INV-1', status: 'sent', total: '10.00', amount_paid: '0', balance_due: '10.00' });
        const hist = await runSkill('getJobHistory', CO, {}, { ...id, jobId: 7 });
        const est = await runSkill('getEstimateSummary', CO, {}, { ...id, estimateId: 'e-1' });
        const inv = await runSkill('getInvoiceSummary', CO, {}, { ...id, invoiceId: 'i-1' });
        for (const out of [hist, est, inv]) expect(out.needsVerification).toBeUndefined();
    });

    test('ASK-GATE-11: L1 reads that ARE unlocked still run (no over-blocking)', async () => {
        identityResolver.resolve.mockResolvedValue(existing());
        jobsService.listJobs.mockResolvedValue({ results: [] });
        const overview = await runSkill('getCustomerOverview', CO, {}, { phone: '+16175551212', contactId: CONTACT });
        expect(overview.ok).toBe(true);
        expect(jobsService.listJobs).toHaveBeenCalled();
        const appts = await runSkill('getAppointments', CO, {}, { phone: '+16175551212', contactId: CONTACT });
        expect(appts.ok).toBe(true);
    });

    test('ASK-GATE-12: unknown skill name → SAFE_FALLBACK (resolved value, not a thrown error)', async () => {
        const out = await runSkill('svc.bogus', CO, {}, {});
        expect(out).toEqual({ ok: false, speak: 'Let me have a teammate follow up with you on that.' });
        // resolver is not even reached for an unknown skill
        expect(identityResolver.resolve).not.toHaveBeenCalled();
    });
});
