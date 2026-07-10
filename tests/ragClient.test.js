// REPAIR-ADVISOR-001 · Group A (TC-RA-001…016) — ragClient.ask parse + transport.
//
// Run (worktree override is MANDATORY — root jest config ignores /.claude/worktrees/):
//   npx jest --runTestsByPath tests/ragClient.test.js --testPathIgnorePatterns "/node_modules/"
//
// Mock seam mirrors tests/zenbookerClient.test.js: jest.doMock('axios', () => ({ create }))
// + jest.resetModules() + require() AFTER env is set (ragClient reads RAG_API_URL /
// RAG_TIMEOUT_MS at module-eval time).

const origUrl = process.env.RAG_API_URL;
const origTimeout = process.env.RAG_TIMEOUT_MS;

function restoreEnv(key, val) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
}

/**
 * Freshly load ragClient with a given RAG_API_URL and axios mock.
 * @param {Object}   o
 * @param {string}  [o.url]         - RAG_API_URL value; undefined ⇒ unset (deleted).
 * @param {Function}[o.post]        - axios instance `.post` mock.
 * @param {Function}[o.createImpl]  - override for `axios.create` (e.g. to throw).
 */
function loadRag({ url, post, createImpl } = {}) {
    jest.resetModules();
    if (url === undefined) delete process.env.RAG_API_URL;
    else process.env.RAG_API_URL = url;

    const postFn = post || jest.fn().mockResolvedValue({ data: {} });
    const createFn = createImpl || jest.fn(() => ({ post: postFn }));
    jest.doMock('axios', () => ({ create: createFn }));

    const ragClient = require('../backend/src/services/ragClient');
    return { ragClient, create: createFn, post: postFn };
}

/** Wrap a structured object as a fenced ```json block inside answer text. */
function fenced(obj, { bare = false, prefix = '', suffix = '' } = {}) {
    const tag = bare ? '```' : '```json';
    return `${prefix}${tag}\n${JSON.stringify(obj)}\n\`\`\`${suffix}`;
}

describe('ragClient.ask — parse + transport (REPAIR-ADVISOR-001, Group A)', () => {
    let warnSpy;

    beforeEach(() => {
        // Silence + capture the best-effort failure logs.
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
        jest.resetModules();
        jest.dontMock('axios');
        restoreEnv('RAG_API_URL', origUrl);
        restoreEnv('RAG_TIMEOUT_MS', origTimeout);
    });

    // TC-RA-001 — blank/unset RAG_API_URL ⇒ null, zero HTTP (inert; E-10 / FR-12).
    it('TC-RA-001: blank/unset RAG_API_URL → null with no HTTP (inert)', async () => {
        // unset
        let ctx = loadRag({ url: undefined });
        await expect(ctx.ragClient.ask({ question: 'washer wont drain' })).resolves.toBeNull();
        expect(ctx.create).not.toHaveBeenCalled();
        expect(ctx.post).not.toHaveBeenCalled();

        // explicit empty string
        ctx = loadRag({ url: '' });
        await expect(ctx.ragClient.ask({ question: 'washer wont drain' })).resolves.toBeNull();
        expect(ctx.create).not.toHaveBeenCalled();
        expect(ctx.post).not.toHaveBeenCalled();
    });

    // TC-RA-002 — happy path: full envelope → exact normalized object.
    it('TC-RA-002: full envelope → exact normalized object; POST /ask once with body', async () => {
        const answer = fenced({
            diagnosis_steps: ['Unplug unit', { step: 'Open filter panel', expected: 'debris' }],
            diagnostic_mode: 'Hold Spin+Soil 3s',
            confidence: 0.8,
            grounded: true,
        }, { prefix: 'Analysis:\n', suffix: '\nDone.' });
        const data = {
            summary: 'Front-load washer will not drain.',
            likely_causes: [
                { cause: 'Clogged filter', probability: 0.55 },
                { cause: 'Failed pump', probability: 0.3 },
            ],
            answer,
        };
        const post = jest.fn().mockResolvedValue({ data });
        const { ragClient } = loadRag({ url: 'https://rag.test/api', post });

        const result = await ragClient.ask({ question: 'washer wont drain', filters: { brand: 'LG' } });

        expect(result).toEqual({
            summary: 'Front-load washer will not drain.',
            causes: [
                { cause: 'Clogged filter', likelihood: 0.55 },
                { cause: 'Failed pump', likelihood: 0.3 },
            ],
            steps: [{ step: 'Unplug unit' }, { step: 'Open filter panel', expected: 'debris' }],
            diagnosticMode: 'Hold Spin+Soil 3s',
            confidence: 0.8,
            grounded: true,
        });
        expect(post).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledWith('/ask', {
            question: 'washer wont drain',
            filters: { brand: 'LG' },
        });
    });

    // TC-RA-003 — fenced block, steps + confidence but NO diagnostic_mode → diagnosticMode:null (E-04).
    it('TC-RA-003: no diagnostic_mode → diagnosticMode:null (groundable content still present)', async () => {
        const answer = fenced({ diagnosis_steps: ['Check hose'], confidence: 0.6 });
        const data = { likely_causes: [{ cause: 'Clog', probability: 0.5 }], answer };
        const post = jest.fn().mockResolvedValue({ data });
        const { ragClient } = loadRag({ url: 'https://rag.test/api', post });

        const result = await ragClient.ask({ question: 'x' });

        expect(result).not.toBeNull();
        expect(result.diagnosticMode).toBeNull();
        expect(result.causes.length).toBeGreaterThan(0);
        expect(result.steps.length).toBeGreaterThan(0);
    });

    // TC-RA-004 — repair_instructions alias populates steps.
    it('TC-RA-004: repair_instructions alias → steps populated', async () => {
        const answer = fenced({ repair_instructions: ['Check hose'] });
        const data = { likely_causes: [{ cause: 'X', probability: 0.5 }], answer };
        const post = jest.fn().mockResolvedValue({ data });
        const { ragClient } = loadRag({ url: 'https://rag.test/api', post });

        const result = await ragClient.ask({ question: 'x' });

        expect(result.steps).toEqual([{ step: 'Check hose' }]);
    });

    // TC-RA-005 — step normalization: string vs object; empty/blank dropped.
    it('TC-RA-005: step normalization — string vs object, empty dropped', async () => {
        const answer = fenced({
            diagnosis_steps: ['Do X', { step: 'Do Y', expected: 'Z' }, { instruction: 'Do W' }, '', { step: '' }],
        });
        const data = { answer };
        const post = jest.fn().mockResolvedValue({ data });
        const { ragClient } = loadRag({ url: 'https://rag.test/api', post });

        const result = await ragClient.ask({ question: 'x' });

        expect(result.steps).toEqual([
            { step: 'Do X' },
            { step: 'Do Y', expected: 'Z' },
            { step: 'Do W' },
        ]);
    });

    // TC-RA-006 — no fence, raw {…} in answer → first-{/last-} fallback.
    it('TC-RA-006: no fence but raw {…} → first-{/last-} fallback extraction', async () => {
        const data = {
            answer: 'Prefix text {"diagnosis_steps":["Reseat connector"],"diagnostic_mode":"Menu>Test"} trailing',
        };
        const post = jest.fn().mockResolvedValue({ data });
        const { ragClient } = loadRag({ url: 'https://rag.test/api', post });

        const result = await ragClient.ask({ question: 'x' });

        expect(result.steps).toEqual([{ step: 'Reseat connector' }]);
        expect(result.diagnosticMode).toBe('Menu>Test');
    });

    // TC-RA-007 — totally unparseable body → null (E-06 / AC-05).
    it('TC-RA-007: unparseable body (no fence, no braces) → null, no throw', async () => {
        const data = { answer: 'Sorry, I have no information.' };
        const post = jest.fn().mockResolvedValue({ data });
        const { ragClient } = loadRag({ url: 'https://rag.test/api', post });

        await expect(ragClient.ask({ question: 'x' })).resolves.toBeNull();
    });

    // TC-RA-008 — 200 but causes[]==0 && steps[]==0 && !diagnosticMode → null (empty⇒null, E-03).
    it('TC-RA-008: empty causes AND empty steps AND no diag-mode → null even on 200', async () => {
        const answer = fenced({ diagnosis_steps: [] });
        const data = { likely_causes: [], answer };
        const post = jest.fn().mockResolvedValue({ data });
        const { ragClient } = loadRag({ url: 'https://rag.test/api', post });

        await expect(ragClient.ask({ question: 'x' })).resolves.toBeNull();
    });

    // TC-RA-009 — summary alone is insufficient → null.
    it('TC-RA-009: summary present but no causes/steps/diag-mode → null', async () => {
        const data = { summary: 'Might be the pump.' };
        const post = jest.fn().mockResolvedValue({ data });
        const { ragClient } = loadRag({ url: 'https://rag.test/api', post });

        await expect(ragClient.ask({ question: 'x' })).resolves.toBeNull();
    });

    // TC-RA-010 — timeout → null, single attempt, warn logged (E-05 / UC-06 / AC-04).
    it('TC-RA-010: timeout → null; post called exactly once; [RAG] warn logged', async () => {
        const post = jest.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
        const { ragClient } = loadRag({ url: 'https://rag.test/api', post });

        const result = await ragClient.ask({ question: 'x' });

        expect(result).toBeNull();
        expect(post).toHaveBeenCalledTimes(1); // retryRequest(fn, 1) = single attempt
        expect(warnSpy).toHaveBeenCalled();
        expect(warnSpy.mock.calls[0][0]).toContain('[RAG]');
    });

    // TC-RA-011 — 5xx (502) → null; NOT retried at maxRetries=1.
    it('TC-RA-011: 502 → null; post called exactly once (not retried at maxRetries=1)', async () => {
        const post = jest.fn().mockRejectedValue({ response: { status: 502 } });
        const { ragClient } = loadRag({ url: 'https://rag.test/api', post });

        const result = await ragClient.ask({ question: 'x' });

        expect(result).toBeNull();
        expect(post).toHaveBeenCalledTimes(1);
    });

    // TC-RA-012 — 4xx (400) → short-circuit null, never retried.
    it('TC-RA-012: 400 → null; post called exactly once (4xx short-circuit)', async () => {
        const post = jest.fn().mockRejectedValue({ response: { status: 400 } });
        const { ragClient } = loadRag({ url: 'https://rag.test/api', post });

        const result = await ragClient.ask({ question: 'x' });

        expect(result).toBeNull();
        expect(post).toHaveBeenCalledTimes(1);
    });

    // TC-RA-013 — 429 is a retryable class (not short-circuited); one attempt at maxRetries=1.
    it('TC-RA-013: 429 → null; one attempt at maxRetries=1 (not short-circuited like other 4xx)', async () => {
        const post = jest.fn().mockRejectedValue({ response: { status: 429 } });
        const { ragClient } = loadRag({ url: 'https://rag.test/api', post });

        const result = await ragClient.ask({ question: 'x' });

        expect(result).toBeNull();
        expect(post).toHaveBeenCalledTimes(1);
    });

    // TC-RA-014 — likelihood passthrough: numeric kept, non-numeric/absent → null; empty cause dropped.
    it('TC-RA-014: likelihood numeric kept, non-numeric/absent → null, empty cause dropped', async () => {
        const data = {
            likely_causes: [
                { cause: 'A', probability: 0.4 },
                { cause: 'B', probability: 'high' },
                { cause: 'C' },
                { cause: '', probability: 0.9 },
            ],
        };
        const post = jest.fn().mockResolvedValue({ data });
        const { ragClient } = loadRag({ url: 'https://rag.test/api', post });

        const result = await ragClient.ask({ question: 'x' });

        expect(result.causes).toEqual([
            { cause: 'A', likelihood: 0.4 },
            { cause: 'B', likelihood: null },
            { cause: 'C', likelihood: null },
        ]);
    });

    // TC-RA-015 — never throws: internal fault path returns null (FR-10 defense).
    it('TC-RA-015: internal fault (axios.create throws / non-string body) → null, no throw', async () => {
        // (a) axios.create throws — construction fault.
        const createImpl = jest.fn(() => { throw new Error('axios boom'); });
        const ctxA = loadRag({ url: 'https://rag.test/api', createImpl });
        await expect(ctxA.ragClient.ask({ question: 'x' })).resolves.toBeNull();
        expect(warnSpy).toHaveBeenCalled();

        // (b) resolved but internally-odd body (non-string answer, non-array causes) — no throw.
        const post = jest.fn().mockResolvedValue({ data: { answer: 12345, likely_causes: 'nope' } });
        const ctxB = loadRag({ url: 'https://rag.test/api', post });
        await expect(ctxB.ragClient.ask({ question: 'x' })).resolves.toBeNull();
    });

    // TC-RA-016 — fenced-block confidence/grounded override top-level on conflict.
    it('TC-RA-016: fenced-block confidence/grounded override top-level', async () => {
        const answer = fenced({ diagnosis_steps: ['Step 1'], confidence: 0.9, grounded: true });
        const data = {
            confidence: 0.2,
            grounded: false,
            likely_causes: [{ cause: 'X', probability: 0.5 }],
            answer,
        };
        const post = jest.fn().mockResolvedValue({ data });
        const { ragClient } = loadRag({ url: 'https://rag.test/api', post });

        const result = await ragClient.ask({ question: 'x' });

        expect(result.confidence).toBe(0.9);
        expect(result.grounded).toBe(true);
    });
});
