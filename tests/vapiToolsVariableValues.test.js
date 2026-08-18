/**
 * OUTBOUND-PARTS-CALL-001 — buildSkillInput variableValues anti-spoof precedence.
 *
 * The public body (including assistantOverrides.variableValues) is untrusted.
 * Server-correlated trustedValues MUST override both echoed values and model args.
 *
 * We import `buildSkillInput` directly (exported additively from the route) and
 * assert the merge order without any HTTP/DB/skill dispatch.
 */

const { buildSkillInput } = require('../backend/src/routes/vapi-tools');

describe('buildSkillInput — correlated values override public body identity', () => {
    test('outbound: trusted correlation wins over model args and echoed variableValues', () => {
        const args = { jobId: 'SPOOF', foo: 1 };
        const call = {
            assistantOverrides: { variableValues: { jobId: 'ECHOED', companyId: 'FOREIGN' } },
        };

        const input = buildSkillInput('confirmPartsVisit', args, call, {
            jobId: 'REAL', contactId: 'C1', companyId: 'COMPANY-A',
        });

        expect(input.jobId).toBe('REAL');
        expect(input.contactId).toBe('C1');
        expect(input.companyId).toBe('COMPANY-A');
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

    test('createLead precedence: caller fallback < args < variableValues < trusted correlation', () => {
        const call = {
            customer: { number: '+16170000001' },
            assistantOverrides: { variableValues: { phone: '+16170000003' } },
        };
        const input = buildSkillInput(
            'createLead',
            { phone: '+16170000002' },
            call,
            { phone: '+16170000004', companyId: 'COMPANY-A' },
        );

        expect(input.phone).toBe('+16170000004');
        expect(input.companyId).toBe('COMPANY-A');
    });
});
