import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Frontend unit tests (vitest). First mandatory suite: BUG-22 regression —
// BOTH http clients (fetch authedFetch + axios api.ts) must route a 401
// PHONE_VERIFICATION_REQUIRED to the 2FA gate instead of kc.login().
export default defineConfig({
    // Mirror vite.config's `@` → src alias so components under test resolve.
    resolve: {
        alias: { '@': path.resolve(__dirname, 'src') },
    },
    test: {
        environment: 'node',
        include: ['src/**/*.test.{ts,tsx}'],
    },
});
