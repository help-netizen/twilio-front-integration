'use strict';

const {
    JsonLlmError,
    createPacedQueue,
    generateJson,
    parseJsonText,
    parseRetryAfter,
} = require('../backend/src/services/llm/jsonLlmClient');

function response({ status = 200, json = {}, retryAfter = null } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: key => key.toLowerCase() === 'retry-after' ? retryAfter : null },
        json: jest.fn().mockResolvedValue(json),
    };
}

describe('provider-neutral JSON LLM client', () => {
    function pacedOptions(overrides = {}) {
        return {
            provider: 'gemini',
            apiKey: 'x',
            primaryModel: 'm',
            userPrompt: 'x',
            rateLimit: {
                queue: createPacedQueue(),
                minIntervalMs: 0,
                maxAttempts: 4,
                baseBackoffMs: 100,
                maxBackoffMs: 1000,
            },
            ...overrides,
        };
    }

    test('Gemini sends separate system/user prompts and returns strict JSON metadata', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(response({
            json: {
                candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
                usageMetadata: { promptTokenCount: 9 },
            },
        }));
        const result = await generateJson({
            provider: 'gemini',
            apiKey: 'secret',
            primaryModel: 'gemini-test',
            systemPrompt: 'policy',
            userPrompt: 'evidence',
            maxRetries: 0,
            fetchImpl,
        });
        expect(result.json).toEqual({ ok: true });
        expect(result.model).toBe('gemini-test');
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(body.systemInstruction.parts[0].text).toBe('policy');
        expect(body.contents[0].parts[0].text).toBe('evidence');
        // REGRESSION: Gemini 2.5 thinking must be disabled or it spends maxOutputTokens
        // on thoughts and truncates the JSON (finishReason=MAX_TOKENS → bad_json).
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    });

    test('REGRESSION bad_json: thinkingBudget defaults to 0 and is overridable', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(response({
            json: { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] },
        }));
        await generateJson({
            provider: 'gemini', apiKey: 'secret', primaryModel: 'gemini-test',
            userPrompt: 'x', maxRetries: 0, thinkingBudget: 256, fetchImpl,
        });
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(256);
    });

    test('retries a transient response without recording provider bodies', async () => {
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(response({ status: 503 }))
            .mockResolvedValueOnce(response({
                json: { candidates: [{ content: { parts: [{ text: '```json\n{"ok":true}\n```' }] } }] },
            }));
        await expect(generateJson({
            provider: 'gemini', apiKey: 'x', primaryModel: 'm', userPrompt: 'x',
            maxRetries: 1, backoffMs: [0], sleepImpl: async () => {}, fetchImpl,
        })).resolves.toMatchObject({ json: { ok: true } });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    test('SAB-INSP-SPEND-CAP: typed 429 stops model fallback when disabled', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(response({ status: 429, retryAfter: '60' }));
        await expect(generateJson({
            provider: 'gemini', apiKey: 'x', primaryModel: 'm1', fallbackModel: 'm2',
            userPrompt: 'x', maxRetries: 0, allowModelFallbackOn429: false, fetchImpl,
        })).rejects.toMatchObject({
            name: 'JsonLlmError', code: 'rate_limited', status: 429, retryAfterMs: 60000,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    test('Ollama transport parses its JSON-string response', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(response({ json: { response: '{"ok":true}' } }));
        const result = await generateJson({
            provider: 'ollama', primaryModel: 'qwen', userPrompt: 'x', maxRetries: 0, fetchImpl,
        });
        expect(result).toMatchObject({ provider: 'ollama', model: 'qwen', json: { ok: true } });
    });

    test('bad JSON is typed and helper parsing stays bounded', async () => {
        expect(() => parseJsonText('[]')).toThrow(JsonLlmError);
        expect(parseRetryAfter('2')).toBe(2000);
        const fetchImpl = jest.fn().mockResolvedValue(response({
            json: { candidates: [{ content: { parts: [{ text: 'not-json' }] } }] },
        }));
        await expect(generateJson({
            provider: 'gemini', apiKey: 'x', primaryModel: 'm', userPrompt: 'x',
            maxRetries: 0, fetchImpl,
        })).rejects.toMatchObject({ code: 'bad_json' });
    });

    test('SAB-INSP-LLM-PACING: queued calls are single-flight and request starts are spaced', async () => {
        const queue = createPacedQueue();
        const startTimes = [];
        let nowMs = 0;
        let inFlight = 0;
        let maxInFlight = 0;
        const fetchImpl = jest.fn(async () => {
            startTimes.push(nowMs);
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Promise.resolve();
            inFlight--;
            return response({
                json: { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] },
            });
        });
        const options = pacedOptions({
            fetchImpl,
            nowImpl: () => nowMs,
            sleepImpl: async delayMs => {
                nowMs += delayMs;
            },
            rateLimit: {
                queue,
                minIntervalMs: 100,
                maxAttempts: 1,
                baseBackoffMs: 100,
                maxBackoffMs: 1000,
            },
        });

        await Promise.all([generateJson(options), generateJson(options)]);

        expect(startTimes).toEqual([0, 100]);
        expect(maxInFlight).toBe(1);
    });

    test('SAB-INSP-LLM-BACKOFF: retries grow exponentially and honor larger Retry-After', async () => {
        const sleeps = [];
        let nowMs = 0;
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(response({ status: 429 }))
            .mockResolvedValueOnce(response({ status: 503, retryAfter: '0.35' }))
            .mockResolvedValueOnce(response({ status: 504 }))
            .mockResolvedValueOnce(response({
                json: { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] },
            }));

        await expect(generateJson(pacedOptions({
            fetchImpl,
            allowModelFallbackOn429: true,
            nowImpl: () => nowMs,
            randomImpl: () => 0,
            sleepImpl: async delayMs => {
                sleeps.push(delayMs);
                nowMs += delayMs;
            },
        }))).resolves.toMatchObject({ json: { ok: true } });

        expect(sleeps).toEqual([100, 350, 400]);
        expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    test('paced retry max-attempts is a ceiling across model fallback', async () => {
        const sleeps = [];
        const fetchImpl = jest.fn().mockResolvedValue(response({ status: 503 }));

        await expect(generateJson(pacedOptions({
            fallbackModel: 'm2',
            fetchImpl,
            randomImpl: () => 0,
            sleepImpl: async delayMs => sleeps.push(delayMs),
            rateLimit: {
                queue: createPacedQueue(),
                minIntervalMs: 0,
                maxAttempts: 3,
                baseBackoffMs: 50,
                maxBackoffMs: 1000,
            },
        }))).rejects.toMatchObject({ status: 503, retryable: true });

        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(sleeps).toEqual([50, 100]);
    });

    test('SAB-INSP-SPEND-CAP: paced Inspector policy stops on the first 429', async () => {
        const sleepImpl = jest.fn();
        const fetchImpl = jest.fn().mockResolvedValue(response({ status: 429, retryAfter: '60' }));

        await expect(generateJson(pacedOptions({
            fetchImpl,
            sleepImpl,
            allowModelFallbackOn429: false,
        }))).rejects.toMatchObject({
            code: 'rate_limited', status: 429, retryAfterMs: 60000,
        });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(sleepImpl).not.toHaveBeenCalled();
    });
});
