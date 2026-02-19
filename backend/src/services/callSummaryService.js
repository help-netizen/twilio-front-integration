/**
 * Call Summary Service — Gemini 2.5 Pro adapter
 * Generates a short Call Summary + structured Key Entities from transcript dialog.
 *
 * Returns JSON: { summary: string, entities: Array<{ label, value, start_ms? }> }
 */

const fetch = require('node-fetch');

const GEMINI_API_KEY = process.env.GEMINI_SUMMARY_API_KEY || process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_SUMMARY_MODEL || 'gemini-2.5-pro';
const PROVIDER_TIMEOUT_MS = parseInt(process.env.SUMMARY_PROVIDER_TIMEOUT_MS || '30000', 10);
const MAX_RETRIES = 2;
const BACKOFF_MS = [500, 1500];

const SYSTEM_PROMPT = `You are an AI assistant for a home appliance repair call center. Your task is to analyze a phone call transcript and produce a structured JSON output.

Return ONLY valid JSON with this exact structure:
{
  "summary": "<2-5 sentence call summary>",
  "entities": [
    { "label": "<label>", "value": "<value>", "start_ms": <number or null> }
  ]
}

## Summary Rules
The summary (2-5 sentences) must answer:
- Who is calling and what they need
- What appliance/brand/problem
- Any appointment or time window agreed upon
- Special notes or requests

## Entity Extraction Rules
Return ONLY entities whose values are clearly present in the dialog. Do NOT invent or guess values.
Entity labels MUST be from this ordered list (use exact labels, keep this order):
1. Customer Name (as spelled)
2. Service ZIP Code
3. Service Address
4. Customer Phone Number
5. Appliance Type
6. Brand
7. Model/Configuration
8. Issue / Symptom Summary (incl. Error Code)
9. Appointment Date
10. Appointment Time Window
11. Lead Notes

Field-specific rules:
- Customer Name: if spelled letter-by-letter, use that form
- Service ZIP Code: 5-digit US ZIP only
- Service Address: full street + city on one line
- Customer Phone Number: prefer confirmed in dialog over metadata
- Appliance Type / Brand / Model/Configuration: match spoken words (e.g. "Washer", "Whirlpool", "Front-load")
- Issue / Symptom Summary: error code first, then symptoms separated by semicolons. Example: "E3F5; door locked / door won't open; washer won't start; clicking sound"
- Appointment Date: use "Today" / "Tomorrow" if relative; if no exact date, note "(exact date not stated)"
- Appointment Time Window: show range like "4:00 PM – 6:00 PM" if given
- Lead Notes: only important action items (e.g. "Notify if earlier slot becomes available")

Each entity MUST have "start_ms" set to the millisecond timestamp of the utterance where it is first mentioned. Each utterance in the transcript is prefixed with "[Xms]" — use those exact values. If no timestamp is available, set "start_ms" to null.

Omit any entity whose value is not found in the transcript.`;

/**
 * Generate a call summary + structured entities from a transcript dialog.
 * @param {string} dialogText - The full transcript (Speaker A: ... Speaker B: ...)
 * @param {object} [callMeta] - Optional metadata: { callerPhone, callTime }
 * @returns {Promise<{ summary: string, entities: Array<{label:string,value:string,start_ms:number|null}>, error?: string }>}
 */
async function generateCallSummary(dialogText, callMeta = {}) {
    const traceId = `sum_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const startTime = Date.now();

    if (!dialogText || typeof dialogText !== 'string' || dialogText.trim().length === 0) {
        console.warn(`[CallSummary:${traceId}] Empty dialog text — skipping`);
        return { summary: '', entities: [], error: 'empty_transcript' };
    }

    if (!GEMINI_API_KEY) {
        console.warn(`[CallSummary:${traceId}] GEMINI_SUMMARY_API_KEY not set — skipping`);
        return { summary: '', entities: [], error: 'api_key_not_configured' };
    }

    // Build user prompt
    let userPrompt = `Transcript:\n"""\n${dialogText.trim()}\n"""`;
    if (callMeta.callerPhone) {
        userPrompt += `\n\nCaller phone (metadata): ${callMeta.callerPhone}`;
    }
    if (callMeta.callTime) {
        userPrompt += `\nCall time (metadata): ${callMeta.callTime}`;
    }

    const payload = {
        contents: [
            { role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\n${userPrompt}` }] },
        ],
        generationConfig: {
            temperature: 0.15,
            maxOutputTokens: 4096,
            candidateCount: 1,
        },
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            const delay = BACKOFF_MS[attempt - 1] || 1500;
            const jitter = Math.floor(Math.random() * delay * 0.3);
            await sleep(delay + jitter);
            console.log(`[CallSummary:${traceId}] Retry attempt ${attempt + 1}/${MAX_RETRIES + 1}`);
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
                console.warn(`[CallSummary:${traceId}] Gemini HTTP ${status} (attempt ${attempt + 1}): ${body.slice(0, 300)}`);

                if ([429, 500, 502, 503, 504].includes(status) && attempt < MAX_RETRIES) {
                    lastError = new Error(`Gemini HTTP ${status}`);
                    continue;
                }
                lastError = new Error(`Gemini HTTP ${status}: ${body.slice(0, 200)}`);
                break;
            }

            const data = await response.json();
            const latencyMs = Date.now() - startTime;

            const rawOutput = data?.candidates?.[0]?.content?.parts
                ?.filter(p => !p.thought)  // skip thinking parts for 2.5-pro
                ?.map(p => p.text)
                ?.filter(Boolean)
                ?.join('') || '';
            if (!rawOutput) {
                console.warn(`[CallSummary:${traceId}] Empty response from Gemini (finishReason: ${data?.candidates?.[0]?.finishReason})`);
                return { summary: '', entities: [], error: 'empty_provider_response' };
            }

            // Parse JSON
            const parsed = parseGeminiOutput(rawOutput);
            console.log(`[CallSummary:${traceId}] Summary generated in ${latencyMs}ms: ${parsed.summary?.length || 0} chars, ${parsed.entities?.length || 0} entities`);
            return parsed;

        } catch (err) {
            if (err.name === 'AbortError') {
                console.warn(`[CallSummary:${traceId}] Timeout (attempt ${attempt + 1})`);
                lastError = new Error('Provider timeout');
                if (attempt < MAX_RETRIES) continue;
            } else {
                console.error(`[CallSummary:${traceId}] Fetch error (attempt ${attempt + 1}):`, err.message);
                lastError = err;
                if (attempt < MAX_RETRIES) continue;
            }
        }
    }

    console.error(`[CallSummary:${traceId}] All retries exhausted:`, lastError?.message);
    return { summary: '', entities: [], error: lastError?.message || 'provider_unavailable' };
}

/**
 * Parse Gemini output (may be wrapped in markdown code fences).
 */
function parseGeminiOutput(rawOutput) {
    let cleaned = rawOutput.trim();
    // Strip markdown code fences
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }

    try {
        const parsed = JSON.parse(cleaned);
        return {
            summary: parsed.summary || '',
            entities: Array.isArray(parsed.entities) ? parsed.entities.map(e => ({
                label: String(e.label || ''),
                value: String(e.value || ''),
                start_ms: typeof e.start_ms === 'number' ? e.start_ms : null,
            })) : [],
        };
    } catch (err) {
        console.warn('[CallSummary] Failed to parse Gemini JSON, using raw text as summary:', err.message);
        return {
            summary: cleaned.slice(0, 500),
            entities: [],
        };
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { generateCallSummary };
