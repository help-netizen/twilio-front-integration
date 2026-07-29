import { describe, expect, it } from 'vitest';
import { isBareRoute } from './publicBareRoutes';

describe('PUBLIC-BARE-001 — bare (chrome-less) route predicate', () => {
    it('marks every public customer link bare — no CRM chrome may ever show there', () => {
        expect(isBareRoute('/e/1BC7xax667M')).toBe(true);   // public estimate view
        expect(isBareRoute('/pay/51bRht3GDzE')).toBe(true); // public invoice pay
        expect(isBareRoute('/pay/thanks')).toBe(true);
        expect(isBareRoute('/r/sometoken')).toBe(true);     // rate page
    });

    it('keeps auth pages bare (ALB-101)', () => {
        expect(isBareRoute('/signup')).toBe(true);
        expect(isBareRoute('/onboarding')).toBe(true);
    });

    it('does NOT match internal routes sharing the first letters', () => {
        expect(isBareRoute('/email')).toBe(false);
        expect(isBareRoute('/estimates')).toBe(false);
        expect(isBareRoute('/payments')).toBe(false);
        expect(isBareRoute('/payments/12')).toBe(false);
        expect(isBareRoute('/pulse')).toBe(false);
        expect(isBareRoute('/settings/billing')).toBe(false);
        expect(isBareRoute('/')).toBe(false);
    });
});
