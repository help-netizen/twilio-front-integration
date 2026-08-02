import { describe, expect, it } from 'vitest';
import { savedCardExpiry } from './ContactSavedCardsSection';

describe('ContactSavedCardsSection native card display', () => {
    it('shows only the card expiry value, without token-TTL copy', () => {
        const label = savedCardExpiry({ exp_month: 12, exp_year: 2027 });
        expect(label).toBe('12/27');
        expect(label.toLowerCase()).not.toContain('expire');
    });
});
