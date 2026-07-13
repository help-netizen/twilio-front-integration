const { haversineMiles } = require('../backend/src/utils/geo');

describe('haversineMiles', () => {
    test('returns zero for the same point', () => {
        expect(haversineMiles(42.3601, -71.0589, 42.3601, -71.0589)).toBe(0);
    });

    test('uses Earth radius 3958.8 miles for a known one-degree arc', () => {
        expect(haversineMiles(0, 0, 0, 1)).toBeCloseTo(69.0941, 3);
    });

    test('accepts PostgreSQL NUMERIC strings and is symmetric', () => {
        const forward = haversineMiles('42.360100', '-71.058900', '40.712800', '-74.006000');
        const reverse = haversineMiles('40.712800', '-74.006000', '42.360100', '-71.058900');

        expect(forward).toBeCloseTo(190.2091, 3);
        expect(reverse).toBeCloseTo(forward, 10);
    });
});
