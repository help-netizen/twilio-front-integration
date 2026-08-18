/**
 * TILE-CITY-002 — deriveLocality: best-effort city from a formatted US address,
 * used as the schedule card's fallback when the structured city column is null.
 * Pure function, no DB.
 */
const { deriveLocality, rowToScheduleItem } = require('../backend/src/services/scheduleService');

describe('deriveLocality', () => {
    it('takes the component before "ST"', () => {
        expect(deriveLocality('100 Test Street, New York, NY, 10001')).toBe('New York');
    });
    it('takes the component before "ST ZIP" and ignores the country', () => {
        expect(deriveLocality('123 Main St, Hanson, MA 02341, USA')).toBe('Hanson');
    });
    it('works without a ZIP', () => {
        expect(deriveLocality('45 Oak Rd, Norwell, MA')).toBe('Norwell');
    });
    it('works with a city,state-only string', () => {
        expect(deriveLocality('Hanson, MA 02341')).toBe('Hanson');
    });
    it('skips an apartment line', () => {
        expect(deriveLocality('12 Beacon St, Apt 4, Boston, MA 02108, USA')).toBe('Boston');
    });
    it('returns null when no US state token is present', () => {
        expect(deriveLocality('Some Place, Nowhere')).toBeNull();
    });
    it('returns null when the address has no city (street sits before the state)', () => {
        expect(deriveLocality('100 Test Street, NY, 10001')).toBeNull();
        expect(deriveLocality('45 Oak Rd, MA 02341')).toBeNull();
    });
    it('returns null for a comma-less string', () => {
        expect(deriveLocality('No commas here')).toBeNull();
    });
    it('returns null for empty / nullish input', () => {
        expect(deriveLocality('')).toBeNull();
        expect(deriveLocality(null)).toBeNull();
        expect(deriveLocality(undefined)).toBeNull();
    });
});

describe('rowToScheduleItem city fallback (TILE-CITY-002)', () => {
    const base = { entity_type: 'job', entity_id: 1, customer_name: 'Jane' };

    it('keeps the structured city when present', () => {
        const item = rowToScheduleItem({ ...base, city: 'Boston', address_summary: '1 X St, Nowhere, MA' });
        expect(item.city).toBe('Boston');
    });
    it('derives the city from the raw address when the column is null', () => {
        const item = rowToScheduleItem({ ...base, city: null, address_summary: '100 Test Street, New York, NY, 10001', normalized_address: null });
        expect(item.city).toBe('New York');
    });
    it('prefers the normalized address over the raw address', () => {
        const item = rowToScheduleItem({ ...base, city: null, normalized_address: '5 Main St, Hanson, MA 02341, USA', address_summary: 'garbage' });
        expect(item.city).toBe('Hanson');
    });
    it('leaves city null when nothing is derivable (card shows just the name)', () => {
        const item = rowToScheduleItem({ ...base, city: null, address_summary: 'business name only', normalized_address: null });
        expect(item.city).toBeNull();
    });
});
