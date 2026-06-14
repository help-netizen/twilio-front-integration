/**
 * SCHED-ROUTE-001 — pure route-geo helpers (correctness core).
 */
const {
    roundCoord, buildCacheKey, mapGeocodeConfidence, googleMapsUrl,
    companyDay, adjacentPairs, computeAffectedPairs,
} = require('../backend/src/services/routeGeo');

describe('cache key (C-4: global, rounded, deterministic)', () => {
    it('rounds coordinates to 5 decimals', () => {
        expect(roundCoord(42.3600512345)).toBe(42.36005);
        expect(roundCoord(-71.0588799999)).toBe(-71.05888);
    });
    it('builds a deterministic key, stable across float noise within precision', () => {
        const a = buildCacheKey(42.360051, -71.058879, 42.350201, -71.060001, 'driving');
        const b = buildCacheKey(42.3600510001, -71.0588790002, 42.3502009999, -71.0600005, 'driving');
        expect(a).toBe(b);
        expect(a).toBe('driving:42.36005,-71.05888:42.35020,-71.06000');
    });
    it('is directional (A->B differs from B->A) and mode-sensitive', () => {
        const ab = buildCacheKey(1, 2, 3, 4, 'driving');
        const ba = buildCacheKey(3, 4, 1, 2, 'driving');
        expect(ab).not.toBe(ba);
    });
});

describe('geocode confidence mapping (C-5)', () => {
    it('precise + no partial → success', () => {
        expect(mapGeocodeConfidence({ partial_match: false, location_type: 'ROOFTOP' })).toBe('success');
        expect(mapGeocodeConfidence({ partial_match: false, location_type: 'RANGE_INTERPOLATED' })).toBe('success');
    });
    it('partial match or low precision → needs_review', () => {
        expect(mapGeocodeConfidence({ partial_match: true, location_type: 'ROOFTOP' })).toBe('needs_review');
        expect(mapGeocodeConfidence({ partial_match: false, location_type: 'GEOMETRIC_CENTER' })).toBe('needs_review');
        expect(mapGeocodeConfidence({ partial_match: false, location_type: 'APPROXIMATE' })).toBe('needs_review');
        expect(mapGeocodeConfidence({})).toBe('needs_review');
    });
});

describe('google maps url (C-6: generated, never persisted)', () => {
    it('prefers coordinates', () => {
        expect(googleMapsUrl({ lat: 42.36, lng: -71.05 }))
            .toBe('https://www.google.com/maps/search/?api=1&query=42.36,-71.05');
    });
    it('falls back to encoded address', () => {
        expect(googleMapsUrl({ address: '123 Main St, Boston' }))
            .toBe('https://www.google.com/maps/search/?api=1&query=123%20Main%20St%2C%20Boston');
    });
    it('null when nothing usable', () => {
        expect(googleMapsUrl({})).toBeNull();
    });
});

describe('company-local schedule day (C-3)', () => {
    it('uses company tz, not UTC, near midnight UTC', () => {
        // 2026-06-15 02:00 UTC = 2026-06-14 22:00 in America/New_York (EDT)
        expect(companyDay('2026-06-15T02:00:00Z', 'America/New_York')).toBe('2026-06-14');
        // same instant is already the 15th in UTC
        expect(companyDay('2026-06-15T02:00:00Z', 'UTC')).toBe('2026-06-15');
    });
    it('handles a far-east tz crossing the other way', () => {
        // 2026-06-14 20:00 UTC = 2026-06-15 06:00 in Asia/Almaty (+10... +5/+6)
        expect(companyDay('2026-06-14T20:00:00Z', 'Asia/Almaty')).toBe('2026-06-15');
    });
});

describe('affected-segment diff (Affected segment logic)', () => {
    it('INSERT X between A and B: stale A->B; calc A->X, X->B', () => {
        const { stale, toCalc } = computeAffectedPairs(['A', 'B'], ['A', 'X', 'B']);
        expect(stale).toEqual([['A', 'B']]);
        expect(toCalc.sort()).toEqual([['A', 'X'], ['X', 'B']].sort());
    });
    it('REMOVE X between A and B: stale A->X, X->B; calc A->B', () => {
        const { stale, toCalc } = computeAffectedPairs(['A', 'X', 'B'], ['A', 'B']);
        expect(stale.sort()).toEqual([['A', 'X'], ['X', 'B']].sort());
        expect(toCalc).toEqual([['A', 'B']]);
    });
    it('NO structural change → nothing stale or recalced', () => {
        const { stale, toCalc } = computeAffectedPairs(['A', 'B', 'C'], ['A', 'B', 'C']);
        expect(stale).toEqual([]);
        expect(toCalc).toEqual([]);
    });
    it('ADDRESS change of X (coords) recalcs only pairs touching X', () => {
        const { stale, toCalc } = computeAffectedPairs(['A', 'X', 'B'], ['A', 'X', 'B'], ['X']);
        expect(stale.sort()).toEqual([['A', 'X'], ['X', 'B']].sort());
        expect(toCalc.sort()).toEqual([['A', 'X'], ['X', 'B']].sort());
    });
    it('REASSIGN is modeled as per-technician sequences (remove from T1, insert into T2)', () => {
        // T1 loses X: A -> X -> B  =>  A -> B
        const t1 = computeAffectedPairs(['A', 'X', 'B'], ['A', 'B']);
        expect(t1.stale.sort()).toEqual([['A', 'X'], ['X', 'B']].sort());
        expect(t1.toCalc).toEqual([['A', 'B']]);
        // T2 gains X: C -> D  =>  C -> X -> D
        const t2 = computeAffectedPairs(['C', 'D'], ['C', 'X', 'D']);
        expect(t2.stale).toEqual([['C', 'D']]);
        expect(t2.toCalc.sort()).toEqual([['C', 'X'], ['X', 'D']].sort());
    });
    it('single-job day produces no pairs', () => {
        expect(adjacentPairs(['A'])).toEqual([]);
        const { stale, toCalc } = computeAffectedPairs([], ['A']);
        expect(stale).toEqual([]);
        expect(toCalc).toEqual([]);
    });
});
