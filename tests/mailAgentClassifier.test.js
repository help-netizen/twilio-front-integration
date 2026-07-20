'use strict';

const mockGenerateJson = jest.fn();
jest.mock('../backend/src/services/llm/jsonLlmClient', () => ({
    generateJson: mockGenerateJson,
}));

describe('Mail Secretary wrapper after provider-neutral extraction', () => {
    const original = { ...process.env };

    beforeEach(() => {
        jest.resetModules();
        mockGenerateJson.mockReset();
        process.env.MAIL_AGENT_PROVIDER = 'ollama';
        process.env.MAIL_AGENT_OLLAMA_MODEL = 'mail-qwen';
        process.env.INSPECTOR_AGENT_PROVIDER = 'gemini';
    });

    afterAll(() => {
        process.env = original;
    });

    test('SAB-INSP-MAIL-REGRESSION: Mail owns provider selection and preserves verdict normalization', async () => {
        mockGenerateJson.mockResolvedValue({
            json: {
                needs_attention: true,
                category: 'customer_request',
                confidence: 0.91,
                priority: 'p1',
                reason: 'Customer needs a reply.',
                task_title: 'Reply to customer',
            },
            model: 'mail-qwen',
            latency_ms: 12,
        });
        const { classifyEmail } = require('../backend/src/services/mailAgentClassifier');
        const result = await classifyEmail({
            fromName: 'Jane', fromEmail: 'jane@example.com', subject: 'Help', bodyText: 'Please call.',
        });
        expect(mockGenerateJson).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'ollama', primaryModel: 'mail-qwen', allowModelFallbackOn429: true,
        }));
        expect(result).toEqual({
            verdict: {
                needs_attention: true,
                category: 'customer_request',
                confidence: 0.91,
                priority: 'p1',
                reason: 'Customer needs a reply.',
                task_title: 'Reply to customer',
            },
            model: 'mail-qwen',
            latency_ms: 12,
        });
    });
});
