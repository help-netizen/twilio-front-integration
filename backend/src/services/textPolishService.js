/**
 * Text Polish Service — Gemini API adapter
 * Polishes customer messages: fixes grammar, spelling, punctuation,
 * humanizes tone while preserving all facts (prices, dates, phones, names, etc.)
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const PROVIDER_TIMEOUT_MS = parseInt(process.env.POLISH_PROVIDER_TIMEOUT_MS || '10000', 10);
const MAX_RETRIES = parseInt(process.env.POLISH_RETRY_MAX || '2', 10);
const BACKOFF_MS = [200, 500];

const SYSTEM_PROMPT = `You are a message editor for a service company's customer communications.
Fix spelling, punctuation, and grammar mistakes.
Make the tone natural, polite, and concise — not robotic.
Do NOT change facts: prices, dates, times, phone numbers, emails, URLs, order/ticket IDs, names, addresses, deadlines.
Do NOT add new information, promises, or conditions.
Preserve the language of the original text.
Minimize blank lines: do NOT put an empty line between every sentence or paragraph. Use a single blank line only to separate distinct logical sections (e.g. greeting, body, sign-off). Consecutive related sentences should be on adjacent lines without blank lines between them.
Return ONLY valid JSON: {"polished_text":"string"}.`;

/**
 * Call Gemini API with retry logic.
 * @param {string} text - Raw text to polish
 * @param {object} options - Optional: language, tone, channel
 * @returns {Promise<object>} Polish result
 */
async function polishText(text, options = {}) {
    const startTime = Date.now();
    const traceId = `trc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    // Validate
    if (!text || typeof text !== 'string') {
        throw Object.assign(new Error('text is required'), { status: 400, code: 'VALIDATION_ERROR' });
    }
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > 4000) {
        throw Object.assign(
            new Error(`text must be 1-4000 characters, got ${trimmed.length}`),
            { status: 400, code: 'VALIDATION_ERROR' }
        );
    }

    if (!GEMINI_API_KEY) {
        console.warn('[TextPolish] GEMINI_API_KEY not set — returning fallback');
        return buildFallback(trimmed, traceId, startTime, ['gemini_api_key_not_configured']);
    }

    const userPrompt = `Original text:\n"""${trimmed}"""`;

    const payload = {
        contents: [
            { role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\n${userPrompt}` }] },
        ],
        generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 220,
            candidateCount: 1,
        },
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            const delay = BACKOFF_MS[attempt - 1] || 500;
            const jitter = Math.floor(Math.random() * delay * 0.3);
            await sleep(delay + jitter);
        }

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            clearTimeout(timeout);

            if (!response.ok) {
                const status = response.status;
                const body = await response.text().catch(() => '');
                console.warn(`[TextPolish] Gemini HTTP ${status} (attempt ${attempt + 1}): ${body.slice(0, 200)}`);

                // Retry on transient errors
                if ([429, 500, 502, 503, 504].includes(status) && attempt < MAX_RETRIES) {
                    lastError = new Error(`Gemini HTTP ${status}`);
                    continue;
                }
                lastError = new Error(`Gemini HTTP ${status}: ${body.slice(0, 200)}`);
                break;
            }

            const data = await response.json();
            const latencyMs = Date.now() - startTime;

            // Extract text from Gemini response
            const rawOutput = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!rawOutput) {
                console.warn('[TextPolish] Empty response from Gemini');
                return buildFallback(trimmed, traceId, startTime, ['empty_provider_response']);
            }

            // Parse JSON from Gemini output (may have markdown wrapping)
            const polishedText = parsePolishedText(rawOutput, trimmed);

            // Usage stats
            const usage = data?.usageMetadata || {};

            return {
                polished_text: polishedText,
                changed: polishedText !== trimmed,
                detected_language: 'auto',
                fallback_used: false,
                warnings: [],
                trace_id: traceId,
                provider: { name: 'gemini', model: GEMINI_MODEL },
                usage: {
                    input_tokens: usage.promptTokenCount || null,
                    output_tokens: usage.candidatesTokenCount || null,
                },
                latency_ms: latencyMs,
            };
        } catch (err) {
            if (err.name === 'AbortError') {
                console.warn(`[TextPolish] Timeout (attempt ${attempt + 1})`);
                lastError = new Error('Provider timeout');
                if (attempt < MAX_RETRIES) continue;
            } else {
                console.error(`[TextPolish] Fetch error (attempt ${attempt + 1}):`, err.message);
                lastError = err;
                if (attempt < MAX_RETRIES) continue;
            }
        }
    }

    // All retries exhausted — fallback
    console.error('[TextPolish] All retries exhausted:', lastError?.message);
    return buildFallback(trimmed, traceId, startTime, ['provider_unavailable']);
}

/**
 * Parse polished text from Gemini output.
 * Handles: raw JSON, markdown-wrapped JSON, plain text.
 */
function parsePolishedText(rawOutput, originalText) {
    // Strip markdown code fences if present
    let cleaned = rawOutput.trim();
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }

    try {
        const parsed = JSON.parse(cleaned);
        if (parsed.polished_text && typeof parsed.polished_text === 'string') {
            return parsed.polished_text;
        }
    } catch {
        // Not valid JSON — use raw output as polished text
    }

    // If Gemini returned plain text instead of JSON, use it directly
    // (but only if it's not too different in length)
    if (cleaned && cleaned.length > 0 && cleaned.length < originalText.length * 2) {
        return cleaned;
    }

    return originalText;
}

function buildFallback(text, traceId, startTime, warnings) {
    return {
        polished_text: text,
        changed: false,
        detected_language: 'unknown',
        fallback_used: true,
        warnings,
        trace_id: traceId,
        provider: { name: 'gemini', model: GEMINI_MODEL },
        usage: null,
        latency_ms: Date.now() - startTime,
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { polishText };
