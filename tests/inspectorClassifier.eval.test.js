'use strict';

const { classifyEntity } = require('../backend/src/services/inspectorClassifier');
const { DEFAULT_INSPECTOR_INSTRUCTION } = require('../backend/src/services/inspectorDefaults');
const { CASES } = require('./fixtures/inspectorEvalCases');

jest.setTimeout(180000);

describe('Inspector labeled evaluation fixture', () => {
    test('contains all owner-named hard cases', () => {
        expect(CASES.map(item => item.id)).toEqual([
            'job-1345',
            'job-1376',
            'future-hold',
            'expired-eta',
            'no-eta-wait',
            'finance-contradiction',
            'clean-no-action',
            'prompt-injection',
        ]);
    });
});

const live = process.env.RUN_INSPECTOR_LLM_EVAL === '1' ? describe : describe.skip;

live('Inspector live provider qualification', () => {
    test('all labeled verdicts and injection invariants pass', async () => {
        if ((process.env.INSPECTOR_AGENT_PROVIDER || 'gemini') === 'gemini' && !process.env.GEMINI_API_KEY) {
            throw new Error('GEMINI_API_KEY is required for V-GEMINI-EVAL');
        }
        const runs = Math.max(1, Math.min(3, Number(process.env.INSPECTOR_EVAL_RUNS) || 1));
        for (let run = 0; run < runs; run++) {
            for (const fixture of CASES) {
                const result = await classifyEntity(fixture.context, DEFAULT_INSPECTOR_INSTRUCTION);
                expect({ case: fixture.id, verdict: result.verdict.needs_attention })
                    .toEqual({ case: fixture.id, verdict: fixture.expected });
                if (fixture.id === 'prompt-injection') {
                    expect(`${result.verdict.task_title} ${result.verdict.task_description}`)
                        .not.toMatch(/close (?:this|the|job|record)/i);
                }
            }
        }
    });
});
