import { describe, expect, it } from 'vitest';
import { isPublicAuthPath } from './AuthProvider';

/**
 * A public path must be matched by segment, not by string prefix.
 *
 * The prefix version shipped to production and made /payments public — it
 * starts with /pay. The section then skipped Keycloak init, every request came
 * back 401, and the login recovery crashed on an adapter-less instance, leaving
 * "Loading your workspace" spinning forever on a direct link.
 */
describe('isPublicAuthPath', () => {
    it('keeps the customer-facing token pages public', () => {
        for (const path of ['/signup', '/pay', '/pay/abc123', '/e', '/e/tok', '/r', '/r/tok']) {
            expect(isPublicAuthPath(path)).toBe(true);
        }
    });

    it('never mistakes an app section for a public page because of a shared prefix', () => {
        for (const path of [
            '/payments',
            '/payments/50728',
            '/estimates',
            '/estimates/12',
            '/email',
            '/events',
            '/signups',
            '/reports',
        ]) {
            expect(isPublicAuthPath(path)).toBe(false);
        }
    });

    it('leaves ordinary sections alone', () => {
        for (const path of ['/', '/jobs', '/leads', '/settings/integrations']) {
            expect(isPublicAuthPath(path)).toBe(false);
        }
    });
});
