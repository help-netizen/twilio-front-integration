'use strict';

const { randomUUID } = require('crypto');

const mockPartsSettingsByCompany = new Map();
const mockLeadSettingsByCompany = new Map();

jest.mock('../backend/src/services/outboundCallSettingsService', () => ({
    get: jest.fn(async companyId => mockPartsSettingsByCompany.get(companyId)),
    resolve: jest.fn(async companyId => mockPartsSettingsByCompany.get(companyId)),
}));
jest.mock('../backend/src/services/outboundLeadCallSettingsService', () => ({
    get: jest.fn(async companyId => mockLeadSettingsByCompany.get(companyId)),
    resolve: jest.fn(async companyId => mockLeadSettingsByCompany.get(companyId)),
    isSourceEnabled: jest.fn((settings, source) => (
        (settings?.enabled_sources || []).includes(source)
    )),
}));
jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: jest.fn(),
    addNote: jest.fn(async () => ({})),
    getJobBalanceDue: jest.fn(async () => ({ balanceDue: null })),
}));
jest.mock('../backend/src/services/outboundCallService', () => ({
    placeCall: jest.fn(),
}));
jest.mock('../backend/src/services/partsCallService', () => ({
    isChainCanceled: jest.fn(async () => false),
    markRobotCallCanceled: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/vapiCallTimelineService', () => ({
    recordPlacement: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/marketplaceService', () => ({
    isAppConnected: jest.fn(async () => true),
}));
jest.mock('../backend/src/services/leadsService', () => ({
    getLeadByUUID: jest.fn(),
}));
jest.mock('../backend/src/services/agentSkills/skills/recommendSlots', () => ({
    run: jest.fn(async () => ({
        available: true,
        fallback: false,
        slots: [{
            key: 'db-window-slot',
            label: 'Monday, July 20 between 9am and 11am',
            date: '2026-07-20',
            start: '09:00',
            end: '11:00',
        }],
    })),
}));
jest.mock('../backend/src/services/outboundCallCancellationService', () => ({
    CAUSES: { INBOUND_CALL: 'inbound_call' },
    cancel: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const jobsService = require('../backend/src/services/jobsService');
const leadsService = require('../backend/src/services/leadsService');
const outboundCallService = require('../backend/src/services/outboundCallService');
const recommendSlots = require('../backend/src/services/agentSkills/skills/recommendSlots');
const agentCallWindowService = require('../backend/src/services/agentCallWindowService');
const outboundCallWorker = require('../backend/src/services/outboundCallWorker');
const outboundLeadCallService = require('../backend/src/services/outboundLeadCallService');

jest.setTimeout(30000);

const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const TAG = `${Date.now()}-${process.pid}`;
const LEAD_UUID = `RW${String(Date.now()).slice(-10)}`;

let available = false;
let partAttempt;
let leadAttempt;
let foreignAttempt;

async function queueRow(id) {
    const { rows } = await db.query(
        `SELECT id, company_id, status, attempt_no, scheduled_at, vapi_call_id
         FROM outbound_call_attempts
         WHERE id = $1`,
        [id]
    );
    return rows[0];
}

async function cleanupCompanies(companyIds) {
    if (!companyIds.length) return;
    await db.query(
        `DELETE FROM outbound_call_attempts
         WHERE company_id = ANY($1::uuid[])`,
        [companyIds]
    );
    await db.query(
        `DELETE FROM leads
         WHERE company_id = ANY($1::uuid[])`,
        [companyIds]
    );
    await db.query(
        `DELETE FROM jobs
         WHERE company_id = ANY($1::uuid[])`,
        [companyIds]
    );
    await db.query(
        `DELETE FROM dispatch_settings
         WHERE company_id = ANY($1::uuid[])`,
        [companyIds]
    );
    await db.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
}

beforeAll(async () => {
    try {
        await db.query(
            `SELECT scenario, lead_uuid
             FROM outbound_call_attempts
             LIMIT 0`
        );
        available = true;
    } catch (error) {
        console.warn(`ROBOT-CALL-WINDOWS-001 SKIPPED-NEEDS-DB — ${error.message}`);
        return;
    }

    const stale = await db.query(
        `SELECT id FROM companies
         WHERE slug LIKE 'robot-windows-a-%' OR slug LIKE 'robot-windows-b-%'`
    );
    await cleanupCompanies(stale.rows.map(row => row.id));

    await db.query(
        `INSERT INTO companies (id, name, slug, timezone)
         VALUES ($1, $2, $3, 'America/New_York'),
                ($4, $5, $6, 'America/Los_Angeles')`,
        [
            COMPANY_A,
            `Robot windows A ${TAG}`,
            `robot-windows-a-${TAG}`,
            COMPANY_B,
            `Robot windows B ${TAG}`,
            `robot-windows-b-${TAG}`,
        ]
    );
    await db.query(
        `INSERT INTO dispatch_settings
            (company_id, timezone, work_start_time, work_end_time, work_days)
         VALUES ($1, 'America/New_York', '08:00', '18:00', '{1,2,3,4,5}'),
                ($2, 'America/Los_Angeles', '10:00', '16:00', '{1,2,3,4,5}')`,
        [COMPANY_A, COMPANY_B]
    );
    mockPartsSettingsByCompany.set(COMPANY_A, {
        max_attempts: 3,
        backoff_schedule: ['immediate', '+2h', 'next_business_morning'],
        next_morning_hour: 9,
        enabled: true,
        calling_window_mode: 'custom',
        custom_start_time: '07:00',
        custom_end_time: '21:00',
        calling_window_work_days: [0, 1, 2, 3, 4, 5, 6],
    });
    mockPartsSettingsByCompany.set(COMPANY_B, {
        max_attempts: 3,
        backoff_schedule: ['immediate', '+2h', 'next_business_morning'],
        next_morning_hour: 9,
        enabled: true,
        calling_window_mode: 'custom',
        custom_start_time: '10:00',
        custom_end_time: '16:00',
        calling_window_work_days: [1, 2, 3, 4, 5],
    });
    mockLeadSettingsByCompany.set(COMPANY_A, {
        enabled_sources: ['ProReferral'],
        max_attempts: 3,
        backoff_schedule: ['immediate', '+30m', '+2h'],
        calling_window_mode: 'custom',
        custom_start_time: '07:00',
        custom_end_time: '21:00',
        calling_window_work_days: [0, 1, 2, 3, 4, 5, 6],
    });
    mockLeadSettingsByCompany.set(COMPANY_B, {
        enabled_sources: ['ProReferral'],
        max_attempts: 3,
        backoff_schedule: ['immediate', '+30m', '+2h'],
        calling_window_mode: 'custom',
        custom_start_time: '10:00',
        custom_end_time: '16:00',
        calling_window_work_days: [1, 2, 3, 4, 5],
    });

    const jobs = await db.query(
        `INSERT INTO jobs
            (company_id, job_number, customer_name, customer_phone, blanc_status)
         VALUES ($1, $3, 'Own customer', '+16175550101', 'Part arrived'),
                ($2, $3, 'Foreign customer', '+16175550101', 'Part arrived')
         RETURNING id, company_id`,
        [COMPANY_A, COMPANY_B, `RW-${TAG}`]
    );
    const ownJob = jobs.rows.find(row => row.company_id === COMPANY_A);
    const foreignJob = jobs.rows.find(row => row.company_id === COMPANY_B);

    await db.query(
        `INSERT INTO leads
            (company_id, uuid, status, first_name, phone, job_source)
         VALUES ($1, $2, 'Submitted', 'Own lead', '+16175550102', 'ProReferral')`,
        [COMPANY_A, LEAD_UUID]
    );

    const attempts = await db.query(
        `INSERT INTO outbound_call_attempts
            (company_id, job_id, lead_uuid, scenario, phone, attempt_no, status,
             scheduled_at, slot_json)
         VALUES
            ($1, $3, NULL, 'parts_visit', '+16175550101', 1, 'dialing',
             '2026-07-20T08:30:00Z', $6::jsonb),
            ($1, NULL, $5, 'lead_call', '+16175550102', 1, 'dialing',
             '2026-07-20T08:30:00Z', NULL),
            ($2, $4, NULL, 'parts_visit', '+16175550101', 1, 'pending',
             '2026-07-20T08:30:00Z', $6::jsonb)
         RETURNING *`,
        [
            COMPANY_A,
            COMPANY_B,
            ownJob.id,
            foreignJob.id,
            LEAD_UUID,
            JSON.stringify({
                date: '2026-07-20',
                start: '09:00',
                end: '11:00',
                label: 'Monday 9–11am',
            }),
        ]
    );
    partAttempt = attempts.rows.find(row => row.company_id === COMPANY_A && row.job_id);
    leadAttempt = attempts.rows.find(row => row.company_id === COMPANY_A && row.lead_uuid);
    foreignAttempt = attempts.rows.find(row => row.company_id === COMPANY_B);

    jobsService.getJobById.mockImplementation(async (jobId, companyId) => ({
        id: jobId,
        company_id: companyId,
        blanc_status: 'Part arrived',
        zb_canceled: false,
        customer_name: 'Own customer',
        customer_phone: '+16175550101',
    }));
    leadsService.getLeadByUUID.mockResolvedValue({
        UUID: LEAD_UUID,
        Status: 'Submitted',
        LeadDateTime: null,
        JobSource: 'ProReferral',
        FirstName: 'Own',
        LastName: 'Lead',
        Phone: '+16175550102',
        PostalCode: '02108',
    });
});

afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    outboundCallService.placeCall.mockResolvedValue({
        ok: true,
        vapiCallId: 'db-window-call',
    });
});

afterAll(async () => {
    jest.useRealTimers();
    if (available) {
        try {
            await cleanupCompanies([COMPANY_A, COMPANY_B]);
        } catch (error) {
            console.warn(`ROBOT-CALL-WINDOWS-001 cleanup warning — ${error.message}`);
        }
    }
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});

test('real queue: parts caller defers the same row at night, then dials when its window opens', async () => {
    if (!available) return;
    outboundCallService.placeCall.mockResolvedValue({
        ok: true,
        vapiCallId: 'parts-window-open',
    });
    const foreignBefore = await queueRow(foreignAttempt.id);
    jest.useFakeTimers({
        now: new Date('2026-07-20T08:30:00.000Z'), // 04:30 EDT
        doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval'],
    });

    await outboundCallWorker.processAttempt(partAttempt);

    const deferred = await queueRow(partAttempt.id);
    expect(deferred).toMatchObject({ status: 'pending', attempt_no: 1 });
    expect(deferred.scheduled_at.toISOString()).toBe('2026-07-20T11:00:00.000Z');
    expect(outboundCallService.placeCall).not.toHaveBeenCalled();
    expect(await queueRow(foreignAttempt.id)).toEqual(foreignBefore);

    await db.query(
        `UPDATE outbound_call_attempts SET status = 'dialing' WHERE id = $1 AND company_id = $2`,
        [partAttempt.id, COMPANY_A]
    );
    jest.setSystemTime(new Date('2026-07-20T11:00:00.000Z')); // 07:00 EDT
    outboundCallService.placeCall.mockClear();

    await outboundCallWorker.processAttempt(partAttempt);

    expect(outboundCallService.placeCall).toHaveBeenCalledTimes(1);
    expect(await queueRow(partAttempt.id)).toMatchObject({
        status: 'dialing',
        attempt_no: 1,
        vapi_call_id: 'parts-window-open',
    });
});

test('real queue: lead caller defers the same row at night, then dials when its own window opens', async () => {
    if (!available) return;
    outboundCallService.placeCall.mockResolvedValue({
        ok: true,
        vapiCallId: 'lead-window-open',
    });
    jest.useFakeTimers({
        now: new Date('2026-07-20T10:59:00.000Z'), // 06:59 EDT
        doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval'],
    });

    await outboundLeadCallService.processLeadAttempt(leadAttempt);

    const deferred = await queueRow(leadAttempt.id);
    expect(deferred).toMatchObject({ status: 'pending', attempt_no: 1 });
    expect(deferred.scheduled_at.toISOString()).toBe('2026-07-20T11:00:00.000Z');
    expect(outboundCallService.placeCall).not.toHaveBeenCalled();
    expect(recommendSlots.run).not.toHaveBeenCalled();

    await db.query(
        `UPDATE outbound_call_attempts SET status = 'dialing' WHERE id = $1 AND company_id = $2`,
        [leadAttempt.id, COMPANY_A]
    );
    jest.setSystemTime(new Date('2026-07-20T11:00:00.000Z')); // 07:00 EDT
    outboundCallService.placeCall.mockClear();

    await outboundLeadCallService.processLeadAttempt(leadAttempt);

    expect(recommendSlots.run).toHaveBeenCalledTimes(1);
    expect(outboundCallService.placeCall).toHaveBeenCalledTimes(1);
    expect(await queueRow(leadAttempt.id)).toMatchObject({
        status: 'dialing',
        attempt_no: 1,
        vapi_call_id: 'lead-window-open',
    });
});

test('resolver keeps robot schedules independent and company-scoped', async () => {
    if (!available) return;
    mockLeadSettingsByCompany.set(COMPANY_A, {
        ...mockLeadSettingsByCompany.get(COMPANY_A),
        custom_start_time: '09:00',
    });
    const atEightEdt = new Date('2026-07-20T12:00:00.000Z');

    const partsAllowed = await agentCallWindowService.nextAllowedAt(
        COMPANY_A,
        agentCallWindowService.AGENT_KEYS.PARTS,
        atEightEdt
    );
    const leadsAllowed = await agentCallWindowService.nextAllowedAt(
        COMPANY_A,
        agentCallWindowService.AGENT_KEYS.LEADS,
        atEightEdt
    );
    const foreignParts = await agentCallWindowService.nextAllowedAt(
        COMPANY_B,
        agentCallWindowService.AGENT_KEYS.PARTS,
        atEightEdt
    );

    expect(partsAllowed).toBe(atEightEdt);
    expect(leadsAllowed.toISOString()).toBe('2026-07-20T13:00:00.000Z');
    expect(foreignParts.getTime()).toBeGreaterThan(atEightEdt.getTime());
});
