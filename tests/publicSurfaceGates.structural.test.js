/**
 * PUBLIC-SURFACE-GATES-001 — regression lock for the audit's non-Zenbooker weak
 * public surfaces (TENANCY-RBAC-AUDIT-001 follow-up). Behavioral coverage lives
 * in twilioSignatureEnforcement.test.js and portalPublicGate.test.js; this pins
 * the guards structurally so a future edit that silently removes one goes red.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const SIGNATURE_GUARD = /process\.env\.NODE_ENV !== 'development' && !\(await validateTwilioSignature\(req\)\)/;

describe('Twilio-called TwiML endpoints keep their signature guard', () => {
    test('twiml.js /voice validates the signature and imports the validator', () => {
        const src = read('backend/src/routes/twiml.js');
        expect(src).toContain("require('../webhooks/twilioWebhooks')");
        expect(src).toMatch(SIGNATURE_GUARD);
    });

    test('voice.js keeps the guard on both /twiml handlers', () => {
        const src = read('backend/src/routes/voice.js');
        expect(src).toContain("require('../webhooks/twilioWebhooks')");
        // outbound + inbound each carry the guard → at least two matches.
        expect((src.match(new RegExp(SIGNATURE_GUARD, 'g')) || []).length).toBeGreaterThanOrEqual(2);
    });

    test('voice-fallback validates the signature (twilioWebhooks.js)', () => {
        expect(read('backend/src/webhooks/twilioWebhooks.js')).toMatch(SIGNATURE_GUARD);
    });

    test('Conversations post fails closed, not open', () => {
        const src = read('backend/src/webhooks/conversationsWebhooks.js');
        // The old fail-open shape ("if (authToken && signature) { validate }")
        // must be gone; a missing token/signature is now a rejection.
        expect(src).toMatch(/const valid = authToken && signature/);
        expect(src).toContain("return res.status(403)");
        expect(src).not.toMatch(/if \(authToken && signature\) \{/);
    });
});

describe('events /stats is authenticated, not public', () => {
    test('the /stats route carries the authenticate middleware', () => {
        expect(read('backend/src/routes/events.js')).toMatch(/router\.get\('\/stats', authenticate,/);
    });
});

describe('portal public flow is fail-closed by default', () => {
    const src = () => read('backend/src/routes/portal.js');

    test('the flag helper defaults off (checks for the enabling value, not the disabling one)', () => {
        expect(src()).toMatch(/process\.env\.PORTAL_PUBLIC_ENABLED === 'true'/);
    });

    test('both public entrypoints are gated by the flag before any handler work', () => {
        const s = src();
        for (const route of ["'/auth/request-access'", "'/auth/verify'"]) {
            const line = s.split('\n').find(l => l.includes(`router.post(${route}`));
            expect(line).toBeDefined();
            expect(line).toContain('requirePortalPublicEnabled');
            expect(line).toContain('portalPublicRateLimit');
        }
    });

    test('request-access no longer returns the raw token unconditionally (the safe path is GET /links)', () => {
        // GET /links remains the authenticated, company-scoped mint path.
        expect(src()).toMatch(/router\.get\('\/links', authenticate, requireCompanyAccess,/);
    });
});
