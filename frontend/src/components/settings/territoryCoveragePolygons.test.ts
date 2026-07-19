import { describe, expect, it, vi } from 'vitest';
import {
    applyPostalCodeBoundaries,
    type ListCentroid,
} from './territoryCoveragePolygons';

const CENTROIDS: ListCentroid[] = [
    {
        zip: '02135', lat: 42.3467, lon: -71.1627,
        area: 'Boston', place_id: 'postal-place-02135',
    },
    { zip: '02461', lat: 42.3168, lon: -71.2095, area: 'Brookline' },
];

const AREA_NAMES = ['Boston', 'Brookline'];
const AREA_COLORS = Array.from(
    { length: 16 },
    (_, index) => `#${(index + 1).toString(16).padStart(6, '0')}`,
);

function googleMap({
    dataDrivenStyling = true,
    layerAvailable = true,
} = {}) {
    const layer = {
        isAvailable: layerAvailable,
        style: null,
    } as unknown as google.maps.FeatureLayer;
    const map = {
        getMapCapabilities: vi.fn(() => ({
            isDataDrivenStylingAvailable: dataDrivenStyling,
        })),
        getFeatureLayer: vi.fn(() => layer),
    } as unknown as Pick<google.maps.Map, 'getFeatureLayer' | 'getMapCapabilities'>;
    return { map, layer };
}

interface ApplyTestOptions {
    mode?: 'list' | 'radius';
    mapId?: string | null;
    centroids?: ListCentroid[];
    areaNames?: string[];
    map?: Pick<google.maps.Map, 'getFeatureLayer' | 'getMapCapabilities'>;
    warn?: (message: string) => void;
}

function apply({
    mode = 'list',
    mapId = 'vector-map-id',
    centroids = CENTROIDS,
    areaNames = AREA_NAMES,
    map = googleMap().map,
    warn = vi.fn(),
}: ApplyTestOptions = {}) {
    return {
        result: applyPostalCodeBoundaries({
            mode,
            map,
            mapId,
            centroids,
            areaNames,
            areaColors: AREA_COLORS,
            postalCodeFeatureType: 'POSTAL_CODE' as google.maps.FeatureType,
            warn,
        }),
        map,
        warn,
    };
}

describe('applyPostalCodeBoundaries', () => {
    it('falls back to every legacy marker with a warning when no Map ID is configured', () => {
        const { map } = googleMap();
        const warn = vi.fn();
        const { result } = apply({ map, mapId: null, warn });

        expect(result.active).toBe(false);
        expect(result.markerCentroids).toEqual(CENTROIDS);
        expect(map.getMapCapabilities).not.toHaveBeenCalled();
        expect(map.getFeatureLayer).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('showing centroid markers'));
    });

    it('falls back to every marker for an invalid or non-DDS Map ID', () => {
        const { map } = googleMap({ dataDrivenStyling: false });
        const warn = vi.fn();
        const { result } = apply({ map, warn });

        expect(result.active).toBe(false);
        expect(result.markerCentroids).toEqual(CENTROIDS);
        expect(map.getFeatureLayer).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('data-driven styling is unavailable'));
    });

    it('falls back when the Postal Code feature layer was not enabled on the map style', () => {
        const { map } = googleMap({ layerAvailable: false });
        const warn = vi.fn();
        const { result } = apply({ map, warn });

        expect(result.active).toBe(false);
        expect(result.markerCentroids).toEqual(CENTROIDS);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Postal Code feature layer'));
    });

    it('falls back to every marker when the complete area registry is unavailable', () => {
        const { map } = googleMap();
        const warn = vi.fn();
        const { result } = apply({ map, areaNames: [], warn });

        expect(result.active).toBe(false);
        expect(result.markerCentroids).toEqual(CENTROIDS);
        expect(map.getMapCapabilities).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('complete service-area registry'));
    });

    it('styles only selected place IDs and keeps markers only for unresolved ZIPs', () => {
        const { map, layer } = googleMap();
        const warn = vi.fn();
        const { result } = apply({ map, warn });

        expect(result.active).toBe(true);
        expect(result.markerCentroids).toEqual([CENTROIDS[1]]);
        expect(map.getFeatureLayer).toHaveBeenCalledWith('POSTAL_CODE');
        expect(typeof layer.style).toBe('function');

        const style = layer.style as google.maps.FeatureStyleFunction;
        expect(style({
            feature: { placeId: 'postal-place-02135' } as google.maps.PlaceFeature,
        })).toEqual({
            fillColor: expect.any(String),
            fillOpacity: 0.42,
            strokeWeight: 0,
        });
        expect(style({
            feature: { placeId: 'not-selected' } as google.maps.PlaceFeature,
        })).toBeUndefined();
    });

    it('assigns distinct stable colors from the complete sorted area set', () => {
        const areaNames = [
            'North Shore', 'South Shore', 'Metro West', 'Boston', 'Cape Cod',
            'Cambridge', 'Quincy', 'Newton', 'Framingham', 'Worcester', 'Lowell',
        ];
        const centroids: ListCentroid[] = areaNames.map((area, index) => ({
            zip: String(10000 + index),
            lat: 42 + index / 100,
            lon: -71 - index / 100,
            area,
            place_id: `postal-place-${index}`,
        }));
        const first = googleMap();
        const second = googleMap();
        const filtered = googleMap();

        apply({ map: first.map, centroids, areaNames });
        apply({
            map: second.map,
            centroids: [...centroids].reverse(),
            areaNames: [...areaNames].reverse(),
        });
        apply({
            map: filtered.map,
            centroids: [centroids[4]],
            areaNames: [...areaNames].reverse(),
        });

        const firstStyle = first.layer.style as google.maps.FeatureStyleFunction;
        const secondStyle = second.layer.style as google.maps.FeatureStyleFunction;
        const filteredStyle = filtered.layer.style as google.maps.FeatureStyleFunction;
        const styleFor = (style: google.maps.FeatureStyleFunction, placeId: string) => style({
            feature: { placeId } as google.maps.PlaceFeature,
        });
        const firstColors = centroids.map(centroid => (
            styleFor(firstStyle, centroid.place_id!)?.fillColor
        ));
        const secondColors = centroids.map(centroid => (
            styleFor(secondStyle, centroid.place_id!)?.fillColor
        ));

        expect(secondColors).toEqual(firstColors);
        expect(new Set(firstColors).size).toBe(areaNames.length);
        expect(styleFor(filteredStyle, centroids[4].place_id!)).toEqual(
            styleFor(firstStyle, centroids[4].place_id!)
        );
    });

    it('does not inspect or style boundary layers in radius mode', () => {
        const { map } = googleMap();
        const warn = vi.fn();
        const { result } = apply({ mode: 'radius', map, warn });

        expect(result).toEqual({ active: false, featureLayer: null, markerCentroids: [] });
        expect(map.getMapCapabilities).not.toHaveBeenCalled();
        expect(map.getFeatureLayer).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });
});
