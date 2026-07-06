/**
 * ScheduleJobsMap — mobile Schedule day map (SCHEDULE-MOBILE-MAP-001).
 *
 * Presentational, self-contained Google map for an ALREADY-filtered set of
 * schedule items — the exact `schedule.scheduledItems` the mobile day list
 * shows (provider/tag filtered + day-scoped by useScheduleData). Reads props
 * only: NO fetch, NO React Query, NO SSE, NO client geocoding, NO write-back.
 *
 * Behavior:
 *  - `await loadGoogleMaps()` on mount; loader rejection (missing key / load
 *    failure) → inline "Map unavailable" message (never a blank/broken map).
 *  - Plottable = geocoding_status==='success' && lat/lng present. Un-geocoded
 *    jobs are excluded (owner decision 3) and counted in a small note.
 *  - Group plottable jobs by assigned tech id (else "Unassigned"), sort each
 *    group by start_at, number 1..N = route order. Pin color =
 *    getProviderColor(techId).accent (matches the tile left-border on the same
 *    page); Unassigned = neutral gray.
 *  - Straight google.maps.Polyline per tech through its stops in order (tech
 *    color; NO Directions API — owner decision 4).
 *  - InfoWindow on marker click; fitBounds over plotted points with a max-zoom
 *    clamp so a single stop is not zoomed to the max.
 *  - Re-renders on `jobs`/`companyTz` change via a keyed effect; full cleanup
 *    (markers/polylines/listeners/InfoWindow) on unmount / before each re-place.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { loadGoogleMaps } from '../../utils/loadGoogleMaps';
import { makePinSvg } from '../../utils/mapPins';
import { getProviderColor } from '../../utils/providerColors';
import { formatTimeInTZ } from '../../utils/companyTime';
import type { ScheduleItem } from '../../services/scheduleApi';

interface ScheduleJobsMapProps {
    /** The SAME items the mobile day list shows (already provider/tag filtered,
        already scoped to the selected day). Parent passes schedule.scheduledItems. */
    jobs: ScheduleItem[];
    /** Company IANA tz (schedule.settings.timezone) — for InfoWindow time formatting. */
    companyTz: string;
}

// Fallback map view when there is nothing to plot (greater-Boston, matching the
// slot picker's default so the empty map lands somewhere sensible).
const DEFAULT_CENTER = { lat: 42.05, lng: -71.41 };
const DEFAULT_ZOOM = 9;
const MAX_FIT_ZOOM = 14;
const UNASSIGNED_ID = '__unassigned__';
const UNASSIGNED_COLOR = '#94a3b8'; // neutral slate-400

interface PlottedJob {
    job: ScheduleItem;
    lat: number;
    lng: number;
    num: number;       // 1-based route order within the tech group
    techId: string;    // group key (UNASSIGNED_ID for no-tech)
    techName: string;
    color: string;     // pin + connector color
}

interface TechGroupMeta {
    techId: string;
    techName: string;
    color: string;
    stops: PlottedJob[];
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Group plottable jobs by assigned tech id, sort each group by start_at, and
 *  number 1..N. Multi-tech jobs count once under assigned_techs[0]. */
function buildGroups(jobs: ScheduleItem[]): { groups: TechGroupMeta[]; plotted: PlottedJob[] } {
    // Preserve first-seen order of tech groups for a stable legend.
    const order: string[] = [];
    const buckets = new Map<string, { techName: string; items: ScheduleItem[] }>();

    for (const job of jobs) {
        const primary = job.assigned_techs?.[0];
        const techId = primary?.id || UNASSIGNED_ID;
        const techName = primary?.name || 'Unassigned';
        if (!buckets.has(techId)) {
            buckets.set(techId, { techName, items: [] });
            order.push(techId);
        }
        buckets.get(techId)!.items.push(job);
    }

    const groups: TechGroupMeta[] = [];
    const plotted: PlottedJob[] = [];

    for (const techId of order) {
        const bucket = buckets.get(techId)!;
        // Sort by start_at ascending; missing/malformed start sorts as 0.
        const sorted = [...bucket.items].sort((a, b) => {
            const ta = a.start_at ? new Date(a.start_at).getTime() || 0 : 0;
            const tb = b.start_at ? new Date(b.start_at).getTime() || 0 : 0;
            return ta - tb;
        });
        // getProviderColor is total; mirror the tile's `id || name` key so pin
        // colors equal the tile left-borders. Unassigned uses the explicit gray.
        const primary = sorted[0]?.assigned_techs?.[0];
        const color = techId === UNASSIGNED_ID
            ? UNASSIGNED_COLOR
            : getProviderColor(primary?.id || primary?.name || techId).accent;

        const stops: PlottedJob[] = sorted.map((job, i) => ({
            job,
            lat: job.lat as number,
            lng: job.lng as number,
            num: i + 1,
            techId,
            techName: bucket.techName,
            color,
        }));
        groups.push({ techId, techName: bucket.techName, color, stops });
        plotted.push(...stops);
    }

    return { groups, plotted };
}

export function ScheduleJobsMap({ jobs, companyTz }: ScheduleJobsMapProps) {
    const mapDivRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<google.maps.Map | null>(null);
    const markersRef = useRef<google.maps.Marker[]>([]);
    const polylinesRef = useRef<google.maps.Polyline[]>([]);
    const listenersRef = useRef<google.maps.MapsEventListener[]>([]);
    const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);

    // 'loading' until the loader resolves/rejects; 'ready' → map usable;
    // 'error' → key missing / load failed → inline message.
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

    // Plottable subset + grouping (memoized on jobs identity — the parent passes
    // a fresh array on each filter/day change).
    const { groups, plotted } = useMemo(() => {
        const plottable = jobs.filter(
            j => j.geocoding_status === 'success' && j.lat != null && j.lng != null,
        );
        return buildGroups(plottable);
    }, [jobs]);

    const unplottableCount = jobs.length - plotted.length;

    // ── Load Google Maps + build the map instance once ──
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

    // ── Place / re-place markers + connectors whenever the plotted set changes ──
    useEffect(() => {
        if (status !== 'ready' || !mapRef.current) return;
        const map = mapRef.current;

        // Clear previous markers/polylines/listeners/InfoWindow.
        const clear = () => {
            markersRef.current.forEach(m => m.setMap(null));
            markersRef.current = [];
            polylinesRef.current.forEach(p => p.setMap(null));
            polylinesRef.current = [];
            listenersRef.current.forEach(l => l.remove());
            listenersRef.current = [];
            infoWindowRef.current?.close();
        };
        clear();

        if (plotted.length === 0) {
            map.setCenter(DEFAULT_CENTER);
            map.setZoom(DEFAULT_ZOOM);
            return;
        }

        if (!infoWindowRef.current) infoWindowRef.current = new google.maps.InfoWindow();
        const infoWindow = infoWindowRef.current;
        const bounds = new google.maps.LatLngBounds();

        for (const group of groups) {
            // Connector: straight polyline through this tech's stops in order (≥2).
            if (group.stops.length >= 2) {
                const line = new google.maps.Polyline({
                    path: group.stops.map(s => ({ lat: s.lat, lng: s.lng })),
                    geodesic: false,
                    strokeColor: group.color,
                    strokeOpacity: 0.7,
                    strokeWeight: 3,
                    map,
                });
                polylinesRef.current.push(line);
            }

            for (const stop of group.stops) {
                const position = { lat: stop.lat, lng: stop.lng };
                const marker = new google.maps.Marker({
                    position,
                    map,
                    icon: {
                        url: makePinSvg(stop.num, stop.color),
                        scaledSize: new google.maps.Size(28, 40),
                        anchor: new google.maps.Point(14, 40),
                    },
                    title: `${stop.techName} #${stop.num} — ${stop.job.customer_name}`,
                    zIndex: 100 - stop.num,
                });

                const timeStr = stop.job.start_at
                    ? formatTimeInTZ(new Date(stop.job.start_at), companyTz)
                    : '';
                const heading = `${stop.techName} #${stop.num} — ${stop.job.customer_name || stop.job.title || `Job #${stop.job.entity_id}`}`;
                const infoContent = `<div style="font-size:13px;max-width:220px">
                    <div style="font-weight:700;margin-bottom:3px;color:${stop.color}">${escapeHtml(heading)}</div>
                    ${timeStr ? `<div style="color:#6b7280">${escapeHtml(timeStr)}</div>` : ''}
                    ${stop.job.title ? `<div style="color:#6b7280">${escapeHtml(stop.job.title)}</div>` : ''}
                    ${stop.job.subtitle ? `<div style="color:#6b7280">${escapeHtml(stop.job.subtitle)}</div>` : ''}
                    ${stop.job.address_summary ? `<div style="color:#9ca3af;font-size:11px;margin-top:2px">${escapeHtml(stop.job.address_summary)}</div>` : ''}
                </div>`;

                const listener = marker.addListener('click', () => {
                    infoWindow.setContent(infoContent);
                    infoWindow.open(map, marker);
                });
                listenersRef.current.push(listener);
                markersRef.current.push(marker);
                bounds.extend(position);
            }
        }

        map.fitBounds(bounds);
        // Clamp the max zoom on first idle so a single stop (zero-area bounds)
        // does not zoom to the max.
        const idle = google.maps.event.addListenerOnce(map, 'idle', () => {
            const z = map.getZoom();
            if (z != null && z > MAX_FIT_ZOOM) map.setZoom(MAX_FIT_ZOOM);
        });
        listenersRef.current.push(idle);
    }, [status, groups, plotted, companyTz]);

    // ── Full cleanup on unmount ──
    useEffect(() => {
        return () => {
            markersRef.current.forEach(m => m.setMap(null));
            markersRef.current = [];
            polylinesRef.current.forEach(p => p.setMap(null));
            polylinesRef.current = [];
            listenersRef.current.forEach(l => l.remove());
            listenersRef.current = [];
            infoWindowRef.current?.close();
            infoWindowRef.current = null;
        };
    }, []);

    if (status === 'error') {
        return (
            <div
                className="flex items-center justify-center text-center px-6"
                style={{
                    minHeight: 320,
                    height: '100%',
                    color: 'var(--blanc-ink-3, var(--sched-ink-3))',
                    fontSize: 14,
                }}
            >
                Map unavailable
            </div>
        );
    }

    return (
        <div
            className="relative overflow-hidden"
            style={{
                // Full-height map filling the mobile content area.
                height: 'calc(100dvh - 220px)',
                minHeight: 360,
                borderRadius: 16,
            }}
        >
            <div ref={mapDivRef} style={{ width: '100%', height: '100%' }} />

            {/* Empty state — no plottable jobs for this day/filter. */}
            {status === 'ready' && plotted.length === 0 && (
                <div
                    className="absolute inset-0 flex items-center justify-center pointer-events-none text-center px-6"
                    style={{ color: 'var(--blanc-ink-3, var(--sched-ink-3))', fontSize: 14 }}
                >
                    No mapped jobs for this day
                </div>
            )}

            {/* Per-tech legend (only techs actually plotted). */}
            {plotted.length > 0 && groups.length > 0 && (
                <div
                    className="absolute top-2 left-2 flex flex-col gap-1 px-2.5 py-2"
                    style={{
                        background: 'var(--sched-surface-strong, #fffdf9)',
                        border: '1px solid rgba(104, 95, 80, 0.14)',
                        borderRadius: 12,
                        boxShadow: '0 6px 16px rgba(48, 39, 28, 0.06)',
                        maxWidth: '60%',
                    }}
                >
                    {groups.map(g => (
                        <span key={g.techId} className="flex items-center gap-1.5 text-[12px] truncate" style={{ color: 'var(--sched-ink-1)' }}>
                            <span className="inline-block size-2.5 rounded-full shrink-0" style={{ background: g.color }} />
                            <span className="truncate">{g.techName}</span>
                        </span>
                    ))}
                </div>
            )}

            {/* Un-geocoded jobs note — jobs the list shows but the map can't place. */}
            {unplottableCount > 0 && (
                <div
                    className="absolute bottom-2 left-2 px-2.5 py-1.5 text-[12px]"
                    style={{
                        background: 'var(--sched-surface-strong, #fffdf9)',
                        border: '1px solid rgba(104, 95, 80, 0.14)',
                        borderRadius: 12,
                        color: 'var(--blanc-ink-3, var(--sched-ink-3))',
                        boxShadow: '0 6px 16px rgba(48, 39, 28, 0.06)',
                    }}
                >
                    {unplottableCount} job{unplottableCount === 1 ? '' : 's'} without a location
                </div>
            )}
        </div>
    );
}
