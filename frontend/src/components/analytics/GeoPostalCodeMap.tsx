import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeoRow } from '../../services/leadChannelAnalyticsApi';
import { getGoogleMapsMapId, loadGoogleMaps } from '../../utils/loadGoogleMaps';
import { NEUTRAL_HEAT } from './geoPerformanceModel';

interface GeoPostalCodeMapProps {
    rows: readonly GeoRow[];
    colorsByZip: ReadonlyMap<string, string>;
    selectedZip: string | null;
    onSelectZip: (zip: string) => void;
}

type LoadState = 'idle' | 'ready' | 'failed';

const DEFAULT_CENTER = { lat: 39.8283, lng: -98.5795 };
const DEFAULT_ZOOM = 4;

function hasFiniteCoordinates(row: GeoRow): row is GeoRow & {
    geometry: GeoRow['geometry'] & { lat: number; lon: number };
} {
    const { lat, lon } = row.geometry;
    return lat !== null && lon !== null
        && Number.isFinite(lat) && Number.isFinite(lon)
        && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

export function GeoPostalCodeMap({
    rows,
    colorsByZip,
    selectedZip,
    onSelectZip,
}: GeoPostalCodeMapProps) {
    const mapElementRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<google.maps.Map | null>(null);
    const featureLayerRef = useRef<google.maps.FeatureLayer | null>(null);
    const featureClickRef = useRef<google.maps.MapsEventListener | null>(null);
    const capabilityListenerRef = useRef<google.maps.MapsEventListener | null>(null);
    const idleListenerRef = useRef<google.maps.MapsEventListener | null>(null);
    const markersRef = useRef<google.maps.Marker[]>([]);
    const activeMapIdRef = useRef<string | null>(null);
    const boundsKeyRef = useRef<string | null>(null);
    const [loadState, setLoadState] = useState<LoadState>('idle');
    const [capabilityRevision, setCapabilityRevision] = useState(0);
    // Lazy-load: don't touch Google (script, tiles, billed map load) until the map
    // scrolls near the viewport. A visit that never reaches the geo section costs 0.
    const [inView, setInView] = useState(false);
    const configuredMapId = getGoogleMapsMapId();
    const hasMapPoints = rows.some(row => (
        Boolean(row.geometry.google_place_id?.trim()) || hasFiniteCoordinates(row)
    ));

    const clearDataOverlays = useCallback(() => {
        idleListenerRef.current?.remove();
        idleListenerRef.current = null;
        featureClickRef.current?.remove();
        featureClickRef.current = null;
        markersRef.current.forEach(marker => {
            google.maps.event.clearInstanceListeners(marker);
            marker.setMap(null);
        });
        markersRef.current = [];
        if (featureLayerRef.current) {
            featureLayerRef.current.style = null;
            featureLayerRef.current = null;
        }
    }, []);

    useEffect(() => {
        const element = mapElementRef.current;
        if (!element || inView) return;
        if (typeof IntersectionObserver === 'undefined') {
            setInView(true);
            return;
        }
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) {
                setInView(true);
                observer.disconnect();
            }
        }, { rootMargin: '200px' });
        observer.observe(element);
        return () => observer.disconnect();
    }, [inView]);

    useEffect(() => {
        if (!hasMapPoints || !inView || loadState !== 'idle') return;
        let cancelled = false;
        loadGoogleMaps()
            .then(() => {
                if (!cancelled) setLoadState('ready');
            })
            .catch(error => {
                console.warn('[GeoPostalCodeMap] Google Maps unavailable:', error);
                if (!cancelled) setLoadState('failed');
            });
        return () => {
            cancelled = true;
        };
    }, [hasMapPoints, inView, loadState]);

    useEffect(() => {
        if (loadState !== 'ready' || !mapElementRef.current || mapRef.current) return;
        if (typeof google === 'undefined' || !google.maps) return;

        const baseOptions: google.maps.MapOptions = {
            center: DEFAULT_CENTER,
            zoom: DEFAULT_ZOOM,
            disableDefaultUI: true,
            gestureHandling: 'cooperative',
            clickableIcons: false,
            keyboardShortcuts: false,
        };
        activeMapIdRef.current = null;
        if (configuredMapId) {
            try {
                mapRef.current = new google.maps.Map(mapElementRef.current, {
                    ...baseOptions,
                    mapId: configuredMapId,
                });
                activeMapIdRef.current = configuredMapId;
                capabilityListenerRef.current = mapRef.current.addListener(
                    'mapcapabilities_changed',
                    () => setCapabilityRevision(revision => revision + 1),
                );
            } catch (error) {
                console.warn('[GeoPostalCodeMap] Vector Map ID failed; using centroid markers:', error);
                mapRef.current = new google.maps.Map(mapElementRef.current, baseOptions);
            }
        } else {
            mapRef.current = new google.maps.Map(mapElementRef.current, baseOptions);
        }

        return () => {
            capabilityListenerRef.current?.remove();
            capabilityListenerRef.current = null;
            clearDataOverlays();
            mapRef.current = null;
            activeMapIdRef.current = null;
            boundsKeyRef.current = null;
        };
    }, [clearDataOverlays, configuredMapId, loadState]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || loadState !== 'ready') return;
        clearDataOverlays();

        const placeIdToZip = new Map<string, string>();
        const stylesByPlaceId = new Map<string, google.maps.FeatureStyleOptions>();
        const ink = getComputedStyle(document.documentElement)
            .getPropertyValue('--blanc-ink-1')
            .trim();

        for (const row of rows) {
            const placeId = row.geometry.google_place_id?.trim();
            if (!placeId || row.geometry.status !== 'resolved') continue;
            placeIdToZip.set(placeId, row.zip);
            stylesByPlaceId.set(placeId, {
                fillColor: colorsByZip.get(row.zip) ?? NEUTRAL_HEAT,
                fillOpacity: 0.55,
                strokeWeight: row.zip === selectedZip ? 2.5 : 0,
                ...(row.zip === selectedZip && ink ? { strokeColor: ink } : {}),
            });
        }

        let ddsActive = false;
        if (activeMapIdRef.current && stylesByPlaceId.size > 0) {
            try {
                if (map.getMapCapabilities().isDataDrivenStylingAvailable) {
                    const postalCodeType = google.maps.FeatureType?.POSTAL_CODE
                        || ('POSTAL_CODE' as google.maps.FeatureType);
                    const featureLayer = map.getFeatureLayer(postalCodeType);
                    if (featureLayer.isAvailable) {
                        featureLayer.style = ({ feature }) => stylesByPlaceId.get(
                            (feature as google.maps.PlaceFeature).placeId
                        );
                        featureClickRef.current = featureLayer.addListener(
                            'click',
                            (event: google.maps.FeatureMouseEvent) => {
                                const placeId = (event.features[0] as google.maps.PlaceFeature | undefined)?.placeId;
                                const zip = placeId ? placeIdToZip.get(placeId) : undefined;
                                if (zip) onSelectZip(zip);
                            },
                        );
                        featureLayerRef.current = featureLayer;
                        ddsActive = true;
                    }
                }
            } catch (error) {
                console.warn('[GeoPostalCodeMap] ZIP boundaries unavailable; using centroid markers:', error);
            }
        }

        const markerRows = ddsActive
            ? rows.filter(row => row.geometry.status !== 'resolved' || !row.geometry.google_place_id?.trim())
            : rows;
        markerRows.filter(hasFiniteCoordinates).forEach(row => {
            const selected = row.zip === selectedZip;
            const marker = new google.maps.Marker({
                map,
                position: { lat: row.geometry.lat, lng: row.geometry.lon },
                title: row.zip,
                clickable: true,
                draggable: false,
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    fillColor: colorsByZip.get(row.zip) ?? NEUTRAL_HEAT,
                    fillOpacity: 0.92,
                    scale: selected ? 10 : 8,
                    strokeColor: ink || undefined,
                    strokeOpacity: selected ? 1 : 0.32,
                    strokeWeight: selected ? 2.5 : 1,
                },
            });
            marker.addListener('click', () => onSelectZip(row.zip));
            markersRef.current.push(marker);
        });

        // Fit the viewport only when the visible ZIP set changes — not on every
        // selection recolor, which would otherwise snap away a manual zoom/pan.
        const coordinates = rows.filter(hasFiniteCoordinates);
        const boundsKey = coordinates.map(row => row.zip).sort().join(',');
        if (boundsKey !== boundsKeyRef.current) {
            boundsKeyRef.current = boundsKey;
            if (coordinates.length === 1) {
                map.setCenter({ lat: coordinates[0].geometry.lat, lng: coordinates[0].geometry.lon });
                map.setZoom(11);
            } else if (coordinates.length > 1) {
                const bounds = new google.maps.LatLngBounds();
                coordinates.forEach(row => bounds.extend({
                    lat: row.geometry.lat,
                    lng: row.geometry.lon,
                }));
                map.fitBounds(bounds, 28);
                idleListenerRef.current = google.maps.event.addListenerOnce(map, 'idle', () => {
                    const zoom = map.getZoom();
                    if (zoom !== undefined && zoom > 13) map.setZoom(13);
                    idleListenerRef.current = null;
                });
            }
        }

        return clearDataOverlays;
    }, [capabilityRevision, clearDataOverlays, colorsByZip, loadState, onSelectZip, rows, selectedZip]);

    const unavailable = loadState === 'failed' || (!hasMapPoints && rows.length > 0);

    return (
        <>
            <div ref={mapElementRef} className="geo-heatmap__map-canvas" aria-label="ZIP performance map" />
            {loadState === 'idle' && hasMapPoints && (
                <div className="geo-heatmap__map-note">Loading map…</div>
            )}
            {unavailable && (
                <div className="geo-heatmap__map-note">Map unavailable — see Top ZIPs below</div>
            )}
        </>
    );
}
