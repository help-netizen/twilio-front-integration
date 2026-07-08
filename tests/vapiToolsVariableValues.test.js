/**
 * OUTBOUND-PARTS-CALL-001 — buildSkillInput variableValues anti-spoof precedence.
 *
 * Binding: spec §C / arch — the server-injected, model-untrusted identity in
 * `call.assistantOverrides.variableValues` MUST override any same-named field the
 * model re-sent in tool `args`, so an outbound skill's ownership pre-check keys on
 * identity the model cannot spoof. Inbound Sara calls carry NO assistantOverrides,
 * so variableValues threading is a pure no-op (Sara/legacy behavior byte-identical).
 *
 * We import `buildSkillInput` directly (exported additively from the route) and
 * assert the merge order without any HTTP/DB/skill dispatch.
 */

const { buildSkillInput } = require('../backend/src/routes/vapi-tools');

describe('buildSkillInput — variableValues override model args (anti-spoof)', () => {
    test('outbound: assistantOverrides.variableValues WIN over model-sent same-named args', () => {
        // The model tries to spoof identity via args (jobId:'SPOOF') and sends its
        // own field (foo). The server injected the real identity at call-open.
        const args = { jobId: 'SPOOF', foo: 1 };
        const call = {
            assistantOverrides: { variableValues: { jobId: 'REAL', contactId: 'C1' } },
        };

        const input = buildSkillInput('confirmPartsVisit', args, call);

        // Server-injected identity wins — the model cannot spoof jobId.
        expect(input.jobId).toBe('REAL');
        // …and its other injected fields are threaded in.
        expect(input.contactId).toBe('C1');
        // Non-conflicting model args are preserved.
        expect(input.foo).toBe(1);
    });

    test('inbound (no assistantOverrides): variableValues is a no-op, input = model args', () => {
        // Sara / legacy inbound path: no assistantOverrides.variableValues at all.
        const args = { jobId: 'MODEL', foo: 1 };
        const call = { customer: { number: '+16170001111' } };

        const input = buildSkillInput('confirmPartsVisit', args, call);

        // No override object → model args pass through unchanged (byte-identical),
        // plus the silent caller-ID fallback for non-legacy skills (does not
        // clobber the anti-spoof assertion below).
        expect(input.jobId).toBe('MODEL');
        expect(input.foo).toBe(1);
    });
});
