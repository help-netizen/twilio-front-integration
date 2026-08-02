'use strict';

const { validateCadence } = require('./appScheduleCadence');

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_TOKENS = 8192;

class AppBuilderProviderError extends Error {
    constructor(message, cause = null) {
        super(message);
        this.name = 'AppBuilderProviderError';
        this.code = 'PROVIDER_UNAVAILABLE';
        this.httpStatus = 503;
        if (cause) this.cause = cause;
    }
}

function positiveInt(value, fallback) {
    const parsed = parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function providerName() {
    return String(
        process.env.APP_BUILDER_PROVIDER
        || process.env.ASSISTANT_PROVIDER
        || 'gemini'
    ).trim().toLowerCase();
}

function modelName() {
    return String(
        process.env.APP_BUILDER_MODEL
        || process.env.ASSISTANT_MODEL
        || DEFAULT_MODEL
    ).trim();
}

function normalizeUsage(metadata) {
    const value = metadata && typeof metadata === 'object' ? metadata : {};
    const input = Number(value.promptTokenCount) || 0;
    const output = Number(value.candidatesTokenCount) || 0;
    return {
        input_tokens: input,
        output_tokens: output,
        total_tokens: Number(value.totalTokenCount) || input + output,
    };
}

function parseGeneratedArtifact(raw) {
    let cleaned = String(raw || '').trim();
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }
    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (error) {
        throw new AppBuilderProviderError('Builder model returned invalid JSON', error);
    }
    if (!parsed || typeof parsed.source !== 'string' || !parsed.source.trim()
        || typeof parsed.description !== 'string' || !parsed.description.trim()) {
        throw new AppBuilderProviderError('Builder model returned an invalid artifact envelope');
    }
    let suggestedSchedule = null;
    if (parsed.suggested_schedule !== undefined && parsed.suggested_schedule !== null) {
        try {
            suggestedSchedule = validateCadence(parsed.suggested_schedule);
        } catch (_error) {
            throw new AppBuilderProviderError('Builder model returned an invalid suggested schedule');
        }
    }
    const artifact = {
        source: parsed.source,
        description: parsed.description.trim().slice(0, 2000),
    };
    if (suggestedSchedule) artifact.suggested_schedule = suggestedSchedule;
    return artifact;
}

async function generate(prompt) {
    const provider = providerName();
    if (provider !== 'gemini') {
        throw new AppBuilderProviderError(`Unsupported app builder provider: ${provider}`);
    }
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new AppBuilderProviderError('GEMINI_API_KEY not configured');

    const model = modelName();
    const timeoutMs = positiveInt(
        process.env.APP_BUILDER_TIMEOUT_MS || process.env.ASSISTANT_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: MAX_OUTPUT_TOKENS,
                        thinkingConfig: { thinkingBudget: 0 },
                        candidateCount: 1,
                        responseMimeType: 'application/json',
                        responseSchema: {
                            type: 'OBJECT',
                            properties: {
                                source: { type: 'STRING' },
                                description: { type: 'STRING' },
                                suggested_schedule: {
                                    type: 'OBJECT',
                                    nullable: true,
                                    properties: {
                                        kind: { type: 'STRING' },
                                        n: { type: 'INTEGER' },
                                        minute: { type: 'INTEGER' },
                                        at: { type: 'STRING' },
                                        dow: { type: 'INTEGER' },
                                        dom: { type: 'INTEGER' },
                                    },
                                    required: ['kind'],
                                },
                            },
                            required: ['source', 'description'],
                        },
                    },
                }),
                signal: controller.signal,
            }
        );
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Gemini HTTP ${response.status}: ${body.slice(0, 200)}`);
        }
        const data = await response.json();
        const raw = data?.candidates?.[0]?.content?.parts
            ?.filter(part => !part.thought)
            ?.map(part => part.text)
            ?.filter(Boolean)
            ?.join('')
            ?.trim() || '';
        const tokenUsage = normalizeUsage(data?.usageMetadata);
        let artifact;
        try {
            artifact = parseGeneratedArtifact(raw);
        } catch (error) {
            error.model = model;
            error.token_usage = tokenUsage;
            throw error;
        }
        return {
            ...artifact,
            provider,
            model,
            latency_ms: Date.now() - startedAt,
            token_usage: tokenUsage,
        };
    } catch (error) {
        if (error instanceof AppBuilderProviderError) throw error;
        const message = error?.name === 'AbortError'
            ? `Builder provider timed out after ${timeoutMs}ms`
            : 'Builder provider unavailable';
        throw new AppBuilderProviderError(message, error);
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = {
    generate,
    providerName,
    modelName,
    parseGeneratedArtifact,
    normalizeUsage,
    AppBuilderProviderError,
};
