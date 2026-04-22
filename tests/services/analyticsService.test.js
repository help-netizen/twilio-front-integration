/**
 * F014 — analyticsService unit tests.
 * Only the pure helpers are covered here — SQL aggregation is left to
 * an integration/e2e layer that hits a real Postgres (out of scope here).
 */

jest.mock('../../backend/src/db/connection', () => ({ query: jest.fn() }));

const analytics = require('../../backend/src/services/analyticsService');

describe('parsePeriod', () => {
    test('rejects missing', () => {
        expect(() => analytics._parsePeriod(null, '2026-01-01')).toThrow(/YYYY-MM-DD/);
        expect(() => analytics._parsePeriod('2026-01-01', null)).toThrow(/YYYY-MM-DD/);
    });
    test('rejects reversed range', () => {
        expect(() => analytics._parsePeriod('2026-05-01', '2026-04-01')).toThrow(/to must be >= from/);
    });
    test('rejects too-large range', () => {
        expect(() => analytics._parsePeriod('2026-01-01', '2026-12-31')).toThrow(/PERIOD_TOO_LARGE|Period too large/);
    });
    test('accepts 7-day range', () => {
        expect(analytics._parsePeriod('2026-04-16', '2026-04-22')).toEqual({
            fromStr: '2026-04-16', toStr: '2026-04-22',
        });
    });
});

describe('normalizePhone', () => {
    test('null passthrough', () => { expect(analytics._normalizePhone(null)).toBeNull(); });
    test('10-digit gets +1', () => { expect(analytics._normalizePhone('6176444408')).toBe('+16176444408'); });
    test('11-digit with 1 gets +', () => { expect(analytics._normalizePhone('16176444408')).toBe('+16176444408'); });
    test('formatted input stripped', () => { expect(analytics._normalizePhone('(617) 644-4408')).toBe('+16176444408'); });
});
