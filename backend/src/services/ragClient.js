const axios = require('axios');

// =============================================================================
// RAG Client — outbound KB "Repair Advisor" client (REPAIR-ADVISOR-001, §3.1)
// Mirror of zenbookerClient.js: lazy axios singleton via getClient() + retryRequest.
//
// ask({ question, filters }) → POST {RAG_API_URL}/ask → a normalized diagnostic
// object, or `null`. Best-effort: NEVER throws — transport failure / timeout /
// non-2xx / parse failure → console.warn('[RAG] …') + return null. When
// RAG_API_URL is blank/unset the client is fully INERT (returns null, zero HTTP)
// so the advisor is globally disabled by config (spec E-10 / FR-12).
// =============================================================================

// Read config at module-eval time (like zenbookerClient's constants). Tests set
// env before require() under jest.resetModules(), so a fresh RAG_API_URL is picked
// up per case. Blank/unset ⇒ '' ⇒ inert. Default timeout 40s must exceed the
// ~35s RAG budget; override with RAG_TIMEOUT_MS without a code change.
const RAG_API_URL = process.env.RAG_API_URL || '';
const RAG_TIMEOUT_MS = Number(process.env.RAG_TIMEOUT_MS) || 40000;

let client = null;

/**
 * Lazy axios singleton for the RAG service. Only constructed when RAG_API_URL is
 * configured (ask() short-circuits before this when the URL is blank).
 */
function getClient() {
    if (client) return client;
    client = axios.create({
        baseURL: RAG_API_URL,
        timeout: RAG_TIMEOUT_MS,
        headers: {
            'Content-Type': 'application/json',
        },
    });
    return client;
}

// ─── Retry helper ─────────────────────────────────────────────────────────────
// Copied from zenbookerClient.js:540 (same idiom): 4xx short-circuits immediately
// (except 429); otherwise retries up to maxRetries with exponential backoff.
// ask() calls this with maxRetries=1 ⇒ a SINGLE attempt for every error class
// (the retry branch only runs at maxRetries ≥ 2).
async function retryRequest(requestFn, maxRetries = 3) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await requestFn();
        } catch (error) {
            lastError = error;
            // Don't retry 4xx (except 429)
            if (error.response?.status >= 400 && error.response?.status < 500 && error.response.status !== 429) {
                throw error;
            }
            if (attempt < maxRetries - 1) {
                const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
                console.log(`[RAG] Retry attempt ${attempt + 1} after ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

// ─── Tolerant parse helpers (spec §3.1) ───────────────────────────────────────

/** First argument that is a non-empty string (trimmed); otherwise undefined. */
function firstNonEmptyString(...vals) {
    for (const v of vals) {
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
}

/**
 * Top-level `likely_causes: [{ cause, probability }]` → `[{ cause, likelihood }]`.
 * Drop entries without a non-empty `cause`. `likelihood` = `probability` if it is
 * a finite number, else `null`.
 */
function normalizeCauses(rawCauses) {
    const out = [];
    if (!Array.isArray(rawCauses)) return out;
    for (const c of rawCauses) {
        if (!c || typeof c !== 'object') continue;
        const cause = typeof c.cause === 'string' ? c.cause.trim() : '';
        if (!cause) continue;
        const likelihood = typeof c.probability === 'number' && Number.isFinite(c.probability)
            ? c.probability
            : null;
        out.push({ cause, likelihood });
    }
    return out;
}

/**
 * `diagnosis_steps[]` (or `repair_instructions[]` alias) → `[{ step, expected? }]`.
 * A string ⇒ `{ step }`; an object ⇒ `{ step: <text|step|instruction>, expected:
 * <expected|expected_result> if present }`. Empty/blank entries dropped.
 */
function normalizeSteps(rawSteps) {
    const out = [];
    if (!Array.isArray(rawSteps)) return out;
    for (const s of rawSteps) {
        if (typeof s === 'string') {
            const text = s.trim();
            if (text) out.push({ step: text });
        } else if (s && typeof s === 'object') {
            const text = firstNonEmptyString(s.text, s.step, s.instruction);
            if (!text) continue;
            const step = { step: text };
            const expected = firstNonEmptyString(s.expected, s.expected_result);
            if (expected) step.expected = expected;
            out.push(step);
        }
    }
    return out;
}

/**
 * Locate + JSON.parse the structured block embedded in the answer text.
 * Fence extraction: first ```json … ``` (case-insensitive tag; bare ``` … ```
 * also accepted). Fallback (no fence): substring from the first `{` to the last
 * `}`. Parse failure ⇒ block treated as absent (returns null; never throws).
 */
function extractStructuredBlock(data) {
    const answerText = firstNonEmptyString(data.answer, data.text, data.message);
    if (!answerText) return null;

    let candidate = null;
    const fenceMatch = answerText.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
        candidate = fenceMatch[1];
    } else {
        const first = answerText.indexOf('{');
        const last = answerText.lastIndexOf('}');
        if (first !== -1 && last !== -1 && last > first) {
            candidate = answerText.slice(first, last + 1);
        }
    }
    if (!candidate) return null;

    try {
        const parsed = JSON.parse(candidate);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
        return null;
    }
}

/**
 * Normalize the RAG `/ask` response body per spec §3.1. Returns the normalized
 * object OR `null` (empty ⇒ null rule). Pure + defensive: never throws.
 */
function parseAskResponse(body) {
    const data = body && typeof body === 'object' ? body : {};

    // 1. Top-level fields.
    const summary = firstNonEmptyString(data.summary) || null;
    const causes = normalizeCauses(data.likely_causes);
    let confidence = typeof data.confidence === 'number' && Number.isFinite(data.confidence)
        ? data.confidence
        : null;
    let grounded = typeof data.grounded === 'boolean' ? data.grounded : null;

    // 2. Structured block (from the answer/text/message string).
    const block = extractStructuredBlock(data);
    let steps = [];
    let diagnosticMode = null;
    if (block) {
        steps = normalizeSteps(block.diagnosis_steps || block.repair_instructions);
        diagnosticMode = firstNonEmptyString(
            block.diagnostic_mode,
            block.diagnostic_mode_entry,
            block.service_mode,
        ) || null;
        // Fenced block wins on confidence/grounded conflict.
        if (typeof block.confidence === 'number' && Number.isFinite(block.confidence)) {
            confidence = block.confidence;
        }
        if (typeof block.grounded === 'boolean') {
            grounded = block.grounded;
        }
    }

    // 3. Empty ⇒ null: a summary alone is NOT enough to warrant a note.
    if (causes.length === 0 && steps.length === 0 && !diagnosticMode) {
        return null;
    }

    return { summary, causes, steps, diagnosticMode, confidence, grounded };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ask the KB RAG service for a diagnostic starting point.
 *
 * @param {Object}  params
 * @param {string}  params.question           - assembled problem question (required)
 * @param {Object} [params.filters]           - { brand?, unitType? } (present keys only)
 * @returns {Promise<Object|null>} normalized diagnostic object, or null.
 *          Best-effort: never throws.
 */
async function ask({ question, filters } = {}) {
    try {
        // Inert when unconfigured: no client, no HTTP (spec E-10 / FR-12).
        if (!RAG_API_URL) return null;

        // Body filters carry only known keys — never empty strings.
        const outFilters = {};
        if (filters && filters.brand) outFilters.brand = filters.brand;
        if (filters && filters.unitType) outFilters.unitType = filters.unitType;
        const body = { question, filters: outFilters };

        // Single attempt (maxRetries=1): a 4xx short-circuits; any other failure
        // class also makes exactly one attempt. The advisor is best-effort.
        const res = await retryRequest(() => getClient().post('/ask', body), 1);
        return parseAskResponse(res && res.data);
    } catch (err) {
        console.warn('[RAG] ask failed:', err && err.message);
        return null;
    }
}

module.exports = {
    getClient,
    ask,
};
