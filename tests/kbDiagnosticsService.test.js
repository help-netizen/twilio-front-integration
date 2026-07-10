// REPAIR-ADVISOR-001 · Groups B (TC-RA-020…027) + C (TC-RA-030…036)
// — kbDiagnosticsService pure helpers buildQuestion + formatNote.
//
// Run (worktree override is MANDATORY — root jest config ignores /.claude/worktrees/):
//   npx jest --runTestsByPath tests/kbDiagnosticsService.test.js --testPathIgnorePatterns "/node_modules/"
//
// Pure functions — NO mocks (spec Test-Cases §B/§C "Mock seam: pure — no mocks").
// buildQuestion returns { question, filters } (spec §3.4). formatNote returns the
// note TEXT string or null (spec §3.5); the literal author 'AI Repair Advisor' is
// applied later by addNote, not here (asserted in T4/TC-RA-052).
//
// NOTE (T4 append point): REPAIR-ADVISOR-T4 appends its own runForJob /
// idempotency (D) / integration (E) / tenant-isolation (H·080) describe blocks
// BELOW group C, with the group-E jest.mock seams. Do NOT modify these B/C blocks.

const { buildQuestion, formatNote } = require('../backend/src/services/kbDiagnosticsService');

// ─── Group B — buildQuestion(job) (TC-RA-020…027) ────────────────────────────

describe('kbDiagnosticsService.buildQuestion (REPAIR-ADVISOR-001, Group B)', () => {
    // TC-RA-020 — description is the primary problem text (P0)
    it('uses description as the primary problem text, not comments', () => {
        const { question } = buildQuestion({
            description: 'Fridge not cooling',
            comments: 'call before',
            job_type: 'Refrigerator repair',
        });
        expect(question).toContain('Fridge not cooling');
        expect(question).toContain('Service type: Refrigerator repair');
        expect(question).not.toContain('call before'); // comments ignored when description present
    });

    // TC-RA-021 — empty description → falls back to comments (P1)
    it('falls back to comments when description is empty/whitespace', () => {
        const { question } = buildQuestion({
            description: '   ',
            comments: 'leaking from bottom',
            service_name: 'Dishwasher',
        });
        expect(question).toContain('leaking from bottom');
        expect(question).toContain('Service type: Dishwasher');
    });

    // TC-RA-022 — both problem sources empty → '' (skip) unless service present (P1)
    it('returns an empty question when problem AND service are both absent (step-4 STOP)', () => {
        const { question, filters } = buildQuestion({
            description: '', comments: '', job_type: null, service_name: null, metadata: {},
        });
        expect(question).toBe(''); // signals runForJob step-4 STOP
        expect(filters).toEqual({});
    });
    it('still forms a question from service context alone (thin-description path)', () => {
        const { question } = buildQuestion({ description: '', comments: '', job_type: 'Oven repair' });
        expect(question).not.toBe('');
        expect(question).toContain('Service type: Oven repair');
    });

    // TC-RA-023 — job_type / service_name folded in; job_type wins (P1)
    it('prefers job_type over service_name for the service context', () => {
        const { question } = buildQuestion({
            description: 'noise', job_type: 'Washer repair', service_name: 'Appliance',
        });
        expect(question).toContain('Service type: Washer repair');
        expect(question).not.toContain('Appliance');
    });

    // TC-RA-024 — filters.brand / filters.unitType from metadata + alias order (P1)
    it('extracts filters.brand / filters.unitType from metadata', () => {
        const { filters } = buildQuestion({
            description: 'x', metadata: { brand: 'Samsung', unit_type: 'Front-load washer' },
        });
        expect(filters).toEqual({ brand: 'Samsung', unitType: 'Front-load washer' });
    });
    it('uses the alias key when the primary metadata key is absent (first non-empty wins)', () => {
        // brand absent ⇒ `make`; unit_type absent ⇒ `unitType`/`appliance`.
        const viaMake = buildQuestion({ description: 'x', metadata: { make: 'Bosch', appliance: 'Dryer' } });
        expect(viaMake.filters).toEqual({ brand: 'Bosch', unitType: 'Dryer' });
        // primary present ⇒ primary wins over the alias.
        const primaryWins = buildQuestion({
            description: 'x', metadata: { brand: 'LG', make: 'IgnoredMake', unit_type: 'Washer', appliance: 'IgnoredAppliance' },
        });
        expect(primaryWins.filters).toEqual({ brand: 'LG', unitType: 'Washer' });
    });

    // TC-RA-025 — metadata key match is case-insensitive (+ trimmed) (P1)
    it('matches metadata keys case-insensitively and trims key whitespace', () => {
        const { filters } = buildQuestion({
            description: 'x', metadata: { Brand: 'LG', ' UNIT_TYPE ': 'Dryer' },
        });
        expect(filters).toEqual({ brand: 'LG', unitType: 'Dryer' });
    });

    // TC-RA-026 — model folded into question TEXT, never into filters (P1)
    it('folds model into the question text and never into filters', () => {
        const { question, filters } = buildQuestion({ description: 'x', metadata: { model: 'WF45' } });
        expect(question).toContain('Model: WF45.');
        expect(filters).toEqual({}); // no model/brand/unitType keys
        expect(filters).not.toHaveProperty('model');
    });

    // TC-RA-027 — no brand/unit metadata → filters === {} (no empty-string keys) (P0)
    it('returns filters === {} when no brand/unit metadata (never empty-string keys)', () => {
        expect(buildQuestion({ description: 'x', metadata: {} }).filters).toEqual({});
        expect(buildQuestion({ description: 'x', metadata: null }).filters).toEqual({});
        // Explicitly never { brand:'', unitType:'' }.
        const { filters } = buildQuestion({ description: 'x', metadata: {} });
        expect(filters.brand).toBeUndefined();
        expect(filters.unitType).toBeUndefined();
    });
});

// ─── Group C — formatNote(normalized) (TC-RA-030…036) ────────────────────────

describe('kbDiagnosticsService.formatNote (REPAIR-ADVISOR-001, Group C)', () => {
    // TC-RA-030 — full 3-section render, verbatim per spec §3.5 template (P0)
    it('renders the full 3-section note verbatim (title + summary + causes + steps + diagnostic mode + disclaimer)', () => {
        const normalized = {
            summary: "Front-load washer won't drain — most consistent with a blocked pump or clogged filter.",
            causes: [
                { cause: 'Clogged drain pump filter', likelihood: 0.55 },
                { cause: 'Failed drain pump motor', likelihood: 0.30 },
                { cause: 'Kinked or blocked drain hose', likelihood: 0.15 },
            ],
            steps: [
                { step: 'Power off and unplug the unit before servicing.' },
                { step: 'Open the pump filter access panel; inspect for debris', expected: 'coins/lint/hair' },
                { step: 'Check the drain hose for kinks and clogs at the standpipe.' },
                { step: 'Run a spin-only cycle and listen for the pump energizing.' },
            ],
            diagnosticMode: 'Hold Spin + Soil for 3 seconds within 10 seconds of powering on to enter service test mode; press Start to run the drain test.',
            confidence: 0.8,
            grounded: true,
        };
        const expected = [
            '**AI Repair Advisor — diagnostic starting point**',
            "Front-load washer won't drain — most consistent with a blocked pump or clogged filter.",
            '',
            '**Probable causes**',
            '- Clogged drain pump filter — ~55% likely',
            '- Failed drain pump motor — ~30% likely',
            '- Kinked or blocked drain hose — ~15% likely',
            '',
            '**Diagnosis steps**',
            '1. Power off and unplug the unit before servicing.',
            '2. Open the pump filter access panel; inspect for debris (expected: coins/lint/hair)',
            '3. Check the drain hose for kinks and clogs at the standpipe.',
            '4. Run a spin-only cycle and listen for the pump energizing.',
            '',
            '**Diagnostic mode**',
            'Hold Spin + Soil for 3 seconds within 10 seconds of powering on to enter service test mode; press Start to run the drain test.',
            '',
            '_AI-generated from service-manual knowledge base — verify on-site before acting._',
        ].join('\n');
        expect(formatNote(normalized)).toBe(expected);
    });

    // TC-RA-031 — 2-section variant: diagnosticMode:null omits the header entirely (P0)
    it('omits the Diagnostic mode header entirely when diagnosticMode is null (2-section variant)', () => {
        const note = formatNote({
            summary: null,
            causes: [{ cause: 'Bad valve', likelihood: 0.6 }],
            steps: [{ step: 'Inspect the valve' }],
            diagnosticMode: null,
        });
        expect(note).toContain('**Probable causes**');
        expect(note).toContain('**Diagnosis steps**');
        expect(note).toContain('_AI-generated from service-manual knowledge base — verify on-site before acting._');
        expect(note).not.toContain('Diagnostic mode'); // no empty section, no placeholder
    });

    // TC-RA-032 — summary optional: no summary → no summary line, title still present (P1)
    it('omits the summary line when summary is absent (title still present)', () => {
        const note = formatNote({ summary: null, causes: [{ cause: 'X', likelihood: 0.5 }], steps: [] });
        expect(note).toContain('**AI Repair Advisor — diagnostic starting point**');
        // The first block is exactly the title (no summary line glued to it).
        expect(note.split('\n\n')[0]).toBe('**AI Repair Advisor — diagnostic starting point**');
    });

    // TC-RA-033 — likelihood rendering: ≤1 ×100, >1 as-is, null/NaN omits suffix (P1)
    it('renders likelihood per rule: ≤1 ×100, >1 as-is, null omits the suffix', () => {
        const note = formatNote({
            summary: null,
            causes: [
                { cause: 'A', likelihood: 0.55 },
                { cause: 'B', likelihood: 70 },
                { cause: 'C', likelihood: null },
            ],
            steps: [],
        });
        expect(note).toContain('- A — ~55% likely');
        expect(note).toContain('- B — ~70% likely');
        expect(note).toContain('- C'); // bare bullet
        expect(note).not.toContain('- C —'); // no "% likely" suffix for null likelihood
    });

    // TC-RA-034 — step `expected` optional (P1)
    it('appends "(expected: …)" only for steps that carry expected', () => {
        const note = formatNote({
            summary: null,
            causes: [],
            steps: [{ step: 'A' }, { step: 'B', expected: 'debris' }],
        });
        expect(note).toContain('1. A');
        expect(note).not.toContain('1. A (expected'); // no suffix on the expected-less step
        expect(note).toContain('2. B (expected: debris)');
    });

    // TC-RA-035 — no Stage-2 sections ever (parts / dispatcher-questions / safety) (P2)
    it('never renders Stage-2 sections even when the object carries parts/safety', () => {
        const note = formatNote({
            summary: null,
            causes: [{ cause: 'Bad valve', likelihood: 0.5 }],
            steps: [{ step: 'Inspect the valve' }],
            diagnosticMode: null,
            parts: [{ name: 'valve' }],
            safety: ['Disconnect power first'],
        });
        expect(note).not.toContain('Parts');
        expect(note).not.toContain('Safety');
        expect(note).not.toContain('Questions');
    });

    // TC-RA-036 — defensive null: nothing groundable → return null (P2)
    it('returns null when no groundable section renders (summary alone is not enough)', () => {
        expect(formatNote({ summary: 'Might be the pump.', causes: [], steps: [], diagnosticMode: null })).toBeNull();
        expect(formatNote({})).toBeNull();
        expect(formatNote(null)).toBeNull();
    });
});

// ─── T4 APPEND POINT ─────────────────────────────────────────────────────────
// REPAIR-ADVISOR-T4 appends runForJob (D/E) + tenant-isolation (H·TC-RA-080)
// describe blocks below, with jest.mock seams for ragClient / jobsService /
// marketplaceService. Keep the B/C blocks above untouched.

// Mock seams (jest hoists these above the module require at the top of the file):
// the lazy require('./ragClient' | './jobsService' | './marketplaceService')
// inside runForJob is intercepted by these top-level mocks (Test-Cases Assumption 3).
jest.mock('../backend/src/services/ragClient', () => ({ ask: jest.fn() }));
jest.mock('../backend/src/services/jobsService', () => ({ getJobById: jest.fn(), addNote: jest.fn() }));
jest.mock('../backend/src/services/marketplaceService', () => ({
    isAppConnected: jest.fn(),
    AI_REPAIR_ADVISOR_APP_KEY: 'ai-repair-advisor',
}));

const { runForJob } = require('../backend/src/services/kbDiagnosticsService');
const ragClient = require('../backend/src/services/ragClient');
const jobsService = require('../backend/src/services/jobsService');
const marketplaceService = require('../backend/src/services/marketplaceService');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';

// A normalized ragClient.ask payload that formatNote renders into a real note.
function goodPayload() {
    return {
        summary: 'Washer won’t drain.',
        causes: [{ cause: 'Clogged drain pump filter', likelihood: 0.55 }],
        steps: [{ step: 'Open the pump filter access panel', expected: 'debris' }],
        diagnosticMode: 'Hold Spin + Soil for 3 seconds to enter service test mode.',
        confidence: 0.8,
        grounded: true,
    };
}

// ─── Group D — idempotency guard via runForJob (TC-RA-040) ───────────────────

describe('kbDiagnosticsService.runForJob idempotency (REPAIR-ADVISOR-001, Group D)', () => {
    beforeEach(() => {
        jest.resetAllMocks();
    });

    // TC-RA-040 — existing advisor note → early STOP, no RAG, no addNote (P0)
    it('stops when an advisor note already exists (no RAG, no addNote)', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(true);
        jobsService.getJobById.mockResolvedValue({
            id: 'J1',
            description: 'washer wont drain',
            notes: [{ author: 'AI Repair Advisor', text: 'earlier note' }, { author: 'Someone' }],
        });

        await runForJob({ jobId: 'J1', companyId: COMPANY_A });

        expect(ragClient.ask).not.toHaveBeenCalled();
        expect(jobsService.addNote).not.toHaveBeenCalled();
    });

    // TC-RA-040 (null-guard) — notes containing a null entry must not crash the .some() guard
    it('handles a null entry in notes without throwing and still detects the advisor note', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(true);
        jobsService.getJobById.mockResolvedValue({
            id: 'J1',
            description: 'washer wont drain',
            notes: [null, { author: 'AI Repair Advisor' }],
        });

        await expect(runForJob({ jobId: 'J1', companyId: COMPANY_A })).resolves.toBeUndefined();

        expect(ragClient.ask).not.toHaveBeenCalled();
        expect(jobsService.addNote).not.toHaveBeenCalled();
    });
});

// ─── Group E — runForJob orchestration (TC-RA-050…059) ───────────────────────

describe('kbDiagnosticsService.runForJob (REPAIR-ADVISOR-001, Group E)', () => {
    let warnSpy;

    beforeEach(() => {
        jest.resetAllMocks();
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    // TC-RA-050 — app NOT connected → STOP @ step 1 (no read, no RAG, no note) (P0)
    it('stops at step 1 when the app is not connected (no getJobById, no ask, no addNote)', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(false);

        await runForJob({ jobId: 'J1', companyId: COMPANY_A });

        expect(marketplaceService.isAppConnected).toHaveBeenCalledWith(COMPANY_A, 'ai-repair-advisor');
        expect(jobsService.getJobById).not.toHaveBeenCalled();
        expect(ragClient.ask).not.toHaveBeenCalled();
        expect(jobsService.addNote).not.toHaveBeenCalled();
    });

    // TC-RA-051 — connected but getJobById → null (deleted/foreign) → no RAG, no note, no throw (P0)
    it('stops at step 2 when getJobById returns null (deleted/foreign job)', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(true);
        jobsService.getJobById.mockResolvedValue(null);

        await expect(runForJob({ jobId: 'J1', companyId: COMPANY_A })).resolves.toBeUndefined();

        expect(ragClient.ask).not.toHaveBeenCalled();
        expect(jobsService.addNote).not.toHaveBeenCalled();
    });

    // TC-RA-052 — connected + job + ask→object → addNote called ONCE with exact args (P0)
    it('appends exactly one note with (jobId, <text>, [], "AI Repair Advisor", "system")', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(true);
        jobsService.getJobById.mockResolvedValue({ id: 'J1', description: 'washer wont drain', notes: [] });
        ragClient.ask.mockResolvedValue(goodPayload());

        await runForJob({ jobId: 'J1', companyId: COMPANY_A });

        expect(jobsService.addNote).toHaveBeenCalledTimes(1);
        const [jobIdArg, textArg, attArg, authorArg, createdByArg] = jobsService.addNote.mock.calls[0];
        expect(jobIdArg).toBe('J1');
        expect(typeof textArg).toBe('string');
        expect(textArg.length).toBeGreaterThan(0);
        expect(textArg).toContain('**AI Repair Advisor — diagnostic starting point**');
        expect(attArg).toEqual([]);
        expect(authorArg).toBe('AI Repair Advisor');
        expect(createdByArg).toBe('system');
    });

    // TC-RA-053 — connected + ask→null → no note (P0)
    it('does not append a note when ask returns null', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(true);
        jobsService.getJobById.mockResolvedValue({ id: 'J1', description: 'washer wont drain', notes: [] });
        ragClient.ask.mockResolvedValue(null);

        await expect(runForJob({ jobId: 'J1', companyId: COMPANY_A })).resolves.toBeUndefined();

        expect(jobsService.addNote).not.toHaveBeenCalled();
    });

    // TC-RA-054 — ask throws → swallowed, no note, no re-throw, warn logged (P0)
    it('swallows a thrown error from ask (no note, no re-throw, logs [kb-diagnostics])', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(true);
        jobsService.getJobById.mockResolvedValue({ id: 'J1', description: 'washer wont drain', notes: [] });
        ragClient.ask.mockRejectedValue(new Error('boom'));

        await expect(runForJob({ jobId: 'J1', companyId: COMPANY_A })).resolves.toBeUndefined();

        expect(jobsService.addNote).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
        expect(warnSpy.mock.calls[0][0]).toContain('[kb-diagnostics]');
    });

    // TC-RA-055 — company scoping: reads/gate use the event's companyId (P0)
    it('uses the event companyId for the gate and the company-scoped read', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(true);
        jobsService.getJobById.mockResolvedValue({ id: 'J1', description: 'washer wont drain', notes: [] });
        ragClient.ask.mockResolvedValue(goodPayload());

        await runForJob({ jobId: 'J1', companyId: COMPANY_A });

        expect(marketplaceService.isAppConnected).toHaveBeenCalledWith(COMPANY_A, 'ai-repair-advisor');
        expect(jobsService.getJobById).toHaveBeenCalledWith('J1', COMPANY_A);
    });

    // TC-RA-056 — empty question → STOP @ step 4 (no RAG, no note) (P1)
    it('stops at step 4 when buildQuestion yields an empty question', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(true);
        jobsService.getJobById.mockResolvedValue({
            description: '', comments: '', job_type: null, service_name: null, metadata: {}, notes: [],
        });

        await runForJob({ jobId: 'J1', companyId: COMPANY_A });

        expect(ragClient.ask).not.toHaveBeenCalled();
        expect(jobsService.addNote).not.toHaveBeenCalled();
    });

    // TC-RA-057 — formatNote → null → STOP @ step 6 (no note) (P1)
    it('stops at step 6 when formatNote yields null (nothing groundable)', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(true);
        jobsService.getJobById.mockResolvedValue({ id: 'J1', description: 'washer wont drain', notes: [] });
        // ask returns a (mock) object that formatNote renders to null: no causes/steps/mode.
        ragClient.ask.mockResolvedValue({ summary: 'Only a summary.', causes: [], steps: [], diagnosticMode: null });

        await expect(runForJob({ jobId: 'J1', companyId: COMPANY_A })).resolves.toBeUndefined();

        expect(ragClient.ask).toHaveBeenCalledTimes(1);
        expect(jobsService.addNote).not.toHaveBeenCalled();
    });

    // TC-RA-058 — addNote throws (DB) → outer guard swallows, no re-throw (P1)
    it('swallows a thrown error from addNote (best-effort, no re-throw)', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(true);
        jobsService.getJobById.mockResolvedValue({ id: 'J1', description: 'washer wont drain', notes: [] });
        ragClient.ask.mockResolvedValue(goodPayload());
        jobsService.addNote.mockRejectedValue(new Error('db down'));

        await expect(runForJob({ jobId: 'J1', companyId: COMPANY_A })).resolves.toBeUndefined();

        expect(warnSpy).toHaveBeenCalled();
        expect(warnSpy.mock.calls[0][0]).toContain('[kb-diagnostics]');
    });

    // TC-RA-059 — ordered gate: not-connected short-circuits BEFORE getJobById (P1)
    it('re-evaluates the gate first: not-connected never reaches getJobById', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(false);

        await runForJob({ jobId: 'J1', companyId: COMPANY_A });

        expect(jobsService.getJobById).not.toHaveBeenCalled();
    });
});

// ─── Group H — tenant isolation (TC-RA-080, MANDATORY) ───────────────────────

describe('kbDiagnosticsService.runForJob tenant isolation (REPAIR-ADVISOR-001, Group H)', () => {
    beforeEach(() => {
        jest.resetAllMocks();
    });

    // TC-RA-080 — A-connected / B-not → note attaches to A's job only (P0)
    it('attaches the note only to company A’s job; B (not connected) gets nothing', async () => {
        marketplaceService.isAppConnected.mockImplementation((co) => Promise.resolve(co === COMPANY_A));
        jobsService.getJobById.mockImplementation((id, co) =>
            Promise.resolve(co === COMPANY_A ? { id, notes: [], description: 'x' } : null));
        ragClient.ask.mockResolvedValue(goodPayload());

        // Company A — connected → note appended once for its own job, scoped by COMPANY_A.
        await runForJob({ jobId: 'JA', companyId: COMPANY_A });
        expect(jobsService.getJobById).toHaveBeenCalledWith('JA', COMPANY_A);
        expect(jobsService.addNote).toHaveBeenCalledTimes(1);
        expect(jobsService.addNote.mock.calls[0][0]).toBe('JA');

        // Company B — gate false ⇒ no read, no RAG, no note (no cross-tenant leak).
        await runForJob({ jobId: 'JB', companyId: COMPANY_B });
        expect(marketplaceService.isAppConnected).toHaveBeenLastCalledWith(COMPANY_B, 'ai-repair-advisor');
        expect(jobsService.getJobById).not.toHaveBeenCalledWith('JB', COMPANY_B);
        expect(ragClient.ask).toHaveBeenCalledTimes(1); // only A's call, never B
        expect(jobsService.addNote).toHaveBeenCalledTimes(1); // still only A's note
    });
});
