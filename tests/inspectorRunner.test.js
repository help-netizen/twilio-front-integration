'use strict';

const { JsonLlmError } = require('../backend/src/services/llm/jsonLlmClient');
const { runCompany } = require('../backend/src/services/inspectorRunner');

const COMPANY = '11111111-1111-1111-1111-111111111111';

function candidate(id = 1) {
    return { id, company_id: COMPANY, status: 'Submitted' };
}

function context(id = 1) {
    return {
        entity_type: 'job',
        entity: { id, status: 'Submitted', notes: [{ text: 'secret-customer-note' }] },
        notes: [{ text: 'secret-customer-note' }],
        communications: { calls: [], sms: [], emails: [] },
        finance: {},
    };
}

function dependencies(jobRows = [candidate()]) {
    const queries = {
        getRuntimeConfiguration: jest.fn().mockResolvedValue({
            enabled: true,
            ignored_job_statuses: ['Canceled'],
            ignored_lead_statuses: ['Lost'],
            instruction: 'Review carefully.',
        }),
        listCandidateJobs: jest.fn().mockResolvedValue(jobRows),
        listCandidateLeads: jest.fn().mockResolvedValue([]),
        refreshRunLease: jest.fn().mockResolvedValue(true),
        getOpenInspectorTask: jest.fn().mockResolvedValue(null),
        reloadEligibleEntity: jest.fn().mockResolvedValue({ id: 1, contact_id: null }),
        getEntityRecord: jest.fn().mockResolvedValue({ id: 1 }),
        getEntityContext: jest.fn().mockImplementation((_company, _type, id) => context(id)),
        insertReview: jest.fn().mockImplementation(async (_company, review) => review),
        finishRun: jest.fn().mockResolvedValue({}),
    };
    const classifier = {
        classifyEntity: jest.fn(),
        isSpendCapError: jest.fn().mockReturnValue(false),
    };
    const taskService = { createInspectorTask: jest.fn() };
    return { queries, classifier, taskService, now: () => new Date('2026-07-20T17:00:00.000Z') };
}

const CLAIM = {
    companyId: COMPANY,
    runId: 10,
    timezone: 'America/New_York',
    companyLocalDate: '2026-07-20',
    startedAt: new Date('2026-07-20T16:00:00.000Z'),
};

describe('Inspector company runner', () => {
    test.each(['Marketplace disconnect', 'company deactivation'])(
        'SAB-INSP-RUNTIME-GATE: %s after selection aborts the claimed run with zero tasks',
        async () => {
            const deps = dependencies();
            deps.queries.getRuntimeConfiguration.mockResolvedValue(null);
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const result = await runCompany(CLAIM, deps);
            warn.mockRestore();
            expect(result).toMatchObject({
                aborted: true,
                candidate_count: 0,
                reviewed_count: 0,
                task_count: 0,
            });
            expect(deps.queries.listCandidateJobs).not.toHaveBeenCalled();
            expect(deps.queries.listCandidateLeads).not.toHaveBeenCalled();
            expect(deps.classifier.classifyEntity).not.toHaveBeenCalled();
            expect(deps.taskService.createInspectorTask).not.toHaveBeenCalled();
            expect(deps.queries.finishRun).toHaveBeenCalledWith(
                COMPANY,
                10,
                expect.objectContaining({
                    status: 'aborted',
                    warning_code: 'runtime_authorization_revoked',
                    task_count: 0,
                })
            );
        }
    );

    test('no-action verdict records review and creates no task', async () => {
        const deps = dependencies();
        deps.classifier.classifyEntity.mockResolvedValue({
            verdict: {
                needs_attention: false, confidence: 0.9, reason: 'Future ETA remains current.',
                task_title: '', task_description: '',
            },
            provider: 'gemini', model: 'm', latency_ms: 1, token_usage: {},
        });
        const result = await runCompany(CLAIM, deps);
        expect(result).toMatchObject({ reviewed_count: 1, no_action_count: 1, task_count: 0 });
        expect(deps.classifier.classifyEntity).toHaveBeenCalledWith(
            expect.objectContaining({ company_local_date: '2026-07-20' }),
            'Review carefully.'
        );
        expect(deps.queries.insertReview).toHaveBeenCalledWith(
            COMPANY,
            expect.objectContaining({ verdict: 'no_action', entity_id: 1 })
        );
        expect(deps.taskService.createInspectorTask).not.toHaveBeenCalled();
    });

    test('action verdict delegates one transactional task creation', async () => {
        const deps = dependencies();
        const modelResult = {
            verdict: {
                needs_attention: true, confidence: 0.9, reason: 'Gap.',
                task_title: 'Verify Job 1', task_description: 'Check the missing payment.',
            },
            provider: 'gemini', model: 'm', latency_ms: 1, token_usage: {},
        };
        deps.classifier.classifyEntity.mockResolvedValue(modelResult);
        deps.taskService.createInspectorTask.mockResolvedValue({ status: 'created', task: { id: 8 } });
        const result = await runCompany(CLAIM, deps);
        expect(result.task_count).toBe(1);
        expect(deps.taskService.createInspectorTask).toHaveBeenCalledWith(expect.objectContaining({
            companyId: COMPANY, entityType: 'job', entityId: 1, verdict: modelResult.verdict,
        }));
    });

    test('SAB-INSP-PROVIDER-SAFE-FAIL + SAB-INSP-LOG-PII: provider failure skips safely and warning excludes record text', async () => {
        const deps = dependencies();
        deps.classifier.classifyEntity.mockRejectedValue(
            new JsonLlmError('provider body secret-customer-note', {
                code: 'network_error', provider: 'gemini', model: 'm',
            })
        );
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await runCompany(CLAIM, deps);
        expect(result).toMatchObject({ warning_count: 1, task_count: 0 });
        expect(deps.taskService.createInspectorTask).not.toHaveBeenCalled();
        expect(deps.queries.finishRun).toHaveBeenCalledWith(
            COMPANY,
            10,
            expect.objectContaining({ status: 'completed_with_warnings' })
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-customer-note');
        warn.mockRestore();
        expect(result.spend_cap).toBe(false);
    });

    test('SAB-INSP-SPEND-CAP: first 429 records warning, stops remaining entities, and resolves', async () => {
        const deps = dependencies([candidate(1), candidate(2)]);
        const error = new JsonLlmError('rate limited', {
            code: 'rate_limited', provider: 'gemini', model: 'm', status: 429, retryAfterMs: 60000,
        });
        deps.classifier.classifyEntity.mockRejectedValue(error);
        deps.classifier.isSpendCapError.mockReturnValue(true);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await runCompany(CLAIM, deps);
        warn.mockRestore();
        expect(deps.classifier.classifyEntity).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ spend_cap: true, retry_after_ms: 60000, warning_count: 1 });
        expect(deps.queries.finishRun).toHaveBeenCalledWith(
            COMPANY,
            10,
            expect.objectContaining({ status: 'completed_with_warnings' })
        );
    });

    test('open Inspector task recheck suppresses the LLM call', async () => {
        const deps = dependencies();
        deps.queries.getOpenInspectorTask.mockResolvedValue({ id: 99, status: 'open' });
        const result = await runCompany(CLAIM, deps);
        expect(deps.classifier.classifyEntity).not.toHaveBeenCalled();
        expect(result.deduped_count).toBe(1);
    });
});
