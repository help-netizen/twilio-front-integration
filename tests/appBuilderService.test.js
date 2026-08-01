'use strict';

const {
    AppBuilderError,
    createAppBuilderService,
} = require('../backend/src/services/appBuilderService');

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const CHAT_ID = '30000000-0000-4000-8000-000000000001';
const VERSION_ID = '40000000-0000-4000-8000-000000000001';
const SAFE_SOURCE = `export async function run(ctx) {
    const tasks = await ctx.callTool('svc.list_tasks', { limit: 10 });
    return { count: tasks.tasks.length };
}`;

function harness(overrides = {}) {
    const repository = {
        createChat: jest.fn(),
        listChats: jest.fn(),
        getMessages: jest.fn(),
        listVersions: jest.fn(),
        appendUserMessage: jest.fn().mockResolvedValue({}),
        reserveDailyGeneration: jest.fn().mockResolvedValue({ generations_used: 1 }),
        getGenerationContext: jest.fn().mockResolvedValue({
            id: CHAT_ID,
            app_id: '77',
            current_source: null,
            history: [{ role: 'user', text: 'Build a task counter.' }],
        }),
        persistFailure: jest.fn().mockResolvedValue({
            id: 'failed-message',
            role: 'assistant',
            text: 'Rejected.',
            version_id: null,
        }),
        persistSuccess: jest.fn().mockResolvedValue({
            app_id: '77',
            version: {
                id: VERSION_ID,
                source_sha256: 'a'.repeat(64),
                tools: ['svc.list_tasks'],
                status: 'draft',
            },
            message: {
                id: 'success-message',
                role: 'assistant',
                text: 'Counts open tasks.',
                version_id: VERSION_ID,
            },
        }),
        ...overrides.repository,
    };
    const provider = {
        generate: jest.fn().mockResolvedValue({
            source: SAFE_SOURCE,
            description: 'Counts open tasks.',
            model: 'builder-test-model',
            token_usage: { input_tokens: 20, output_tokens: 30, total_tokens: 50 },
        }),
        ...overrides.provider,
    };
    const dryRunner = {
        validateAndDryRun: jest.fn().mockResolvedValue({
            source_bytes: Buffer.byteLength(SAFE_SOURCE),
            tools: ['svc.list_tasks'],
            entry_point: 'run',
            returned_type: 'object',
        }),
        ...overrides.dryRunner,
    };
    const service = createAppBuilderService({
        repository,
        provider,
        dryRunner,
        randomUUID: () => '50000000-0000-4000-8000-000000000001',
    });
    return { repository, provider, dryRunner, service };
}

describe('APP-BUILD-001 generation pipeline', () => {
    test('a valid generation is saved only after static validation and isolated dry run', async () => {
        const { repository, provider, dryRunner, service } = harness();
        const result = await service.generateMessage({
            companyId: COMPANY_ID,
            actorId: ACTOR_ID,
            chatId: CHAT_ID,
            text: 'Build a task counter.',
            requestId: 'req-success',
        });

        expect(result).toMatchObject({
            generation_status: 'created',
            app_id: '77',
            version: { id: VERSION_ID, status: 'draft' },
        });
        expect(provider.generate).toHaveBeenCalledTimes(1);
        expect(dryRunner.validateAndDryRun).toHaveBeenCalledWith({ source: SAFE_SOURCE });
        expect(repository.persistSuccess).toHaveBeenCalledWith(expect.objectContaining({
            companyId: COMPANY_ID,
            actorId: ACTOR_ID,
            chatId: CHAT_ID,
            source: SAFE_SOURCE,
            tools: ['svc.list_tasks'],
            scannerReport: expect.objectContaining({ parsed: true, dry_run: { ok: true, returned_type: 'object' } }),
        }));
        expect(dryRunner.validateAndDryRun.mock.invocationCallOrder[0])
            .toBeLessThan(repository.persistSuccess.mock.invocationCallOrder[0]);
        expect(repository.persistFailure).not.toHaveBeenCalled();
    });

    test.each([
        'FORBIDDEN_IDENTIFIER',
        'ENTRY_POINT_INVALID',
        'SOURCE_TOO_LARGE',
        'UNKNOWN_TOOL',
        'APP_RUNTIME_CPU_LIMIT',
    ])('%s rejects the draft and never creates a version', async code => {
        const { repository, dryRunner, service } = harness({
            dryRunner: {
                validateAndDryRun: jest.fn().mockRejectedValue(Object.assign(
                    new Error('rejected'),
                    { code }
                )),
            },
        });
        const result = await service.generateMessage({
            companyId: COMPANY_ID,
            actorId: ACTOR_ID,
            chatId: CHAT_ID,
            text: 'Generate it.',
        });

        expect(result).toMatchObject({
            generation_status: 'failed',
            version: null,
            error: { code },
        });
        expect(dryRunner.validateAndDryRun).toHaveBeenCalledTimes(1);
        expect(repository.persistSuccess).not.toHaveBeenCalled();
        expect(repository.persistFailure).toHaveBeenCalledWith(expect.objectContaining({
            companyId: COMPANY_ID,
            errorCode: code,
        }));
    });

    test('scrubs bearer tokens and api-key values before storage and before the LLM prompt', async () => {
        const { repository, provider, service } = harness();
        await service.generateMessage({
            companyId: COMPANY_ID,
            actorId: ACTOR_ID,
            chatId: CHAT_ID,
            text: 'Use Bearer abcdefghijklmnopqrstuvwxyz. api-key=supersecret-api-value',
        });

        const stored = repository.appendUserMessage.mock.calls[0][3];
        expect(stored).toContain('[REDACTED_BEARER_TOKEN]');
        expect(stored).toContain('[REDACTED_API_KEY]');
        expect(stored).not.toContain('abcdefghijklmnopqrstuvwxyz');
        expect(stored).not.toContain('supersecret-api-value');
        const prompt = provider.generate.mock.calls[0][0];
        expect(prompt).not.toContain('abcdefghijklmnopqrstuvwxyz');
        expect(prompt).not.toContain('supersecret-api-value');
    });

    test('F3 scrubs PII before storage and re-scrubs legacy history before model use', async () => {
        const rawPii = [
            'customer@example.com',
            '+16175550101',
            '(617) 555-0102',
            '9988776655443322',
        ];
        const { repository, provider, service } = harness({
            repository: {
                getGenerationContext: jest.fn().mockResolvedValue({
                    id: CHAT_ID,
                    app_id: '77',
                    current_source: null,
                    history: [{ role: 'user', text: `Legacy ${rawPii.join(' ')}` }],
                }),
            },
        });
        await service.generateMessage({
            companyId: COMPANY_ID,
            actorId: ACTOR_ID,
            chatId: CHAT_ID,
            text: `New ${rawPii.join(' ')}`,
        });

        const stored = repository.appendUserMessage.mock.calls[0][3];
        const prompt = provider.generate.mock.calls[0][0];
        for (const value of rawPii) {
            expect(stored).not.toContain(value);
            expect(prompt).not.toContain(value);
        }
        expect(stored).toMatch(/REDACTED_(EMAIL|PHONE|NUMBER)/);
        expect(prompt).toMatch(/REDACTED_(EMAIL|PHONE|NUMBER)/);
    });

    test('SAB APP-BUILD-001 quota gate: exhausted quota returns 429 without invoking the LLM', async () => {
        const { repository, provider, dryRunner, service } = harness({
            repository: { reserveDailyGeneration: jest.fn().mockResolvedValue(null) },
        });

        await expect(service.generateMessage({
            companyId: COMPANY_ID,
            actorId: ACTOR_ID,
            chatId: CHAT_ID,
            text: 'Generate one more.',
        })).rejects.toMatchObject({
            code: 'GENERATION_QUOTA_EXCEEDED',
            httpStatus: 429,
            botMessage: expect.objectContaining({ version_id: null }),
        });
        expect(provider.generate).not.toHaveBeenCalled();
        expect(dryRunner.validateAndDryRun).not.toHaveBeenCalled();
        expect(repository.getGenerationContext).not.toHaveBeenCalled();
        expect(repository.persistSuccess).not.toHaveBeenCalled();
        expect(repository.persistFailure).toHaveBeenCalledWith(expect.objectContaining({
            errorCode: 'GENERATION_QUOTA_EXCEEDED',
        }));
    });

    test('new chats accept no app id and invalid app ids fail before repository access', async () => {
        const { repository, service } = harness();
        repository.createChat.mockResolvedValue({ id: CHAT_ID, app_id: null, title: 'New app' });
        await expect(service.createChat(COMPANY_ID, ACTOR_ID, {})).resolves.toMatchObject({
            app_id: null,
        });
        expect(repository.createChat).toHaveBeenCalledWith(COMPANY_ID, ACTOR_ID, {
            appId: null,
            title: 'New app',
        });
        await expect(service.createChat(COMPANY_ID, ACTOR_ID, { app_id: 'foreign' }))
            .rejects.toBeInstanceOf(AppBuilderError);
        expect(repository.createChat).toHaveBeenCalledTimes(1);
    });
});
