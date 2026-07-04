/**
 * MAIL-AGENT-001 — orchestrator decision logic (all deps mocked).
 * Locks: exclusion short-circuits the LLM; verdict → review row mapping;
 * task creation carries agent provenance/fields; unknown-sender branch;
 * LLM failure never throws and never creates a task.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/mailAgentQueries', () => ({
    getSettings: jest.fn(),
    ensureSettingsRow: jest.fn(),
    getEmailMessage: jest.fn(),
    hasReview: jest.fn(),
    insertReview: jest.fn().mockResolvedValue({ id: 1 }),
    createEmailContact: jest.fn(),
    listRecentInbound: jest.fn(),
}));
jest.mock('../backend/src/db/timelinesQueries', () => ({
    createTask: jest.fn(),
    setActionRequired: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/db/emailQueries', () => ({ findEmailContact: jest.fn() }));
jest.mock('../backend/src/services/realtimeService', () => ({ broadcast: jest.fn() }));
jest.mock('../backend/src/services/mailAgentClassifier', () => ({ classifyEmail: jest.fn() }));
jest.mock('../backend/src/services/email/emailTimelineService', () => ({
    linkInboundMessage: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const q = require('../backend/src/db/mailAgentQueries');
const emailQueries = require('../backend/src/db/emailQueries');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const { classifyEmail } = require('../backend/src/services/mailAgentClassifier');
const { linkInboundMessage } = require('../backend/src/services/email/emailTimelineService');
const mailAgentService = require('../backend/src/services/mailAgentService');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const MSG = {
    provider_message_id: 'gm-1',
    from_name: 'Jane Doe',
    from_email: 'jane@customer.com',
    subject: 'Dishwasher leaking again',
    body_text: 'Hi, the dishwasher you fixed last week is leaking again. Can someone come today?',
    // MAIL-AGENT-002: fresh mail — arrived well after activation (below).
    internal_at: '2026-07-03T12:00:00.000Z',
};

const SETTINGS = {
    enabled: true,
    confidence_threshold: 0.6,
    create_contact_for_unknown: true,
    assign_owner_user_id: null,
    exclusion_rules: '',
    activated_at: '2026-07-01T00:00:00.000Z',
};

function armActive(settings = SETTINGS) {
    // getActiveState: db.query → installation row; then the pinned settings row.
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    q.ensureSettingsRow.mockResolvedValue({ ...settings });
    q.getSettings.mockResolvedValue({ ...settings });
    mailAgentService.invalidateCache(COMPANY);
}

beforeEach(() => {
    jest.clearAllMocks();
    q.getEmailMessage.mockResolvedValue({ id: 42, body_text: MSG.body_text, direction: 'inbound', gmail_internal_at: MSG.internal_at });
    q.hasReview.mockResolvedValue(false);
    emailQueries.findEmailContact.mockResolvedValue(null); // MAIL-AGENT-003: default = truly unknown sender
    timelinesQueries.createTask.mockResolvedValue({ id: 777 });
});

describe('mailAgentService.reviewInboundEmail', () => {
    test('inactive app → skipped, no review row, no LLM', async () => {
        db.query.mockResolvedValue({ rows: [] }); // no installation
        mailAgentService.invalidateCache(COMPANY);
        const res = await mailAgentService.reviewInboundEmail(COMPANY, MSG, {});
        expect(res).toEqual({ skipped: 'inactive' });
        expect(classifyEmail).not.toHaveBeenCalled();
        expect(q.insertReview).not.toHaveBeenCalled();
    });

    test('already reviewed → dedup skip, no LLM', async () => {
        armActive();
        q.hasReview.mockResolvedValue(true);
        const res = await mailAgentService.reviewInboundEmail(COMPANY, MSG, { timelineId: 5 });
        expect(res).toEqual({ skipped: 'already_reviewed' });
        expect(classifyEmail).not.toHaveBeenCalled();
    });

    test('exclusion rule match → skipped_excluded review, LLM never called', async () => {
        armActive({ ...SETTINGS, exclusion_rules: 'from:@customer.com' });
        const res = await mailAgentService.reviewInboundEmail(COMPANY, MSG, { timelineId: 5 });
        expect(res.verdict).toBe('skipped_excluded');
        expect(classifyEmail).not.toHaveBeenCalled();
        expect(q.insertReview).toHaveBeenCalledWith(expect.objectContaining({
            verdict: 'skipped_excluded', ruleLine: 1, emailMessageId: 42,
        }));
        expect(timelinesQueries.createTask).not.toHaveBeenCalled();
    });

    test('needs_attention above threshold → agent task + AR + task_created review', async () => {
        armActive();
        classifyEmail.mockResolvedValue({
            verdict: {
                needs_attention: true, category: 'customer_request', confidence: 0.92,
                priority: 'p1', reason: 'Existing customer reports a recurring leak.',
                task_title: 'Call Jane about the leaking dishwasher',
            },
            model: 'gemini-test', latency_ms: 400,
        });
        const res = await mailAgentService.reviewInboundEmail(COMPANY, MSG, {
            contactId: 9, timelineId: 5, contactName: 'Jane Doe',
        });
        expect(res).toEqual({ verdict: 'task_created', taskId: 777 });
        expect(timelinesQueries.createTask).toHaveBeenCalledWith(expect.objectContaining({
            companyId: COMPANY,
            threadId: 5,
            subjectId: 9,
            createdBy: 'agent',
            agentType: 'mail_secretary',
            priority: 'p1',
            agentOutput: expect.objectContaining({ category: 'customer_request', confidence: 0.92 }),
            agentStatus: 'succeeded',
        }));
        expect(timelinesQueries.setActionRequired).toHaveBeenCalledWith(5, 'new_message', 'system');
        expect(q.insertReview).toHaveBeenCalledWith(expect.objectContaining({
            verdict: 'task_created', taskId: 777,
        }));
    });

    test('needs_attention below threshold → skipped_low_confidence, no task', async () => {
        armActive();
        classifyEmail.mockResolvedValue({
            verdict: { needs_attention: true, category: 'other', confidence: 0.4, priority: 'p2', reason: 'r', task_title: 't' },
            model: 'm', latency_ms: 1,
        });
        const res = await mailAgentService.reviewInboundEmail(COMPANY, MSG, { timelineId: 5 });
        expect(res.verdict).toBe('skipped_low_confidence');
        expect(timelinesQueries.createTask).not.toHaveBeenCalled();
    });

    test('no attention → skipped_no_attention, no task', async () => {
        armActive();
        classifyEmail.mockResolvedValue({
            verdict: { needs_attention: false, category: 'newsletter', confidence: 0.97, priority: 'p2', reason: 'Marketing blast.', task_title: '' },
            model: 'm', latency_ms: 1,
        });
        const res = await mailAgentService.reviewInboundEmail(COMPANY, MSG, { timelineId: 5 });
        expect(res.verdict).toBe('skipped_no_attention');
        expect(timelinesQueries.createTask).not.toHaveBeenCalled();
    });

    test('unknown sender + creation enabled → contact created, canonical re-link, task on new timeline', async () => {
        armActive();
        classifyEmail.mockResolvedValue({
            verdict: { needs_attention: true, category: 'potential_lead', confidence: 0.8, priority: 'p2', reason: 'New customer asks for a quote.', task_title: 'Quote request from Jane' },
            model: 'm', latency_ms: 1,
        });
        q.createEmailContact.mockResolvedValue({ id: 31 });
        linkInboundMessage.mockResolvedValue({ linked: true, contactId: 31, timelineId: 88 });

        const res = await mailAgentService.reviewInboundEmail(COMPANY, MSG, { noContact: true });
        expect(q.createEmailContact).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ fromEmail: MSG.from_email }));
        expect(linkInboundMessage).toHaveBeenCalledWith(COMPANY, MSG, { skipAgent: true });
        expect(timelinesQueries.createTask).toHaveBeenCalledWith(expect.objectContaining({ threadId: 88, subjectId: 31 }));
        expect(res.verdict).toBe('task_created');
    });

    test('MAIL-AGENT-003: stale noContact ctx but contact already exists → find-or-create, no duplicate', async () => {
        armActive();
        classifyEmail.mockResolvedValue({
            verdict: { needs_attention: true, category: 'potential_lead', confidence: 0.8, priority: 'p2', reason: 'r', task_title: 't' },
            model: 'm', latency_ms: 1,
        });
        emailQueries.findEmailContact.mockResolvedValue({ contact_id: 31 }); // already exists
        linkInboundMessage.mockResolvedValue({ linked: true, contactId: 31, timelineId: 88 });

        const res = await mailAgentService.reviewInboundEmail(COMPANY, MSG, { noContact: true });
        expect(q.createEmailContact).not.toHaveBeenCalled();
        expect(linkInboundMessage).toHaveBeenCalledWith(COMPANY, MSG, { skipAgent: true });
        expect(res.verdict).toBe('task_created');
        expect(timelinesQueries.createTask).toHaveBeenCalledWith(expect.objectContaining({ threadId: 88 }));
    });

    test('unknown sender + creation disabled → skipped_unknown_sender, no contact/task', async () => {
        armActive({ ...SETTINGS, create_contact_for_unknown: false });
        classifyEmail.mockResolvedValue({
            verdict: { needs_attention: true, category: 'potential_lead', confidence: 0.9, priority: 'p2', reason: 'r', task_title: 't' },
            model: 'm', latency_ms: 1,
        });
        const res = await mailAgentService.reviewInboundEmail(COMPANY, MSG, { noContact: true });
        expect(res.verdict).toBe('skipped_unknown_sender');
        expect(q.createEmailContact).not.toHaveBeenCalled();
        expect(timelinesQueries.createTask).not.toHaveBeenCalled();
    });

    test('MAIL-AGENT-002: email older than activation → silent historical skip, no LLM, no review row', async () => {
        armActive();
        const oldMsg = { ...MSG, internal_at: '2026-01-15T10:00:00.000Z' };
        const res = await mailAgentService.reviewInboundEmail(COMPANY, oldMsg, { timelineId: 5 });
        expect(res).toEqual({ skipped: 'historical' });
        expect(classifyEmail).not.toHaveBeenCalled();
        expect(q.insertReview).not.toHaveBeenCalled();
        expect(timelinesQueries.createTask).not.toHaveBeenCalled();
    });

    test('MAIL-AGENT-002: missing email date → conservative historical skip', async () => {
        armActive();
        q.getEmailMessage.mockResolvedValue({ id: 42, body_text: 'x', direction: 'inbound', gmail_internal_at: null });
        const res = await mailAgentService.reviewInboundEmail(COMPANY, { ...MSG, internal_at: null }, { timelineId: 5 });
        expect(res).toEqual({ skipped: 'historical' });
        expect(classifyEmail).not.toHaveBeenCalled();
    });

    test('MAIL-AGENT-002: outbound and draft pushes never reach the LLM', async () => {
        armActive();
        const out = await mailAgentService.reviewInboundEmail(COMPANY, { ...MSG, is_outbound: true }, { timelineId: 5 });
        expect(out).toEqual({ skipped: 'outbound' });
        const draft = await mailAgentService.reviewInboundEmail(COMPANY, { ...MSG, labelIds: ['DRAFT'] }, { timelineId: 5 });
        expect(draft).toEqual({ skipped: 'draft_or_sent' });
        q.getEmailMessage.mockResolvedValue({ id: 42, body_text: 'x', direction: 'outbound', gmail_internal_at: MSG.internal_at });
        const rowDir = await mailAgentService.reviewInboundEmail(COMPANY, MSG, { timelineId: 5 });
        expect(rowDir).toEqual({ skipped: 'not_inbound' });
        expect(classifyEmail).not.toHaveBeenCalled();
        expect(q.insertReview).not.toHaveBeenCalled();
    });

    test('LLM failure → verdict error, no task, never throws', async () => {
        armActive();
        classifyEmail.mockRejectedValue(new Error('Gemini timeout'));
        const res = await mailAgentService.reviewInboundEmail(COMPANY, MSG, { timelineId: 5 });
        expect(res.verdict).toBe('error');
        expect(timelinesQueries.createTask).not.toHaveBeenCalled();
        expect(q.insertReview).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'error' }));
    });
});
