import { describe, expect, it } from 'vitest';
import {
    AREA_CODES,
    detectSearchKind,
    formatAreaCode,
    suggestAreaCodes,
} from './areaCodes';

const BOSTON = { city: 'Boston', state: 'MA', lat: 42.36, lon: -71.06 };

describe('suggestAreaCodes', () => {
    it('ranks the Boston overlays first and caps coordinate suggestions at eight', () => {
        const suggestions = suggestAreaCodes('', BOSTON);
        const codes = suggestions.map(areaCode => areaCode.code);

        expect(codes.slice(0, 2)).toEqual(['617', '857']);
        expect(codes.indexOf('617')).toBeLessThan(codes.indexOf('508'));
        expect(suggestions).toHaveLength(8);
    });

    it('falls back to same-state codes and never leaks non-local suggestions', () => {
        const suggestions = suggestAreaCodes('', { state: 'MA' });

        expect(suggestions.length).toBeGreaterThan(0);
        expect(suggestions).toHaveLength(8);
        expect(suggestions.every(areaCode => areaCode.state === 'MA')).toBe(true);
        expect(suggestions.map(areaCode => areaCode.city)).toEqual(
            [...suggestions].map(areaCode => areaCode.city).sort((a, b) => a.localeCompare(b)),
        );
    });

    it('returns no suggestions without coordinates or state', () => {
        expect(suggestAreaCodes('', {})).toEqual([]);
        expect(suggestAreaCodes('617', null)).toEqual([]);
    });

    it('filters only the local set by numeric or city prefix', () => {
        const numeric = suggestAreaCodes('6', BOSTON);
        const city = suggestAreaCodes('bo', { state: 'MA' });

        expect(numeric.length).toBeGreaterThan(0);
        expect(numeric.every(areaCode => areaCode.code.startsWith('6'))).toBe(true);
        expect(city.map(areaCode => areaCode.code)).toEqual(expect.arrayContaining(['617', '857']));
        expect(city.every(areaCode => areaCode.city.toLowerCase().startsWith('bo'))).toBe(true);
    });
});

describe('detectSearchKind', () => {
    it('detects exactly three manual digits as an area code', () => {
        expect(detectSearchKind('617')).toEqual({ kind: 'area_code', value: '617' });
    });

    it('treats one or two digits as an incomplete area code', () => {
        expect(detectSearchKind('6')).toBeNull();
        expect(detectSearchKind('61')).toBeNull();
    });

    it('detects locality text and ignores blank input', () => {
        expect(detectSearchKind(' Boston ')).toEqual({ kind: 'locality', value: 'Boston' });
        expect(detectSearchKind('')).toBeNull();
        expect(detectSearchKind('   ')).toBeNull();
    });

    it('emits the area code for a selected suggestion', () => {
        const selected = AREA_CODES.find(areaCode => areaCode.code === '617');
        expect(selected).toBeDefined();
        expect(detectSearchKind(formatAreaCode(selected!), selected)).toEqual({
            kind: 'area_code',
            value: '617',
        });
    });
});

describe('AREA_CODES', () => {
    it('contains one well-formed record per current US geographic NPA', () => {
        expect(AREA_CODES.length).toBeGreaterThanOrEqual(350);
        expect(new Set(AREA_CODES.map(areaCode => areaCode.code)).size).toBe(AREA_CODES.length);
        expect(AREA_CODES).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: '212', city: 'New York City', state: 'NY' }),
            expect.objectContaining({ code: '310', city: 'Los Angeles', state: 'CA' }),
            expect.objectContaining({ code: '415', city: 'San Francisco', state: 'CA' }),
            expect.objectContaining({ code: '617', city: 'Boston', state: 'MA' }),
        ]));
    });
});
