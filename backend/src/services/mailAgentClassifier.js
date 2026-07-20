/**
 * MAIL-AGENT-001 / MAIL-LOCAL-LLM-001 — email triage classifier.
 * classifyEmail() dispatches on MAIL_AGENT_PROVIDER (default 'ollama') to a local
 * Ollama transport, keeping the Gemini transport as a dormant one-env-var revert
 * valve. Both mirror the same bounded-retry / hard-timeout structure and return a
 * strict verdict object (or throw after all retries fail).
 */

const { generateJson } = require('./llm/jsonLlmClient');

const PROVIDER = (process.env.MAIL_AGENT_PROVIDER || 'ollama').toLowerCase();

// Ollama (default transport) — local LLM, no API key.
const OLLAMA_URL = (process.env.MAIL_AGENT_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.MAIL_AGENT_OLLAMA_MODEL || 'qwen2.5:14b';

// Gemini (dormant revert valve) — used only when MAIL_AGENT_PROVIDER=gemini.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PRIMARY_MODEL = process.env.MAIL_AGENT_MODEL || 'gemini-2.5-flash-lite';
const FALLBACK_MODEL = process.env.MAIL_AGENT_FALLBACK_MODEL || 'gemini-2.5-flash';

const TIMEOUT_MS = parseInt(process.env.MAIL_AGENT_TIMEOUT_MS || '60000', 10);
const MAX_RETRIES = parseInt(process.env.MAIL_AGENT_RETRY_MAX || '2', 10);
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

function parseVerdict(parsed) {
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
 * Classify one inbound email — thin dispatcher over the configured transport.
 * @returns {Promise<{verdict, model, latency_ms}>} — throws after all retries fail.
 */
async function classifyEmail(input) {
    const result = await generateJson({
        provider: PROVIDER,
        apiKey: GEMINI_API_KEY,
        baseUrl: PROVIDER === 'ollama' ? OLLAMA_URL : undefined,
        primaryModel: PROVIDER === 'ollama' ? OLLAMA_MODEL : PRIMARY_MODEL,
        fallbackModel: PROVIDER === 'ollama' ? null : FALLBACK_MODEL,
        userPrompt: `${SYSTEM_PROMPT}\n\n${buildUserPrompt(input)}`,
        timeoutMs: TIMEOUT_MS,
        maxRetries: MAX_RETRIES,
        temperature: 0.1,
        contextTokens: 4096,
        maxOutputTokens: PROVIDER === 'ollama' ? 512 : 400,
        allowModelFallbackOn429: true,
    });
    return {
        verdict: parseVerdict(result.json),
        model: result.model,
        latency_ms: result.latency_ms,
    };
}

module.exports = { classifyEmail };
