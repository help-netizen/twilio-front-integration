// =============================================================================
// KB Diagnostics Service — "AI Repair Advisor" (REPAIR-ADVISOR-001)
//
// Stage-1 pure helpers (this file, T3):
//   • buildQuestion(job)      — assemble the RAG question string + filters from a
//                               job row (spec §3.4).
//   • formatNote(normalized)  — render the 3-section markdown note from the
//                               normalized ragClient object (spec §3.5).
//
// Both functions are PURE (no I/O, no requires) so they are unit-testable
// directly — house precedent: rulesEngine.evaluateConditions / ruleActions.render.
//
// NOTE (T4 append point): the detached orchestrator `runForJob({ jobId, companyId })`
// and its lazy `require('./ragClient' | './jobsService' | './marketplaceService')`
// are added by REPAIR-ADVISOR-T4 below the helpers; module.exports is extended
// there. Do NOT add those requires now — the helpers need none.
// =============================================================================

// ─── buildQuestion (spec §3.4) ───────────────────────────────────────────────

/** Trimmed string if `v` is a non-empty string, else ''. */
function trimOrEmpty(v) {
    return typeof v === 'string' ? v.trim() : '';
}

/**
 * Build a case-insensitive lookup of a job's metadata custom fields. Keys are
 * lowercased + trimmed; only non-empty string values are kept (never empty
 * strings). First occurrence wins on a normalized-key collision.
 */
function metadataLookup(metadata) {
    const map = {};
    if (metadata && typeof metadata === 'object') {
        for (const rawKey of Object.keys(metadata)) {
            const norm = String(rawKey).trim().toLowerCase();
            const val = metadata[rawKey];
            if (typeof val === 'string' && val.trim() && !(norm in map)) {
                map[norm] = val.trim();
            }
        }
    }
    return map;
}

/** First candidate (normalized key) present in the lookup, else undefined. */
function pickFrom(map, candidates) {
    for (const c of candidates) {
        if (map[c]) return map[c];
    }
    return undefined;
}

/**
 * Assemble the RAG question + optional filters from a job row (fields from
 * `rowToJob`: description, comments, job_type, service_name, metadata).
 *
 * - Problem text: trim(description) || trim(comments) || ''  (description primary).
 * - Service context: job_type || service_name || null       (job_type wins).
 * - Question shape: `Customer-reported problem: <problem>. Service type: <svc>.[ Model: <model>.]`
 *   Parts are emitted only when present; if BOTH problem and svc are empty ⇒
 *   `question === ''` (signals the runForJob step-4 STOP).
 * - Filters (from metadata, case-insensitive keys, omit absent — never empty strings):
 *     brand    ← brand | make
 *     unitType ← unit_type | unitType | appliance
 *   `model` has NO RAG filter slot, so it is folded into the question TEXT.
 *
 * @param {Object} job
 * @returns {{ question: string, filters: { brand?: string, unitType?: string } }}
 */
function buildQuestion(job) {
    const j = job || {};

    const problem = trimOrEmpty(j.description) || trimOrEmpty(j.comments) || '';
    const svc = trimOrEmpty(j.job_type) || trimOrEmpty(j.service_name) || null;

    const map = metadataLookup(j.metadata);
    const brand = pickFrom(map, ['brand', 'make']);
    const unitType = pickFrom(map, ['unit_type', 'unittype', 'appliance']);
    const model = pickFrom(map, ['model']);

    const filters = {};
    if (brand) filters.brand = brand;
    if (unitType) filters.unitType = unitType;

    // No problem AND no service context ⇒ nothing to ask (model alone is not a question).
    if (!problem && !svc) {
        return { question: '', filters };
    }

    const parts = [];
    if (problem) parts.push(`Customer-reported problem: ${problem}.`);
    if (svc) parts.push(`Service type: ${svc}.`);
    if (model) parts.push(`Model: ${model}.`);

    return { question: parts.join(' '), filters };
}

// ─── formatNote (spec §3.5) ──────────────────────────────────────────────────

/**
 * Likelihood → integer percent, per the spec pct rule:
 *   likelihood ≤ 1 ⇒ round(likelihood * 100);  likelihood > 1 ⇒ round(likelihood).
 * Non-numeric / NaN / non-finite ⇒ null (bullet then omits the "% likely" suffix).
 */
function likelihoodToPct(likelihood) {
    if (typeof likelihood !== 'number' || !Number.isFinite(likelihood)) return null;
    return likelihood <= 1 ? Math.round(likelihood * 100) : Math.round(likelihood);
}

/** One "Probable causes" bullet: `- <cause>[ — ~<pct>% likely]`. */
function formatCauseBullet(c) {
    const cause = c && typeof c.cause === 'string' ? c.cause : '';
    const pct = likelihoodToPct(c ? c.likelihood : null);
    return pct === null ? `- ${cause}` : `- ${cause} — ~${pct}% likely`;
}

/**
 * Render the diagnostic note markdown from the normalized ragClient object
 * (spec §3.1 shape). Sections in fixed order, each emitted only when it has
 * content; the "Diagnostic mode" header is omitted entirely when absent (E-04).
 * The literal author string 'AI Repair Advisor' is applied later by `addNote`,
 * NOT here — this returns note TEXT only.
 *
 * @param {Object} normalized  { summary, causes, steps, diagnosticMode, ... }
 * @returns {string|null}  markdown, or null if no groundable section renders.
 */
function formatNote(normalized) {
    const n = normalized || {};
    const causes = Array.isArray(n.causes) ? n.causes : [];
    const steps = Array.isArray(n.steps) ? n.steps : [];
    const diagnosticMode = trimOrEmpty(n.diagnosticMode) || null;
    const summary = trimOrEmpty(n.summary) || null;

    const hasCauses = causes.length > 0;
    const hasSteps = steps.length > 0;
    const hasMode = !!diagnosticMode;

    // Defensive: nothing groundable ⇒ no note (title/disclaimer-only never ships).
    // A summary alone is NOT enough — mirrors ragClient's empty ⇒ null rule.
    if (!hasCauses && !hasSteps && !hasMode) return null;

    const blocks = [];

    // Header block: title (always) + optional summary line (single newline, no gap).
    let header = '**AI Repair Advisor — diagnostic starting point**';
    if (summary) header += `\n${summary}`;
    blocks.push(header);

    // (a) Probable causes.
    if (hasCauses) {
        const lines = ['**Probable causes**'];
        for (const c of causes) lines.push(formatCauseBullet(c));
        blocks.push(lines.join('\n'));
    }

    // (b) Diagnosis steps.
    if (hasSteps) {
        const lines = ['**Diagnosis steps**'];
        steps.forEach((s, i) => {
            const stepText = s && typeof s.step === 'string' ? s.step : '';
            const expected = s ? trimOrEmpty(s.expected) : '';
            lines.push(expected ? `${i + 1}. ${stepText} (expected: ${expected})` : `${i + 1}. ${stepText}`);
        });
        blocks.push(lines.join('\n'));
    }

    // (c) Diagnostic mode — ONLY when present (header-and-all omitted otherwise).
    if (hasMode) {
        blocks.push(`**Diagnostic mode**\n${diagnosticMode}`);
    }

    // Footer disclaimer (always, when a note is produced).
    blocks.push('_AI-generated from service-manual knowledge base — verify on-site before acting._');

    return blocks.join('\n\n');
}

// ─── runForJob (spec §3.3) — REPAIR-ADVISOR-T4 ───────────────────────────────
//
// Detached, best-effort orchestrator. Fired (via setImmediate, from the
// `kb-diagnostics` subscriber) after a human-path `job.created`. The ENTIRE body
// is wrapped so any throw ⇒ console.warn + NO note; runForJob NEVER throws (the
// `.catch(()=>{})` at the call site is belt-and-suspenders). Ordered step
// contract — every early-return means no note (spec §3.3 table / §4 matrix):
//   1. Gate  — isAppConnected re-checked here (honors mid-flight disconnect, E-01).
//   2. Load  — company-scoped getJobById (foreign/deleted ⇒ null ⇒ STOP, E-07/§5).
//   3. Idem  — a prior 'AI Repair Advisor' note ⇒ STOP (one per job, ever, E-02).
//   4. Ask?  — empty question ⇒ STOP (nothing to ask).
//   5. RAG   — ask() null (down/blank/empty) ⇒ STOP (UC-06/E-03/E-05/E-06/E-10).
//   6. Text  — formatNote null (nothing groundable) ⇒ STOP.
//   7. Write — addNote(jobId, text, [], 'AI Repair Advisor', 'system').
//
// Lazy require()s live inside the function to avoid boot-order cycles (same idiom
// the subscriber uses); jest's top-level mocks still intercept them.
async function runForJob({ jobId, companyId } = {}) {
    try {
        const ragClient = require('./ragClient');
        const jobsService = require('./jobsService');
        const marketplaceService = require('./marketplaceService');

        // 1. Gate (re-checked at run start — mid-flight disconnect honored).
        if (!(await marketplaceService.isAppConnected(companyId, marketplaceService.AI_REPAIR_ADVISOR_APP_KEY))) return;

        // 2. Load the job, company-scoped. Foreign/deleted ⇒ null ⇒ no note.
        const job = await jobsService.getJobById(jobId, companyId);
        if (!job) return;

        // 3. Idempotency — the advisor is the sole writer of that exact author string.
        if ((job.notes || []).some(n => n && n.author === 'AI Repair Advisor')) return;

        // 4. Assemble the question; empty ⇒ nothing to ask.
        const { question, filters } = buildQuestion(job);
        if (!question) return;

        // 5. Ask the RAG service; null ⇒ down/blank/empty ⇒ no note.
        const normalized = await ragClient.ask({ question, filters });
        if (!normalized) return;

        // 6. Render the note text; null ⇒ nothing groundable ⇒ no note.
        const text = formatNote(normalized);
        if (!text) return;

        // 7. Append the single advisor note (author + created_by='system').
        await jobsService.addNote(
            jobId,
            text,
            [],
            'AI Repair Advisor',
            'system',
            null,
            companyId
        );
    } catch (err) {
        // Best-effort: never re-thrown — a failure must not affect the job-create path.
        console.warn('[kb-diagnostics] runForJob failed:', err && err.message);
    }
}

module.exports = {
    buildQuestion,
    formatNote,
    runForJob,
};
