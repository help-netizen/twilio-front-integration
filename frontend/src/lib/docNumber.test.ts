import { describe, expect, it } from 'vitest';
import { shortDocNumber } from './docNumber';

/**
 * The staging audit found "Remove invoice INVOICE 2249-1?" — the sentence said the word
 * and so did the number. Every stored number carries it; every sentence that says it
 * must print the short form.
 */
describe('shortDocNumber', () => {
    it('drops the word the sentence is already saying', () => {
        expect(shortDocNumber('INVOICE 1668-2')).toBe('1668-2');
        expect(shortDocNumber('ESTIMATE L1042-1')).toBe('L1042-1');
        expect(shortDocNumber('INVOICE J-1439-1')).toBe('J-1439-1');
    });

    it('leaves a number that never carried it', () => {
        expect(shortDocNumber('1668-2')).toBe('1668-2');
    });

    it('survives nothing at all', () => {
        expect(shortDocNumber(null)).toBe('');
        expect(shortDocNumber(undefined)).toBe('');
    });
});
