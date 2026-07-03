/**
 * MAIL-AGENT-001 — Gemini email triage classifier.
 * Transport mirrors textPolishService (v1beta generateContent, model fallback,
 * bounded retries, hard timeout). Returns a strict verdict object or throws.
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PRIMARY_MODEL = process.env.MAIL_AGENT_MODEL || 'gemini-2.5-flash-lite';
const FALLBACK_MODEL = process.env.MAIL_AGENT_FALLBACK_MODEL || 'gemini-2.5-flash';
const TIMEOUT_MS = parseInt(process.env.MAIL_AGENT_TIMEOUT_MS || '15000', 10);
const MAX_RETRIES = parseInt(process.env.MAIL_AGENT_RETRY_MAX || '2', 10);
const BACKOFF_MS = [250, 600];
const MAX_BODY_CHARS = 5000;

const CATEGORIES = new Set([
    'customer_request', 'potential_lead', 'scheduling', 'invoice_billing',
    'complaint', 'spam', 'newsletter', 'automated_notification', 'other',
]);

const SYSTEM_PROMPT = `You triage inbound email for a home-services company's dispatcher.
Decide whether THIS email needs a human dispatcher's attention.

NEEDS ATTENTION (needs_attention=true): real people writing about service — new/existing customers,
booking or rescheduling requests, questions about a visit/quote/invoice, complaints, payment issues,
anything where ignoring the email loses money or trust.
DOES NOT need attention (needs_attention=false): newsletters, promos, cold B2B sales pitches,
automated notifications (receipts, "your statement is ready", social/media alerts, system emails),
obvious spam or phishing.

Return ONLY valid JSON:
{"needs_attention": boolean,
 "category": one of ["customer_request","potential_lead","scheduling","invoice_billing","complaint","spam","newsletter","automated_notification","other"],
 "confidence": number 0..1,
 "priority": "p1" for urgent (angry customer, same-day request, payment failure) else "p2",
 "reason": string, max 2 short sentences, addressed to the dispatcher, in English,
 "task_title": string, max 60 chars, imperative (e.g. "Reply to refund request from Jane")}`;

function buildUserPrompt({ fromName, fromEmail, subject, bodyText, knownContact, contactName }) {
    const body = String(bodyText || '').slice(0, MAX_BODY_CHARS);
    const sender = knownContact
        ? `KNOWN CONTACT in our CRM${contactName ? ` (${contactName})` : ''}`
        : 'NOT in our CRM (unknown sender — could be a new lead)';
    return [
        `Sender: ${fromName || ''} <${fromEmail || ''}> — ${sender}`,
        `Subject: ${subject || '(no subject)'}`,
        `Body:\n"""${body}"""`,
    ].join('\n');
}

function parseVerdict(rawOutput) {
    let cleaned = String(rawOutput || '').trim();
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }
    const parsed = JSON.parse(cleaned);
    const verdict = {
        needs_attention: parsed.needs_attention === true,
        category: CATEGORIES.has(parsed.category) ? parsed.category : 'other',
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
        priority: parsed.priority === 'p1' ? 'p1' : 'p2',
        reason: String(parsed.reason || '').slice(0, 500),
        task_title: String(parsed.task_title || '').slice(0, 60),
    };
    if (!verdict.reason) verdict.reason = 'No reason provided by the model.';
    return verdict;
}

/**
 * Classify one inbound email.
 * @returns {Promise<{verdict, model, latency_ms}>} — throws after all retries fail.
 */
async function classifyEmail(input) {
    if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY not configured');
    }
    const startTime = Date.now();
    const payload = {
        contents: [
            { role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\n${buildUserPrompt(input)}` }] },
        ],
        generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 400,
            candidateCount: 1,
            responseMimeType: 'application/json',
        },
    };

    const models = [...new Set([PRIMARY_MODEL, FALLBACK_MODEL].filter(Boolean))];
    let lastError = null;

    for (const model of models) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                const delay = BACKOFF_MS[attempt - 1] || 600;
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
                if (!rawOutput) {
                    lastError = new Error(`Gemini ${model} empty response`);
                    break;
                }
                let verdict;
                try {
                    verdict = parseVerdict(rawOutput);
                } catch (e) {
                    lastError = new Error(`Gemini ${model} bad JSON: ${e.message}`);
                    if (attempt < MAX_RETRIES) continue;
                    break;
                }
                return { verdict, model, latency_ms: Date.now() - startTime };
            } catch (err) {
                lastError = err.name === 'AbortError'
                    ? new Error(`Gemini ${model} timeout after ${TIMEOUT_MS}ms`)
                    : err;
                if (attempt < MAX_RETRIES) continue;
            }
        }
    }
    throw lastError || new Error('mail agent classification failed');
}

module.exports = { classifyEmail };
