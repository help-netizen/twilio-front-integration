import { describe, expect, it } from 'vitest';
import source from './dropdown-menu.tsx?raw';

/**
 * The mobile branch renders its own <button> instead of the Radix Item, and it used to
 * drop everything the call site passed — so `data-testid`, `title` and any aria lived on
 * desktop only. The staging audit hit it from the other side: E2E cannot reach a
 * destructive menu action on a phone, so a mobile regression there goes unseen.
 *
 * Asserted on the source: the suite runs in `environment: 'node'`, where the sheet's
 * portal never mounts, so a rendered proof is not available here. The rendered check
 * belongs to the E2E suite once this ships.
 */
describe('the mobile menu row keeps what the call site gave it', () => {
    it('spreads the passthrough onto the mobile button', () => {
        expect(source).toMatch(/className=\{rowClassName\}\s*\n\s*\{\.\.\.passthrough\}/);
    });

    it('passes exactly the attributes a <button> can carry', () => {
        // Radix Item's remaining props are typed for a <div>; spreading them whole is a
        // type error, and spreading nothing is the bug above.
        expect(source).toContain("key.startsWith('data-') || key.startsWith('aria-') || key === 'title' || key === 'id'");
    });
});
