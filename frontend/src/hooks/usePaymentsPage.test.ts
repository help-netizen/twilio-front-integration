import { describe, expect, it } from 'vitest';
import { nextDetailAction } from './usePaymentsPage';

/**
 * A direct link to /payments/:id showed "Unable to load payment details" while
 * the same card opened fine from the list. Nothing failed — the request was
 * never sent. The selection was seeded from the URL and then compared against
 * itself, so the guard skipped the load on the very first render.
 */
describe('nextDetailAction', () => {
    it('loads when the URL names a payment nothing has fetched yet', () => {
        // The deep-link case: the page opens already pointing at 50728.
        expect(nextDetailAction(50728, null)).toBe('load');
    });

    it('loads when the URL moves to a different payment', () => {
        expect(nextDetailAction(50729, 50728)).toBe('load');
    });

    it('does not re-fetch the payment it already holds', () => {
        expect(nextDetailAction(50728, 50728)).toBe('skip');
    });

    it('clears the panel when the URL no longer names a payment', () => {
        expect(nextDetailAction(null, 50728)).toBe('clear');
        expect(nextDetailAction(null, null)).toBe('clear');
    });
});
