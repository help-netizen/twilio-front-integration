import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getGoogleMapsMapId, loadGoogleMaps } from '../../utils/loadGoogleMaps';
import {
    applyPostalCodeBoundaries,
    SERVICE_AREA_COLOR_TOKENS,
    type ListCentroid,
    type TerritoryCoverageMode,
} from './territoryCoveragePolygons';

export type { ListCentroid, TerritoryCoverageMode };

export interface CoverageRadius {
    id: string;
    lat: number;
    lon: number;
    radius_miles: number;
}

interface TerritoryCoverageMapProps {
    mode: TerritoryCoverageMode;
    radii: readonly CoverageRadius[];
    areaNames: readonly string[];
    listCentroids: readonly ListCentroid[];
}

type LoadState = 'idle' | 'loading' | 'ready' | 'failed';

const DEFAULT_CENTER = { lat: 39.8283, lng: -98.5795 };
const DEFAULT_ZOOM = 4;
const METERS_PER_MILE = 1609.34;

function isFiniteCoordinate(lat: number, lon: number) {
    return Number.isFinite(lat) && Number.isFinite(lon)
        && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

export function TerritoryCoverageMap({
    mode,
    radii,
    areaNames,
    listCentroids,
}: TerritoryCoverageMapProps) {
    const mapRef = useRef<HTMLDivElement>(null);
    const mapInstanceRef = useRef<google.maps.Map | null>(null);
    const markersRef = useRef<google.maps.Marker[]>([]);
    const circlesRef = useRef<google.maps.Circle[]>([]);
    const postalCodeLayerRef = useRef<google.maps.FeatureLayer | null>(null);
    const boundaryMapIdRef = useRef<string | null>(null);
    const idleListenerRef = useRef<google.maps.MapsEventListener | null>(null);
    const capabilityListenerRef = useRef<google.maps.MapsEventListener | null>(null);
    const mapsReadyRef = useRef(false);
    const [loadState, setLoadState] = useState<LoadState>('idle');
    const [capabilityRevision, setCapabilityRevision] = useState(0);
    const configuredMapId = getGoogleMapsMapId();

    const validRadii = useMemo(() => radii.filter(radius => (
        isFiniteCoordinate(radius.lat, radius.lon)
        && Number.isFinite(radius.radius_miles)
        && radius.radius_miles > 0
    )), [radii]);
    const validListCentroids = useMemo(() => listCentroids.filter(centroid => (
        isFiniteCoordinate(centroid.lat, centroid.lon)
    )), [listCentroids]);
    const hasCoverage = mode === 'radius' ? validRadii.length > 0 : validListCentroids.length > 0;

    const clearOverlays = useCallback(() => {
        if (idleListenerRef.current) {
            idleListenerRef.current.remove();
            idleListenerRef.current = null;
        }
        markersRef.current.forEach(marker => marker.setMap(null));
        markersRef.current = [];
        circlesRef.current.forEach(circle => circle.setMap(null));
        circlesRef.current = [];
        if (postalCodeLayerRef.current) {
            postalCodeLayerRef.current.style = null;
            postalCodeLayerRef.current = null;
        }
    }, []);

    useEffect(() => {
        if (!hasCoverage) return;
        if (mapsReadyRef.current) {
            setLoadState('ready');
            return;
        }

        let cancelled = false;
        setLoadState('loading');
        loadGoogleMaps()
            .then(() => {
                mapsReadyRef.current = true;
                if (!cancelled) setLoadState('ready');
            })
            .catch(error => {
                console.warn('[TerritoryCoverageMap] Google Maps unavailable:', error);
                if (!cancelled) setLoadState('failed');
            });

        return () => {
            cancelled = true;
        };
    }, [hasCoverage]);

    useEffect(() => {
        if (loadState !== 'ready' || !hasCoverage || !mapRef.current) return;
        if (typeof google === 'undefined' || !google.maps) return;

        const baseOptions: google.maps.MapOptions = {
            center: DEFAULT_CENTER,
            zoom: DEFAULT_ZOOM,
            disableDefaultUI: true,
            gestureHandling: 'none',
            clickableIcons: false,
            keyboardShortcuts: false,
        };
        boundaryMapIdRef.current = null;
        if (mode === 'list' && configuredMapId) {
            try {
                mapInstanceRef.current = new google.maps.Map(mapRef.current, {
                    ...baseOptions,
                    mapId: configuredMapId,
                });
                boundaryMapIdRef.current = configuredMapId;
                capabilityListenerRef.current = mapInstanceRef.current.addListener(
                    'mapcapabilities_changed',
                    () => setCapabilityRevision(revision => revision + 1),
                );
            } catch (error) {
                console.warn(
                    '[TerritoryCoverageMap] Vector Map ID initialization failed; using the legacy map:',
                    error
                );
                mapInstanceRef.current = new google.maps.Map(mapRef.current, baseOptions);
            }
        } else {
            mapInstanceRef.current = new google.maps.Map(mapRef.current, baseOptions);
        }

        return () => {
            capabilityListenerRef.current?.remove();
            capabilityListenerRef.current = null;
            clearOverlays();
            mapInstanceRef.current = null;
            boundaryMapIdRef.current = null;
        };
    }, [clearOverlays, configuredMapId, hasCoverage, loadState, mode]);

    useEffect(() => {
        const map = mapInstanceRef.current;
        if (!map || loadState !== 'ready' || !hasCoverage) return;

        clearOverlays();

        const accent = getComputedStyle(document.documentElement)
            .getPropertyValue('--blanc-accent')
            .trim();
        const areaColors = SERVICE_AREA_COLOR_TOKENS.map(token => (
            getComputedStyle(document.documentElement).getPropertyValue(token).trim()
        ));

        if (mode === 'radius') {
            const bounds = new google.maps.LatLngBounds();

            validRadii.forEach(radius => {
                const circle = new google.maps.Circle({
                    map,
                    center: { lat: radius.lat, lng: radius.lon },
                    radius: radius.radius_miles * METERS_PER_MILE,
                    clickable: false,
                    fillOpacity: 0.12,
                    strokeOpacity: 0.8,
                    strokeWeight: 1.5,
                    ...(accent ? { fillColor: accent, strokeColor: accent } : {}),
                });
                circlesRef.current.push(circle);
                const circleBounds = circle.getBounds();
                if (circleBounds) bounds.union(circleBounds);
            });

            if (!bounds.isEmpty()) map.fitBounds(bounds, 24);
            return clearOverlays;
        }

        const boundaryResult = applyPostalCodeBoundaries({
            mode,
            map,
            mapId: boundaryMapIdRef.current,
            centroids: validListCentroids,
            areaNames,
            areaColors,
            postalCodeFeatureType: google.maps.FeatureType?.POSTAL_CODE
                || ('POSTAL_CODE' as google.maps.FeatureType),
        });
        postalCodeLayerRef.current = boundaryResult.featureLayer;

        const bounds = new google.maps.LatLngBounds();
        validListCentroids.forEach(centroid => {
            bounds.extend({ lat: centroid.lat, lng: centroid.lon });
        });
        boundaryResult.markerCentroids.forEach(centroid => {
            const position = { lat: centroid.lat, lng: centroid.lon };
            const marker = new google.maps.Marker({
                map,
                position,
                title: centroid.zip,
                clickable: false,
                draggable: false,
            });
            markersRef.current.push(marker);
        });

        if (validListCentroids.length === 1) {
            map.setCenter({ lat: validListCentroids[0].lat, lng: validListCentroids[0].lon });
            map.setZoom(11);
        } else if (!bounds.isEmpty()) {
            map.fitBounds(bounds, 24);
            idleListenerRef.current = google.maps.event.addListenerOnce(map, 'idle', () => {
                const zoom = map.getZoom();
                if (zoom != null && zoom > 14) map.setZoom(14);
                idleListenerRef.current = null;
            });
        }

        return clearOverlays;
    }, [areaNames, capabilityRevision, clearOverlays, hasCoverage, loadState, mode, validListCentroids, validRadii]);

    if (!hasCoverage || loadState !== 'ready') return null;

    return (
        <section className="min-w-0 space-y-3.5">
            <div className="blanc-eyebrow">Coverage preview</div>
            <div
                ref={mapRef}
                className="h-[220px] w-full overflow-hidden rounded-xl border md:h-[280px]"
                style={{ borderColor: 'var(--blanc-line)' }}
            />
        </section>
    );
}
