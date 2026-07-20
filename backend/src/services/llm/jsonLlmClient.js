'use strict';

/**
 * Provider-neutral JSON LLM transport.
 *
 * Feature wrappers own environment variables, provider selection, prompts, and
 * verdict validation. This module only owns bounded HTTP retry/timeout/model
 * fallback and strict JSON extraction. It never logs request or response text.
 */

const DEFAULT_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

class JsonLlmError extends Error {
    constructor(message, {
        code = 'provider_error',
        provider = null,
        model = null,
        status = null,
        retryAfterMs = null,
        retryable = false,
        cause = null,
    } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'JsonLlmError';
        this.code = code;
        this.provider = provider;
        this.model = model;
        this.status = status;
        this.retryAfterMs = retryAfterMs;
        this.retryable = retryable;
    }
}

function boundedInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function parseRetryAfter(value, nowMs = Date.now()) {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
    const dateMs = Date.parse(value);
    return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}

function parseJsonText(rawOutput) {
    let cleaned = String(rawOutput || '').trim();
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }
    if (!cleaned) throw new JsonLlmError('Provider returned no JSON.', { code: 'empty_response' });
    try {
        const parsed = JSON.parse(cleaned);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('root must be an object');
        }
        return parsed;
    } catch (error) {
        if (error instanceof JsonLlmError) throw error;
        throw new JsonLlmError('Provider returned invalid JSON.', {
            code: 'bad_json',
            cause: error,
        });
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function modelList(primaryModel, fallbackModel) {
    return [...new Set([primaryModel, fallbackModel].map(value => String(value || '').trim()).filter(Boolean))];
}

async function requestWithTimeout(url, init, timeoutMs, fetchImpl) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

function httpError(provider, model, response) {
    const status = Number(response.status) || null;
    return new JsonLlmError(`${provider} ${model} HTTP ${status || 'error'}.`, {
        code: status === 429 ? 'rate_limited' : 'http_error',
        provider,
        model,
        status,
        retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after')),
        retryable: DEFAULT_RETRY_STATUSES.has(status),
    });
}

async function readGeminiResponse(response, provider, model) {
    let data;
    try {
        data = await response.json();
    } catch (error) {
        throw new JsonLlmError(`${provider} ${model} returned an unreadable response.`, {
            code: 'bad_response', provider, model, cause: error,
        });
    }
    const rawOutput = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawOutput) {
        throw new JsonLlmError(`${provider} ${model} returned no content.`, {
            code: 'empty_response', provider, model,
        });
    }
    return {
        json: parseJsonText(rawOutput),
        usage: data?.usageMetadata || {},
    };
}

async function readOllamaResponse(response, provider, model) {
    let data;
    try {
        data = await response.json();
    } catch (error) {
        throw new JsonLlmError(`${provider} ${model} returned an unreadable response.`, {
            code: 'bad_response', provider, model, cause: error,
        });
    }
    if (!data?.response) {
        throw new JsonLlmError(`${provider} ${model} returned no content.`, {
            code: 'empty_response', provider, model,
        });
    }
    return {
        json: parseJsonText(data.response),
        usage: {
            prompt_tokens: data.prompt_eval_count ?? null,
            output_tokens: data.eval_count ?? null,
        },
    };
}

function buildRequest(provider, model, options) {
    if (provider === 'gemini') {
        if (!options.apiKey) {
            throw new JsonLlmError('Gemini API key is not configured.', {
                code: 'not_configured', provider, model,
            });
        }
        const baseUrl = String(options.baseUrl || 'https://generativelanguage.googleapis.com/v1beta')
            .replace(/\/+$/, '');
        return {
            url: `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(options.apiKey)}`,
            init: {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    systemInstruction: options.systemPrompt
                        ? { parts: [{ text: options.systemPrompt }] }
                        : undefined,
                    contents: [{ role: 'user', parts: [{ text: options.userPrompt }] }],
                    generationConfig: {
                        temperature: options.temperature,
                        maxOutputTokens: options.maxOutputTokens,
                        candidateCount: 1,
                        responseMimeType: 'application/json',
                        // Gemini 2.5 "thinking" spends maxOutputTokens BEFORE emitting the
                        // JSON, so a low budget truncates the answer (finishReason=MAX_TOKENS,
                        // thoughtsTokenCount≈budget, missing required fields). Disable it for
                        // deterministic structured output. See the gemini-2.5-thinking-budget
                        // gotcha; default 0, overridable per call.
                        thinkingConfig: { thinkingBudget: options.thinkingBudget ?? 0 },
                    },
                }),
            },
            read: readGeminiResponse,
        };
    }

    if (provider === 'ollama') {
        const baseUrl = String(options.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
        return {
            url: `${baseUrl}/api/generate`,
            init: {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    prompt: options.userPrompt,
                    system: options.systemPrompt || '',
                    format: 'json',
                    stream: false,
                    keep_alive: options.keepAlive || '10m',
                    options: {
                        temperature: options.temperature,
                        num_ctx: options.contextTokens,
                        num_predict: options.maxOutputTokens,
                    },
                }),
            },
            read: readOllamaResponse,
        };
    }

    throw new JsonLlmError(`Unsupported JSON LLM provider: ${provider}.`, {
        code: 'unsupported_provider', provider,
    });
}

/**
 * @returns {Promise<{json: object, model: string, provider: string, latency_ms: number, token_usage: object}>}
 */
async function generateJson(options = {}) {
    const provider = String(options.provider || '').trim().toLowerCase();
    const models = modelList(options.primaryModel, options.fallbackModel);
    if (models.length === 0) {
        throw new JsonLlmError('No JSON LLM model configured.', {
            code: 'not_configured', provider,
        });
    }

    const timeoutMs = boundedInteger(options.timeoutMs, 60000, 1000, 120000);
    const maxRetries = boundedInteger(options.maxRetries, 2, 0, 4);
    const backoffMs = Array.isArray(options.backoffMs) && options.backoffMs.length > 0
        ? options.backoffMs.map(value => boundedInteger(value, 600, 0, 10000))
        : [250, 600];
    const fetchImpl = options.fetchImpl || global.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new JsonLlmError('Fetch transport is unavailable.', {
            code: 'not_configured', provider,
        });
    }

    const normalized = {
        ...options,
        provider,
        timeoutMs,
        temperature: Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0.1,
        maxOutputTokens: boundedInteger(options.maxOutputTokens, 400, 50, 2048),
        contextTokens: boundedInteger(options.contextTokens, 4096, 512, 32768),
        userPrompt: String(options.userPrompt || ''),
        systemPrompt: String(options.systemPrompt || ''),
    };
    const startedAt = Date.now();
    let lastError = null;

    for (const model of models) {
        const request = buildRequest(provider, model, normalized);
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                const baseDelay = backoffMs[attempt - 1] ?? backoffMs.at(-1) ?? 600;
                await (options.sleepImpl || sleep)(baseDelay);
            }
            try {
                const response = await requestWithTimeout(
                    request.url,
                    request.init,
                    timeoutMs,
                    fetchImpl
                );
                if (!response.ok) {
                    const error = httpError(provider, model, response);
                    lastError = error;
                    if (error.retryable && attempt < maxRetries) continue;
                    if (error.status === 429 && options.allowModelFallbackOn429 === false) throw error;
                    break;
                }

                try {
                    const result = await request.read(response, provider, model);
                    return {
                        json: result.json,
                        model,
                        provider,
                        latency_ms: Date.now() - startedAt,
                        token_usage: result.usage || {},
                    };
                } catch (error) {
                    lastError = error instanceof JsonLlmError
                        ? Object.assign(error, { provider, model })
                        : new JsonLlmError(`${provider} ${model} response failed.`, {
                            code: 'bad_response', provider, model, cause: error,
                        });
                    if (lastError.code === 'bad_json' && attempt < maxRetries) continue;
                    break;
                }
            } catch (error) {
                if (error instanceof JsonLlmError) {
                    lastError = error;
                    if (error.status === 429 && options.allowModelFallbackOn429 === false) throw error;
                    if (error.retryable && attempt < maxRetries) continue;
                    break;
                }
                const timedOut = error?.name === 'AbortError';
                lastError = new JsonLlmError(
                    timedOut
                        ? `${provider} ${model} timed out after ${timeoutMs}ms.`
                        : `${provider} ${model} request failed.`,
                    {
                        code: timedOut ? 'timeout' : 'network_error',
                        provider,
                        model,
                        retryable: true,
                        cause: error,
                    }
                );
                if (attempt < maxRetries) continue;
                break;
            }
        }
    }

    throw lastError || new JsonLlmError('JSON LLM request failed.', {
        code: 'provider_error', provider,
    });
}

module.exports = {
    JsonLlmError,
    boundedInteger,
    generateJson,
    modelList,
    parseJsonText,
    parseRetryAfter,
};
