/**
 * yelpGreetingService — YELP-LEAD-AUTORESPONDER-001 (Phase 1a, TASK-YLA-003).
 *
 * buildGreeting({ name, service, problem }) → a short, warm, professional first
 * reply to a Yelp new-lead: references the appliance/problem, asks for the best
 * phone number + a good time to reach them, and quotes NO price. It is the text
 * we send back through the Yelp relay.
 *
 * Transport mirrors mailAgentClassifier.classifyViaGemini: v1beta generateContent,
 * two-model fallback, bounded retries, hard timeout, GEMINI_API_KEY. Provider is
 * configurable (YELP_GREETING_PROVIDER, default 'gemini').
 *
 * SAFE-FAIL CONTRACT: buildGreeting NEVER throws and NEVER returns empty. On ANY
 * Gemini error / timeout / quota / missing key it falls back to a deterministic
 * static template that still names the customer and references the service.
 */
'use strict';

const PROVIDER = (process.env.YELP_GREETING_PROVIDER || 'gemini').toLowerCase();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PRIMARY_MODEL = process.env.YELP_GREETING_MODEL || 'gemini-2.5-flash-lite';
const FALLBACK_MODEL = process.env.YELP_GREETING_FALLBACK_MODEL || 'gemini-2.5-flash';

const TIMEOUT_MS = parseInt(process.env.YELP_GREETING_TIMEOUT_MS || '20000', 10);
const MAX_RETRIES = parseInt(process.env.YELP_GREETING_RETRY_MAX || '1', 10);
const BACKOFF_MS = [300, 700];
const MAX_PROBLEM_CHARS = 800;

const COMPANY_NAME = process.env.YELP_GREETING_COMPANY_NAME || 'the team';

const SYSTEM_PROMPT = `You are a friendly, professional customer-service rep for a home-appliance repair company replying to a brand-new lead that just came in through Yelp.
Write ONE short reply (2-4 sentences, plain text, no subject line, no markdown) that:
- greets the customer by first name if provided,
- shows you read their request by referencing the specific appliance / problem,
- asks for the best phone number to reach them AND a good time to call,
- is warm but concise and professional.
STRICT RULES: do NOT quote a price, an estimate, a rate, or a time-window promise. Do NOT invent details the customer did not give. Do NOT use placeholders like [name]. Output ONLY the message body.`;

function clampProblem(problem) {
    return String(problem || '').replace(/\s+/g, ' ').trim().slice(0, MAX_PROBLEM_CHARS);
}

function buildUserPrompt({ name, service, problem }) {
    const lines = [
        `Customer first name: ${name || '(unknown)'}`,
        `Service requested: ${service || '(unspecified appliance service)'}`,
        `What they told us: ${clampProblem(problem) || '(no extra detail provided)'}`,
    ];
    return lines.join('\n');
}

/**
 * Deterministic fallback — used whenever Gemini is unavailable or fails. Always a
 * non-empty string that includes the customer name (when known) and the service.
 * No price, asks for phone + time.
 * @param {{name?:(string|null), service?:(string|null), problem?:(string|null)}} ctx
 * @returns {string}
 */
function staticGreeting(ctx = {}) {
    const name = ctx.name && String(ctx.name).trim();
    const service = (ctx.service && String(ctx.service).trim()) || 'appliance repair';
    const hello = name ? `Hi ${name},` : 'Hi there,';
    return [
        `${hello} thanks so much for reaching out through Yelp about your ${service}.`,
        `We'd be glad to help get this sorted out for you.`,
        `What's the best phone number to reach you, and a good time to call? We'll follow up right away to get you scheduled.`,
    ].join(' ');
}

/**
 * Gemini transport — plain-text generateContent, two-model fallback, bounded
 * retries, hard timeout. Throws after all models/retries fail (caller falls back).
 * @returns {Promise<string>} the generated greeting text.
 */
async function buildViaGemini(ctx) {
    if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY not configured');
    }
    const payload = {
        contents: [
            { role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\n${buildUserPrompt(ctx)}` }] },
        ],
        generationConfig: {
            temperature: 0.5,
            maxOutputTokens: 260,
            candidateCount: 1,
        },
    };

    const models = [...new Set([PRIMARY_MODEL, FALLBACK_MODEL].filter(Boolean))];
    let lastError = null;

    for (const model of models) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                const delay = BACKOFF_MS[attempt - 1] || 700;
                await new Promise(r => setTimeout(r, delay + Math.floor(Math.random() * delay * 0.3)));
            }
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
                    lastError = new Error(`Gemini ${model} HTTP ${status}: ${body.slice(0, 200)}`);
                    if ([429, 500, 502, 503, 504].includes(status) && attempt < MAX_RETRIES) continue;
                    break; // non-retryable → next model
                }

                const data = await response.json();
                const rawOutput = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                const text = String(rawOutput || '').trim();
                if (!text) {
                    lastError = new Error(`Gemini ${model} empty response`);
                    break;
                }
                return text;
            } catch (err) {
                lastError = err && err.name === 'AbortError'
                    ? new Error(`Gemini ${model} timeout after ${TIMEOUT_MS}ms`)
                    : err;
                if (attempt < MAX_RETRIES) continue;
            }
        }
    }
    throw lastError || new Error('yelp greeting generation failed');
}

/**
 * Build the greeting. NEVER throws; ALWAYS resolves to a non-empty string.
 * @param {{name?:(string|null), service?:(string|null), problem?:(string|null)}} [ctx]
 * @returns {Promise<string>}
 */
async function buildGreeting(ctx = {}) {
    const safe = {
        name: ctx && ctx.name ? String(ctx.name).trim() : null,
        service: ctx && ctx.service ? String(ctx.service).trim() : null,
        problem: ctx && ctx.problem ? String(ctx.problem) : null,
    };
    try {
        if (PROVIDER === 'gemini' && GEMINI_API_KEY) {
            const text = await buildViaGemini(safe);
            if (text && text.trim()) return text.trim();
        }
    } catch (e) {
        console.error('[YelpGreeting] Gemini failed, using static template:', e && e.message);
    }
    return staticGreeting(safe);
}

module.exports = {
    buildGreeting,
    // Exported for targeted unit tests / callers that want the deterministic body.
    staticGreeting,
    COMPANY_NAME,
};
