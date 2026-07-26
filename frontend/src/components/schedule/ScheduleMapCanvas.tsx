import { memo, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Search, X } from 'lucide-react';
import { formatTimeInTZ } from '../../utils/companyTime';
import { loadGoogleMaps } from '../../utils/loadGoogleMaps';
import { makeSchedulePinSvg } from '../../utils/mapPins';
import type { ScheduleItem } from '../../services/scheduleApi';
import type { ScheduleMapModel } from './scheduleMapModel';

const DEFAULT_CENTER = { lat: 42.05, lng: -71.41 };
const DEFAULT_ZOOM = 9;
const MAX_FIT_ZOOM = 14;

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

interface ScheduleMapCanvasProps {
    model: ScheduleMapModel;
    companyTz: string;
    selectedJobKey?: string | null;
    hoveredJobKey?: string | null;
    onSelectJob?: (job: ScheduleItem) => void;
    onHoverJob?: (jobKey: string | null) => void;
    className?: string;
    style?: CSSProperties;
}

/**
 * Shared Google Maps renderer used by both mobile Day and desktop Day/Timeline.
 * Marker/route placement depends only on the memoized model; selection and
 * hover mutate marker scale/z-index in a separate effect and never rebuild geometry.
 */
export const ScheduleMapCanvas = memo(function ScheduleMapCanvas({
    model,
    companyTz,
    selectedJobKey,
    hoveredJobKey,
    onSelectJob,
    onHoverJob,
    className,
    style,
}: ScheduleMapCanvasProps) {
    const mapDivRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<google.maps.Map | null>(null);
    const markersRef = useRef<google.maps.Marker[]>([]);
    const markerByKeyRef = useRef(new Map<string, google.maps.Marker>());
    const polylinesRef = useRef<Array<{ line: google.maps.Polyline; jobKeys: Set<string>; baseOpacity: number }>>([]);
    const listenersRef = useRef<google.maps.MapsEventListener[]>([]);
    const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
    const onSelectRef = useRef(onSelectJob);
    const onHoverRef = useRef(onHoverJob);
    const searchMarkerRef = useRef<google.maps.Marker | null>(null);
    const geocoderRef = useRef<google.maps.Geocoder | null>(null);
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [zip, setZip] = useState('');
    const [zipError, setZipError] = useState<string | null>(null);
    const [zipActive, setZipActive] = useState(false);
    const showInitialsNotice = model.pins.some(pin => Boolean(pin.initials));
    const singleStopRoute = model.totalJobs === 1
        ? model.routes.find(route => route.stops.length === 1)
        : undefined;

    useEffect(() => { onSelectRef.current = onSelectJob; }, [onSelectJob]);
    useEffect(() => { onHoverRef.current = onHoverJob; }, [onHoverJob]);

    useEffect(() => {
        let cancelled = false;
        loadGoogleMaps()
            .then(() => {
                if (cancelled) return;
                if (mapDivRef.current && !mapRef.current) {
                    mapRef.current = new google.maps.Map(mapDivRef.current, {
                        center: DEFAULT_CENTER,
                        zoom: DEFAULT_ZOOM,
                        mapTypeControl: false,
                        streetViewControl: false,
                        fullscreenControl: false,
                        styles: [
                            { featureType: 'poi', stylers: [{ visibility: 'off' }] },
                            { featureType: 'transit', stylers: [{ visibility: 'off' }] },
                        ],
                    });
                }
                setStatus('ready');
            })
            .catch(() => { if (!cancelled) setStatus('error'); });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        if (status !== 'ready' || !mapRef.current) return;
        const map = mapRef.current;

        markersRef.current.forEach(marker => marker.setMap(null));
        markersRef.current = [];
        markerByKeyRef.current.clear();
        polylinesRef.current.forEach(({ line }) => line.setMap(null));
        polylinesRef.current = [];
        listenersRef.current.forEach(listener => listener.remove());
        listenersRef.current = [];
        infoWindowRef.current?.close();

        if (model.pins.length === 0) {
            map.setCenter(DEFAULT_CENTER);
            map.setZoom(DEFAULT_ZOOM);
            return;
        }

        if (!infoWindowRef.current) infoWindowRef.current = new google.maps.InfoWindow();
        const infoWindow = infoWindowRef.current;
        const bounds = new google.maps.LatLngBounds();

        for (const route of model.routes) {
            for (const run of route.runs) {
                const path = run.map(stop => ({ lat: stop.lat, lng: stop.lng }));
                const jobKeys = new Set(run.map(stop => stop.jobKey));
                const underlay = new google.maps.Polyline({
                    path,
                    geodesic: false,
                    strokeColor: '#FFFFFF',
                    strokeOpacity: 0.84,
                    strokeWeight: 6,
                    clickable: false,
                    map,
                });
                const line = new google.maps.Polyline({
                    path,
                    geodesic: false,
                    strokeColor: route.color,
                    strokeOpacity: 0.78,
                    strokeWeight: 3,
                    clickable: false,
                    map,
                });
                polylinesRef.current.push(
                    { line: underlay, jobKeys, baseOpacity: 0.84 },
                    { line, jobKeys, baseOpacity: 0.78 },
                );
            }
        }

        for (const pin of model.pins) {
            const position = { lat: pin.lat, lng: pin.lng };
            const marker = new google.maps.Marker({
                position,
                map,
                icon: {
                    url: makeSchedulePinSvg({
                        label: pin.label,
                        color: pin.primaryColor,
                        secondaryColor: pin.secondaryColor,
                        unassigned: pin.unassigned,
                        initials: pin.initials,
                    }),
                    scaledSize: new google.maps.Size(34, 48),
                    anchor: new google.maps.Point(17, 44),
                },
                title: pin.unassigned
                    ? `Unassigned — ${pin.job.title}`
                    : `${pin.technicianNames.join(' + ')} — ${pin.job.title}`,
                zIndex: 100,
            });

            const time = pin.job.start_at
                ? formatTimeInTZ(new Date(pin.job.start_at), companyTz)
                : '';
            const order = pin.routeOrders
                .map(routeOrder => `${routeOrder.technicianName} #${routeOrder.order}`)
                .join(' · ');
            const heading = pin.job.title || pin.job.customer_name || `Job #${pin.job.entity_id}`;
            const infoContent = `<div style="font-size:13px;max-width:240px;color:#191919">
                <div style="font-weight:700;margin-bottom:3px">${escapeHtml(heading)}</div>
                ${order ? `<div style="color:${pin.primaryColor};font-weight:600">${escapeHtml(order)}</div>` : '<div style="color:#6B7280;font-weight:600">Unassigned · no route</div>'}
                ${time ? `<div style="color:#6B7280">${escapeHtml(time)}</div>` : ''}
                ${pin.job.customer_name ? `<div style="color:#6B7280">${escapeHtml(pin.job.customer_name)}</div>` : ''}
                ${pin.job.address_summary ? `<div style="color:#6B7280;font-size:11px;margin-top:3px">${escapeHtml(pin.job.address_summary)}</div>` : ''}
            </div>`;

            listenersRef.current.push(
                marker.addListener('click', () => {
                    infoWindow.setContent(infoContent);
                    infoWindow.open(map, marker);
                    onSelectRef.current?.(pin.job);
                }),
                marker.addListener('mouseover', () => onHoverRef.current?.(pin.jobKey)),
                marker.addListener('mouseout', () => onHoverRef.current?.(null)),
            );
            markersRef.current.push(marker);
            markerByKeyRef.current.set(pin.jobKey, marker);
            bounds.extend(position);
        }

        map.fitBounds(bounds);
        const idle = google.maps.event.addListenerOnce(map, 'idle', () => {
            const zoom = map.getZoom();
            if (zoom != null && zoom > MAX_FIT_ZOOM) map.setZoom(MAX_FIT_ZOOM);
        });
        listenersRef.current.push(idle);
    }, [status, model, companyTz]);

    useEffect(() => {
        // Owner: do NOT resize the selected/hovered pin. Keep every pin the same
        // size; the active one only rises in z-order so it isn't hidden under
        // neighbouring pins. Selection is conveyed by the linked card frame.
        const activeKey = hoveredJobKey || selectedJobKey || null;
        for (const [jobKey, marker] of markerByKeyRef.current) {
            const active = jobKey === activeKey;
            marker.setZIndex(active ? 1000 : 100);
        }
    }, [selectedJobKey, hoveredJobKey, model]);

    useEffect(() => () => {
        markersRef.current.forEach(marker => marker.setMap(null));
        markersRef.current = [];
        markerByKeyRef.current.clear();
        polylinesRef.current.forEach(({ line }) => line.setMap(null));
        polylinesRef.current = [];
        listenersRef.current.forEach(listener => listener.remove());
        listenersRef.current = [];
        infoWindowRef.current?.close();
        infoWindowRef.current = null;
        searchMarkerRef.current?.setMap(null);
        searchMarkerRef.current = null;
    }, []);

    // ZIP lookup — geocode a ZIP with Google's own geocoder, pan there, drop a
    // distinct violet marker. Separate from the job markers (never rebuilt by the
    // model effect). Owner: "type a ZIP, see it on the map".
    const runZipSearch = (e: FormEvent) => {
        e.preventDefault();
        const q = zip.trim();
        const map = mapRef.current;
        if (!q || !map) return;
        setZipError(null);
        if (!geocoderRef.current) geocoderRef.current = new google.maps.Geocoder();
        geocoderRef.current.geocode(
            { componentRestrictions: { postalCode: q, country: 'US' } },
            (results, gstatus) => {
                const loc = results?.[0]?.geometry?.location;
                if (gstatus === 'OK' && loc) {
                    map.panTo(loc);
                    map.setZoom(12);
                    if (!searchMarkerRef.current) {
                        searchMarkerRef.current = new google.maps.Marker({
                            map,
                            icon: {
                                path: google.maps.SymbolPath.CIRCLE,
                                scale: 9,
                                fillColor: '#7F42E1',
                                fillOpacity: 1,
                                strokeColor: '#FFFFFF',
                                strokeWeight: 2,
                            },
                            zIndex: 2000,
                        });
                    }
                    searchMarkerRef.current.setPosition(loc);
                    setZipActive(true);
                } else {
                    setZipError('ZIP not found');
                }
            },
        );
    };

    const clearZipSearch = () => {
        setZip('');
        setZipError(null);
        setZipActive(false);
        searchMarkerRef.current?.setMap(null);
        searchMarkerRef.current = null;
    };

    if (status === 'error') {
        return (
            <div className={`flex items-center justify-center px-6 text-center ${className || ''}`} style={{ ...style, color: 'var(--blanc-ink-3)', fontSize: 14 }}>
                Map unavailable
            </div>
        );
    }

    return (
        <div className={`relative overflow-hidden ${className || ''}`} style={style}>
            <div ref={mapDivRef} className="h-full w-full" />

            {status === 'ready' && (
                <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
                    <form
                        onSubmit={runZipSearch}
                        className="flex items-center gap-1.5 rounded-xl px-2 py-1.5"
                        style={{ background: 'var(--blanc-surface-strong)', border: '1px solid var(--blanc-line)', boxShadow: 'var(--blanc-shadow-sm)' }}
                    >
                        <Search className="size-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                        <input
                            value={zip}
                            onChange={e => { setZip(e.target.value); setZipError(null); }}
                            placeholder="Find a ZIP on the map"
                            inputMode="numeric"
                            aria-label="Find a ZIP on the map"
                            className="w-[128px] bg-transparent text-[12px] outline-none placeholder:text-[var(--blanc-ink-3)]"
                            style={{ color: 'var(--blanc-ink-1)' }}
                        />
                        {zipActive && (
                            <button type="button" onClick={clearZipSearch} aria-label="Clear ZIP" className="shrink-0" style={{ color: 'var(--blanc-ink-3)' }}>
                                <X className="size-3.5" />
                            </button>
                        )}
                    </form>
                    {zipError && (
                        <span className="rounded-lg px-2 py-1 text-[11px] font-medium" style={{ background: 'var(--blanc-surface-strong)', border: '1px solid var(--blanc-line)', color: 'var(--blanc-danger)' }}>
                            {zipError}
                        </span>
                    )}
                </div>
            )}

            {status === 'ready' && model.pins.length === 0 && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                    {model.totalJobs > 0 ? 'No pins for these filters' : 'No routes today'}
                </div>
            )}

            {model.legend.length > 0 && (
                <div
                    className="absolute left-2 top-2 flex max-h-[70%] max-w-[68%] flex-col gap-1 overflow-y-auto rounded-xl px-2.5 py-2"
                    style={{
                        background: 'var(--blanc-surface-strong)',
                        border: '1px solid var(--blanc-line)',
                        boxShadow: 'var(--blanc-shadow-sm)',
                    }}
                >
                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--blanc-ink-3)' }}>
                        Technicians
                    </span>
                    {model.legend.map(item => (
                        <span key={item.id} className="flex items-center gap-1.5 truncate text-[12px]" style={{ color: 'var(--blanc-ink-1)' }}>
                            <span
                                className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[8px] font-bold"
                                style={{
                                    background: item.unassigned ? 'var(--blanc-surface-strong)' : item.color,
                                    border: item.unassigned ? `2px solid ${item.color}` : 'none',
                                    color: item.unassigned ? item.color : '#FFFFFF',
                                }}
                            >
                                {item.initials}
                            </span>
                            <span className="truncate">{item.name}</span>
                        </span>
                    ))}
                </div>
            )}

            {(showInitialsNotice || singleStopRoute) && (
                <div
                    className="absolute bottom-2 right-2 max-w-[64%] rounded-xl px-2.5 py-1.5 text-[11px]"
                    style={{
                        background: 'var(--blanc-surface-strong)',
                        border: '1px solid var(--blanc-line)',
                        boxShadow: 'var(--blanc-shadow-sm)',
                        color: 'var(--blanc-ink-2)',
                    }}
                >
                    {showInitialsNotice
                        ? 'Roster exceeds 16 colours · initials distinguish overlapping pins'
                        : `1 stop for ${singleStopRoute?.technicianName} · no route line needed`}
                </div>
            )}
        </div>
    );
});
