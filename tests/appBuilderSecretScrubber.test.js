'use strict';

const { scrubSecrets } = require('../backend/src/services/appBuilderSecretScrubber');

describe('APP-BUILD-001 input secret scrubbing', () => {
    test('removes bearer, api-key, password, and long base64 material', () => {
        const bearer = 'eyJhbGciOiJIUzI1NiJ9.payload.signaturevalue';
        const apiKey = 'api-key-value-that-must-not-persist';
        const password = 'correct-horse-battery-staple';
        const base64 = 'Q'.repeat(80);
        const scrubbed = scrubSecrets(
            `Bearer ${bearer}\napi_key=${apiKey}\npassword: ${password}\n${base64}`
        );
        expect(scrubbed).toContain('Bearer [REDACTED_BEARER_TOKEN]');
        expect(scrubbed).toContain('api_key=[REDACTED_API_KEY]');
        expect(scrubbed).toContain('password: [REDACTED_PASSWORD]');
        expect(scrubbed).toContain('[REDACTED_BASE64_SECRET]');
        for (const secret of [bearer, apiKey, password, base64]) {
            expect(scrubbed).not.toContain(secret);
        }
    });

    test('preserves ordinary app requirements', () => {
        const text = 'List open tasks, group them by due date, and return a short summary.';
        expect(scrubSecrets(text)).toBe(text);
    });
});
