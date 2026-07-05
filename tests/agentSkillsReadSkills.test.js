/**
 * agentSkillsReadSkills.test.js — AGENT-SKILLS-001 T9 (Group E — L1 read skills)
 *
 * Mocked-unit proof of the L1 reads (getCustomerOverview / getJobStatus /
 * getAppointments) driven through the real `runSkill` choke-point with the gate
 * granting L1 and the reused services mocked. Asserts speech-safe, provider-neutral
 * outputs + the specific below-L2 non-disclosure rules:
 *   - ASK-SKILL-OV-01/02/03: counts + next window (derived from listJobs, NOT
 *     getScheduleItems({contactId})) + existence booleans, NO amounts/addresses,
 *     multi-open-job disambiguation.
 *   - ASK-SKILL-JS-01/02/03: mapped status phrase (never raw blanc_status), ETA
 *     framing with no tech PII, booked-not-started (Submitted+window) offers
 *     reschedule with NO 'Scheduled' label.
 *   - ASK-SKILL-AP-01/02: windows as ranges, statusLabel phrases, empty → offer to book.
 *   - ASK-SKILL-EMPTY-01: first-run contact → empty shapes, never an error.
 */

'use strict';

const AGENT = '../backend/src/services/agentSkills';
const CO = '00000000-0000-0000-0000-000000000001';
const CONTACT = 501;

// Gate: grant L1 (contact resolved) by default so the L1 reads run; assert() stays
// REAL so a genuine sub-L1 context would throw exactly as in production.
jest.mock('../backend/src/services/agentSkills/verificationGate', () => {
    const REAL = jest.requireActual('../backend/src/services/agentSkills/verificationGate');
    return { ...REAL, deriveLevel: jest.fn() };
});
const gate = require('../backend/src/services/agentSkills/verificationGate');

jest.mock('../backend/src/services/jobsService', () => ({
    listJobs: jest.fn(async () => ({ results: [] })),
    getJobById: jest.fn(),
    BLANC_STATUSES: ['Submitted', 'Waiting for parts', 'Follow Up with Client', 'Visit completed', 'Job is Done', 'Rescheduled', 'Canceled', 'On the way'],
}));
jest.mock('../backend/src/services/estimatesService', () => ({ listEstimates: jest.fn(async () => ({ rows: [] })) }));
jest.mock('../backend/src/services/invoicesService', () => ({ listInvoices: jest.fn(async () => ({ rows: [] })) }));
// scheduleService is NOT mocked as a source here — overview/appointments derive from
// listJobs. If any skill required getScheduleItems it would be undefined and fail,
// which is exactly what ASK-SKILL-OV-02 guards against.
jest.mock('../backend/src/services/scheduleService', () => ({ getScheduleItems: jest.fn(async () => []) }));

const jobsService = require('../backend/src/services/jobsService');
const estimatesService = require('../backend/src/services/estimatesService');
const invoicesService = require('../backend/src/services/invoicesService');
const scheduleService = require('../backend/src/services/scheduleService');
const { runSkill } = require(AGENT);

// A start_date well in the future so the "next appointment" picker is deterministic.
const FUTURE = new Date(Date.now() + 3 * 24 * 3600 * 1000);
function isoAt(base, h, m = 0) {
    const d = new Date(base);
    d.setUTCHours(h, m, 0, 0);
    return d.toISOString();
}
function job(overrides = {}) {
    return {
        id: 7, contact_id: CONTACT, blanc_status: 'Submitted', service_name: 'Refrigerator Repair',
        start_date: isoAt(FUTURE, 15), end_date: isoAt(FUTURE, 17), // 15:00–17:00 UTC = mid-morning ET
        updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    gate.deriveLevel.mockResolvedValue({ level: 'L1', contactId: CONTACT, customerName: 'Jane Smith', matchedPhone: '6175551212' });
});

// ════════════════════════════════════════════════════════════════════════════
// getCustomerOverview
// ════════════════════════════════════════════════════════════════════════════

describe('getCustomerOverview (L1) — ASK-SKILL-OV-*', () => {
    test('OV-01: counts + next window + existence booleans; NO amounts/addresses anywhere', async () => {
        jobsService.listJobs.mockResolvedValue({ results: [job({ id: 7 }), job({ id: 8, start_date: isoAt(FUTURE, 20), end_date: isoAt(FUTURE, 22) })] });
        estimatesService.listEstimates.mockResolvedValue({ rows: [{ id: 'e1', status: 'sent', total: '250.00' }] });
        invoicesService.listInvoices.mockResolvedValue({ rows: [{ id: 'i1', status: 'sent', balance_due: '99.00' }] });

        const out = await runSkill('getCustomerOverview', CO, {}, { contactId: CONTACT });
        expect(out.ok).toBe(true);
        expect(out.openJobsCount).toBe(2);
        expect(out.nextAppointment).toMatchObject({ jobId: '7' });
        expect(out.nextAppointment.window).toMatch(/between .* and /i);
        expect(out.hasOpenEstimate).toBe(true);
        expect(out.hasUnpaidInvoice).toBe(true);
        // existence booleans, not counts/totals; NO amount/address key leaks
        expect(typeof out.hasOpenEstimate).toBe('boolean');
        const dump = JSON.stringify(out);
        expect(dump).not.toMatch(/250|99\.00|\$|address|street/i);
    });

    test('OV-02: next window derived from listJobs; getScheduleItems NOT used as a contact filter', async () => {
        jobsService.listJobs.mockResolvedValue({ results: [job()] });
        const out = await runSkill('getCustomerOverview', CO, {}, { contactId: CONTACT });
        expect(jobsService.listJobs).toHaveBeenCalledWith(expect.objectContaining({ contactId: CONTACT, companyId: CO, onlyOpen: true }));
        expect(out.nextAppointment).not.toBeNull();
        // The skill must NOT lean on getScheduleItems for the contact-scoped window.
        expect(scheduleService.getScheduleItems).not.toHaveBeenCalled();
    });

    test('OV-03: multiple open jobs → speak asks which appliance/service to scope', async () => {
        jobsService.listJobs.mockResolvedValue({ results: [job({ id: 7 }), job({ id: 8 }), job({ id: 9 })] });
        const out = await runSkill('getCustomerOverview', CO, {}, { contactId: CONTACT });
        expect(out.openJobsCount).toBe(3);
        expect(out.speak).toMatch(/which one|which|appliance|service/i);
    });

    test('lastJobStatus is a mapped phrase, never a raw blanc_status code', async () => {
        jobsService.listJobs.mockResolvedValue({ results: [job({ blanc_status: 'Waiting for parts', start_date: null, end_date: null })] });
        const out = await runSkill('getCustomerOverview', CO, {}, { contactId: CONTACT });
        expect(out.lastJobStatus).toBe("We're waiting on a part to finish the repair.");
        expect(out.lastJobStatus).not.toMatch(/Waiting for parts/);
    });

    test('EMPTY-01: first-run contact (no jobs/estimates/invoices) → empty shapes, offer to book, never an error', async () => {
        jobsService.listJobs.mockResolvedValue({ results: [] });
        estimatesService.listEstimates.mockResolvedValue({ rows: [] });
        invoicesService.listInvoices.mockResolvedValue({ rows: [] });
        const out = await runSkill('getCustomerOverview', CO, {}, { contactId: CONTACT });
        expect(out).toMatchObject({ ok: true, openJobsCount: 0, nextAppointment: null, hasOpenEstimate: false, hasUnpaidInvoice: false });
        expect(out.speak).toMatch(/book|help/i);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// getJobStatus
// ════════════════════════════════════════════════════════════════════════════

describe('getJobStatus (L1) — ASK-SKILL-JS-*', () => {
    test('JS-01: On the way → mapped phrase, ETA framing, NO tech name/number, statusStage not the raw code', async () => {
        jobsService.getJobById.mockResolvedValue(job({ blanc_status: 'On the way', start_date: null, end_date: null }));
        const out = await runSkill('getJobStatus', CO, {}, { contactId: CONTACT, jobId: 7 });
        expect(out.statusLabel).toBe('Your technician is on the way.');
        expect(out.technicianEtaText).toMatch(/text you before arriving/i);
        // no tech PII anywhere
        expect(JSON.stringify(out)).not.toMatch(/alex|555|@/i);
        // the raw FSM code is not spoken back
        expect(out.speak).not.toMatch(/On the way$/);
    });

    test('JS-02: omitting jobId → most relevant OWN open job selected', async () => {
        jobsService.listJobs.mockResolvedValue({ results: [job({ id: 42, blanc_status: 'Waiting for parts', start_date: null, end_date: null })] });
        const out = await runSkill('getJobStatus', CO, {}, { contactId: CONTACT });
        expect(out.jobId).toBe('42');
        expect(out.statusLabel).toBe("We're waiting on a part to finish the repair.");
    });

    test('JS-03: booked-not-started (Submitted + window) → offer reschedule, NEVER a "Scheduled" label', async () => {
        jobsService.getJobById.mockResolvedValue(job({ blanc_status: 'Submitted' }));
        const out = await runSkill('getJobStatus', CO, {}, { contactId: CONTACT, jobId: 7 });
        expect(out.nextAction).toBe('offer_reschedule');
        expect(out.statusLabel).not.toMatch(/Scheduled/);
        expect(out.statusLabel).toMatch(/booked in for/i);
    });

    test('multiple open jobs & no jobId → asks which (E2), does not guess', async () => {
        jobsService.listJobs.mockResolvedValue({ results: [job({ id: 7 }), job({ id: 8 })] });
        const out = await runSkill('getJobStatus', CO, {}, { contactId: CONTACT });
        expect(out.ok).toBe(false);
        expect(out.speak).toMatch(/which one|jobs in progress/i);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// getAppointments
// ════════════════════════════════════════════════════════════════════════════

describe('getAppointments (L1) — ASK-SKILL-AP-*', () => {
    test('AP-01: windows as ranges + statusLabel phrases; canceled excluded', async () => {
        jobsService.listJobs.mockResolvedValue({ results: [
            job({ id: 7, blanc_status: 'Submitted' }),
            job({ id: 8, blanc_status: 'Canceled', start_date: isoAt(FUTURE, 18), end_date: isoAt(FUTURE, 20) }),
        ] });
        const out = await runSkill('getAppointments', CO, {}, { contactId: CONTACT });
        expect(out.ok).toBe(true);
        expect(out.appointments).toHaveLength(1); // canceled dropped
        expect(out.appointments[0].jobId).toBe('7');
        expect(out.appointments[0].window).toMatch(/between .* and /i);
        expect(out.appointments[0].statusLabel).toBe("We've got your request and are getting it scheduled.");
    });

    test('AP-02: no appointments → appointments:[], speak offers to book, never an error (E7)', async () => {
        jobsService.listJobs.mockResolvedValue({ results: [] });
        const out = await runSkill('getAppointments', CO, {}, { contactId: CONTACT });
        expect(out).toMatchObject({ ok: true, appointments: [] });
        expect(out.speak).toMatch(/book|scheduled/i);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// identifyCaller through the choke-point (derive / greet / ambiguous)
// ════════════════════════════════════════════════════════════════════════════

describe('identifyCaller via runSkill — derive / greet / ambiguous', () => {
    test('L1 context → greet by name (matchType existing)', async () => {
        gate.deriveLevel.mockResolvedValue({ level: 'L1', contactId: CONTACT, customerName: 'Jane Smith' });
        const out = await runSkill('identifyCaller', CO, {}, { phone: '+16175551212' });
        expect(out.matchType).toBe('existing');
        expect(out.customerName).toBe('Jane Smith');
        expect(out.verificationLevel).toBe('L1');
    });

    test('ambiguous context → matchType ambiguous + count', async () => {
        gate.deriveLevel.mockResolvedValue({ level: 'L0', contactId: null, customerName: null, ambiguous: true, ambiguousCount: 2 });
        const out = await runSkill('identifyCaller', CO, {}, { phone: '+16175551212' });
        expect(out.matchType).toBe('ambiguous');
        expect(out.ambiguousCount).toBe(2);
    });

    test('no match → matchType new (never blocks — L0 skill always runs)', async () => {
        gate.deriveLevel.mockResolvedValue({ level: 'L0', contactId: null, customerName: null });
        const out = await runSkill('identifyCaller', CO, {}, { phone: '' });
        expect(out.ok).toBe(true);
        expect(out.matchType).toBe('new');
    });
});
