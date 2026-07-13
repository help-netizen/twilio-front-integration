import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadGoogleMaps } from '../../utils/loadGoogleMaps';

export type TerritoryCoverageMode = 'list' | 'radius';

export interface CoverageRadius {
    id: string;
    lat: number;
    lon: number;
    radius_miles: number;
}

export interface ListCentroid {
    zip: string;
    lat: number;
    lon: number;
}

interface TerritoryCoverageMapProps {
    mode: TerritoryCoverageMode;
    radii: readonly CoverageRadius[];
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

export function TerritoryCoverageMap({ mode, radii, listCentroids }: TerritoryCoverageMapProps) {
    const mapRef = useRef<HTMLDivElement>(null);
    const mapInstanceRef = useRef<google.maps.Map | null>(null);
    const markersRef = useRef<google.maps.Marker[]>([]);
    const circlesRef = useRef<google.maps.Circle[]>([]);
    const idleListenerRef = useRef<google.maps.MapsEventListener | null>(null);
    const mapsReadyRef = useRef(false);
    const [loadState, setLoadState] = useState<LoadState>('idle');

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

        mapInstanceRef.current = new google.maps.Map(mapRef.current, {
            center: DEFAULT_CENTER,
            zoom: DEFAULT_ZOOM,
            disableDefaultUI: true,
            gestureHandling: 'none',
            clickableIcons: false,
            keyboardShortcuts: false,
        });

        return () => {
            clearOverlays();
            mapInstanceRef.current = null;
        };
    }, [clearOverlays, hasCoverage, loadState]);

    useEffect(() => {
        const map = mapInstanceRef.current;
        if (!map || loadState !== 'ready' || !hasCoverage) return;

        clearOverlays();

        if (mode === 'radius') {
            const bounds = new google.maps.LatLngBounds();
            const accent = getComputedStyle(document.documentElement)
                .getPropertyValue('--blanc-accent')
                .trim();

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

        const bounds = new google.maps.LatLngBounds();
        validListCentroids.forEach(centroid => {
            const position = { lat: centroid.lat, lng: centroid.lon };
            const marker = new google.maps.Marker({
                map,
                position,
                title: centroid.zip,
                clickable: false,
                draggable: false,
            });
            markersRef.current.push(marker);
            bounds.extend(position);
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
    }, [clearOverlays, hasCoverage, loadState, mode, validListCentroids, validRadii]);

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
