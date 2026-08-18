/** TILE-CITY-002 — extractLocality: city from Google address_components. Pure, no network. */
const { extractLocality } = require('../backend/src/services/googlePlacesService');
const comp = (types, long_name) => ({ types, long_name });

describe('extractLocality', () => {
    it('prefers locality', () => {
        expect(extractLocality([comp(['sublocality'], 'Sub'), comp(['locality'], 'Hanson'), comp(['administrative_area_level_1'], 'MA')])).toBe('Hanson');
    });
    it('falls back to sublocality', () => {
        expect(extractLocality([comp(['sublocality', 'political'], 'Brooklyn')])).toBe('Brooklyn');
    });
    it('falls back to postal_town, then admin_area_level_3', () => {
        expect(extractLocality([comp(['postal_town'], 'Reading')])).toBe('Reading');
        expect(extractLocality([comp(['administrative_area_level_3'], 'Some Town')])).toBe('Some Town');
    });
    it('returns null when no locality-like component is present', () => {
        expect(extractLocality([comp(['administrative_area_level_1'], 'MA'), comp(['postal_code'], '02341')])).toBeNull();
    });
    it('returns null for empty / nullish', () => {
        expect(extractLocality([])).toBeNull();
        expect(extractLocality(null)).toBeNull();
        expect(extractLocality(undefined)).toBeNull();
    });
});
