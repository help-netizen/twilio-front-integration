export type TerritoryCoverageMode = 'list' | 'radius';

export interface ListCentroid {
    zip: string;
    lat: number;
    lon: number;
    area?: string | null;
    place_id?: string | null;
}

export const SERVICE_AREA_COLOR_TOKENS = Array.from(
    { length: 16 },
    (_, index) => `--blanc-map-area-${index + 1}`,
);

const UNCATEGORIZED_AREA_KEY = 'Uncategorized ZIPs';

function normalizedAreaName(areaName: string | null | undefined): string {
    return areaName?.normalize('NFC') || UNCATEGORIZED_AREA_KEY;
}

function compareCodepoints(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

/** Stable color registry shared by ZIP polygons and a future area legend. */
export function buildServiceAreaColorMap(
    completeAreaNames: readonly string[],
    palette: readonly string[],
): ReadonlyMap<string, string> {
    const colors = palette.map(color => color.trim()).filter(Boolean);
    if (colors.length === 0) return new Map();

    const sortedAreaNames = Array.from(new Set(
        completeAreaNames.map(normalizedAreaName)
    )).sort(compareCodepoints);
    return new Map(sortedAreaNames.map((areaName, index) => [
        areaName,
        // Unique while area count <= palette size. Larger registries
        // intentionally wrap because the fixed 16-color palette is finite.
        colors[index % colors.length],
    ]));
}

interface ApplyPostalCodeBoundariesOptions {
    mode: TerritoryCoverageMode;
    map: Pick<google.maps.Map, 'getFeatureLayer' | 'getMapCapabilities'>;
    mapId: string | null;
    centroids: readonly ListCentroid[];
    areaNames: readonly string[];
    areaColors: readonly string[];
    postalCodeFeatureType: google.maps.FeatureType;
    warn?: (message: string) => void;
}

export interface PostalCodeBoundaryResult {
    active: boolean;
    featureLayer: google.maps.FeatureLayer | null;
    markerCentroids: ListCentroid[];
}

function fallback(
    centroids: readonly ListCentroid[],
    reason: string,
    warn: (message: string) => void,
): PostalCodeBoundaryResult {
    warn(`[TerritoryCoverageMap] ZIP polygon fallback: ${reason}; showing centroid markers.`);
    return {
        active: false,
        featureLayer: null,
        markerCentroids: [...centroids],
    };
}

/**
 * Activates Google's POSTAL_CODE feature layer only when every runtime
 * prerequisite is present. Any failure returns the full legacy marker set.
 */
export function applyPostalCodeBoundaries({
    mode,
    map,
    mapId,
    centroids,
    areaNames,
    areaColors,
    postalCodeFeatureType,
    warn = console.warn,
}: ApplyPostalCodeBoundariesOptions): PostalCodeBoundaryResult {
    if (mode !== 'list') {
        return { active: false, featureLayer: null, markerCentroids: [] };
    }
    if (!mapId) {
        return fallback(centroids, 'VITE_GOOGLE_MAPS_MAP_ID is not configured', warn);
    }

    const colorsByArea = buildServiceAreaColorMap(areaNames, areaColors);
    if (colorsByArea.size === 0) {
        return fallback(centroids, 'the complete service-area registry is unavailable', warn);
    }

    const stylesByPlaceId = new Map<string, google.maps.FeatureStyleOptions>();
    for (const centroid of centroids) {
        const placeId = centroid.place_id?.trim();
        if (!placeId) continue;
        const areaName = normalizedAreaName(centroid.area);
        const fillColor = colorsByArea.get(areaName);
        if (!fillColor) {
            return fallback(
                centroids,
                `area "${areaName}" is missing from the complete registry`,
                warn
            );
        }
        stylesByPlaceId.set(placeId, {
            fillColor,
            fillOpacity: 0.42,
            strokeWeight: 0,
        });
    }
    if (stylesByPlaceId.size === 0) {
        return fallback(centroids, 'ZIP place IDs are not cached yet', warn);
    }

    try {
        if (!map.getMapCapabilities().isDataDrivenStylingAvailable) {
            return fallback(centroids, 'data-driven styling is unavailable for this Map ID', warn);
        }

        const featureLayer = map.getFeatureLayer(postalCodeFeatureType);
        if (!featureLayer.isAvailable) {
            return fallback(centroids, 'the Postal Code feature layer is unavailable', warn);
        }

        featureLayer.style = ({ feature }) => stylesByPlaceId.get(
            (feature as google.maps.PlaceFeature).placeId
        );

        const markerCentroids = centroids.filter(centroid => !centroid.place_id?.trim());
        if (markerCentroids.length > 0) {
            warn(
                `[TerritoryCoverageMap] ${markerCentroids.length} ZIP place IDs are still resolving; showing centroid markers for those ZIPs.`
            );
        }
        return { active: true, featureLayer, markerCentroids };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fallback(centroids, `postal boundary setup failed (${message})`, warn);
    }
}
