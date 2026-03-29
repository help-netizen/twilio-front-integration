import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { ChevronLeft, ChevronRight, CalendarIcon } from 'lucide-react';
import { Calendar } from '../ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { listJobs, updateJobCoords } from '../../services/jobsApi';
import type { LocalJob } from '../../services/jobsApi';
import { getTeamMembers } from '../../services/zenbookerApi';
import type { TeamMember } from '../../services/zenbookerApi';
import { useAuth } from '../../auth/AuthProvider';
import { dateInTZ, todayInTZ } from '../../utils/companyTime';
import './CustomTimeModal.css';

// ─── Constants ────────────────────────────────────────────────────────────────

const TECH_COLORS = [
    { bg: '#3b82f6', light: '#dbeafe', name: 'blue' },   // blue
    { bg: '#f97316', light: '#ffedd5', name: 'orange' },  // orange
    { bg: '#8b5cf6', light: '#ede9fe', name: 'purple' },  // purple
    { bg: '#14b8a6', light: '#ccfbf1', name: 'teal' },    // teal
    { bg: '#ef4444', light: '#fee2e2', name: 'red' },     // red
    { bg: '#ec4899', light: '#fce7f3', name: 'pink' },    // pink
];
const HOUR_START = 7;
const HOUR_END = 19; // 7 PM
const HOUR_HEIGHT = 48;
const TOTAL_HOURS = HOUR_END - HOUR_START;
const SNAP_MINUTES = 30;
const DEFAULT_DURATION_MIN = 120;
const NEW_JOB_COLOR = '#16a34a';
const EXCLUDED_STATUSES = ['Canceled', 'Visit completed'];

interface CustomTimeModalProps {
    open: boolean;
    onClose: () => void;
    onConfirm: (customSlot: { type: 'arrival_window'; start: string; end: string; formatted: string; techId?: string }) => void;
    newJobCoords?: { lat: number; lng: number } | null;
    newJobAddress?: string;
    /** Duration of the new job in minutes (for preview block height) */
    newJobDuration?: number;
    /** Territory ID of the new job (from zip check) — used to prioritize matching techs */
    territoryId?: string;
    /** Job ID to exclude from timeline (for reschedule — hides the current job) */
    excludeJobId?: number;
    /** Pre-populate the green badge with an existing timeslot (for reschedule) */
    initialSlot?: { techId: string; start: string; end: string };
}

interface TechGroup {
    id: string;
    name: string;
    colorIndex: number;
    jobs: LocalJob[];
    matchesTerritory: boolean;
}

interface SelectedSlot {
    techId: string;
    start: Date;
    end: Date;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateLabel(date: Date) {
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function getRelativeDayHint(dateStr: string, tz: string): string | null {
    const todayStr = todayInTZ(tz);
    if (dateStr === todayStr) return 'Today';
    // Tomorrow: add 1 day to today
    const [y, m, d] = todayStr.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    const tomorrowStr = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
    if (dateStr === tomorrowStr) return 'Tomorrow';
    return null;
}

function fmtTime(d: Date, tz?: string) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, ...(tz && { timeZone: tz }) });
}

function minutesSinceMidnight(d: Date, tz?: string) {
    if (!tz) return d.getHours() * 60 + d.getMinutes();
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
    const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
    // Intl hour12:false may return 24 for midnight
    return (h === 24 ? 0 : h) * 60 + m;
}

function snapToGrid(y: number, containerTop: number): number {
    const offsetY = Math.max(0, y - containerTop);
    const totalMinutes = (offsetY / HOUR_HEIGHT) * 60;
    const snapped = Math.round(totalMinutes / SNAP_MINUTES) * SNAP_MINUTES;
    return Math.max(0, Math.min(snapped, TOTAL_HOURS * 60 - SNAP_MINUTES));
}

/**
 * Build tech groups from ALL providers, merging in jobs.
 * Priority: 1) Techs whose territories include territoryId  2) Least loaded first
 */
function buildTechGroups(providers: TeamMember[], jobs: LocalJob[], territoryId?: string): TechGroup[] {
    const activeJobs = jobs.filter(j => !EXCLUDED_STATUSES.includes(j.blanc_status || ''));

    // Map jobs → tech id
    const jobsByTech = new Map<string, LocalJob[]>();
    for (const job of activeJobs) {
        const techs = job.assigned_techs;
        if (techs && techs.length > 0) {
            for (const tech of techs) {
                if (!jobsByTech.has(tech.id)) jobsByTech.set(tech.id, []);
                jobsByTech.get(tech.id)!.push(job);
            }
        }
    }

    // Build groups for ALL providers
    const groups: (TechGroup & { matchesTerritory: boolean })[] = providers.map((prov, i) => {
        const techJobs = (jobsByTech.get(prov.id) || []).sort(
            (a, b) => new Date(a.start_date || 0).getTime() - new Date(b.start_date || 0).getTime()
        );
        const matchesTerritory = territoryId
            ? (prov.assigned_territories || []).some(t => t.id === territoryId)
            : true;
        return {
            id: prov.id,
            name: prov.name,
            colorIndex: i % TECH_COLORS.length,
            jobs: techJobs,
            matchesTerritory,
        };
    });

    // Sort: territory-matching first, then by least jobs (least loaded first)
    groups.sort((a, b) => {
        if (a.matchesTerritory !== b.matchesTerritory) return a.matchesTerritory ? -1 : 1;
        return a.jobs.length - b.jobs.length;
    });

    // Re-assign colors after sort
    groups.forEach((g, i) => { g.colorIndex = i % TECH_COLORS.length; });
    return groups;
}

// ─── TechTimeline ─────────────────────────────────────────────────────────────

interface TechTimelineProps {
    tech: TechGroup;
    selectedDate: string;
    durationMin: number;
    selectedSlot: SelectedSlot | null;
    onSelectSlot: (slot: SelectedSlot) => void;
    matchesTerritory: boolean;
    companyTz: string;
}

function TechTimeline({ tech, selectedDate, durationMin, selectedSlot, onSelectSlot, matchesTerritory, companyTz }: TechTimelineProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [hoverMinutes, setHoverMinutes] = useState<number | null>(null);

    const color = TECH_COLORS[tech.colorIndex];
    const [y, m, d] = selectedDate.split('-').map(Number);

    // Compute past-time overlay height (only for today)
    const isToday = selectedDate === todayInTZ(companyTz);
    const nowMinFromGrid = isToday ? minutesSinceMidnight(new Date(), companyTz) - HOUR_START * 60 : 0;
    const pastHeight = isToday ? Math.max(0, Math.min(nowMinFromGrid, TOTAL_HOURS * 60)) / 60 * HOUR_HEIGHT : 0;

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const mins = snapToGrid(e.clientY, rect.top);
        setHoverMinutes(mins);
    }, []);

    const handleMouseLeave = useCallback(() => setHoverMinutes(null), []);

    const handleClick = useCallback(() => {
        if (hoverMinutes === null) return;
        const startMinTotal = HOUR_START * 60 + hoverMinutes;
        const endMinTotal = Math.min(startMinTotal + durationMin, HOUR_END * 60);
        const start = dateInTZ(y, m, d, Math.floor(startMinTotal / 60), startMinTotal % 60, companyTz);
        const end = dateInTZ(y, m, d, Math.floor(endMinTotal / 60), endMinTotal % 60, companyTz);
        onSelectSlot({ techId: tech.id, start, end });
    }, [hoverMinutes, durationMin, y, m, d, tech.id, onSelectSlot, companyTz]);

    const isSelected = selectedSlot?.techId === tech.id;
    const selectedTop = isSelected ? ((minutesSinceMidnight(selectedSlot!.start, companyTz) - HOUR_START * 60) / 60) * HOUR_HEIGHT : 0;
    const selectedHeight = isSelected ? ((minutesSinceMidnight(selectedSlot!.end, companyTz) - minutesSinceMidnight(selectedSlot!.start, companyTz)) / 60) * HOUR_HEIGHT : 0;

    return (
        <div className="tech-timeline__col">
            <div
                ref={containerRef}
                className="tech-timeline__grid"
                style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}
                onMouseMove={handleMouseMove}
                onMouseLeave={handleMouseLeave}
                onClick={handleClick}
            >
                {/* Gray overlay for non-territory techs */}
                {!matchesTerritory && (
                    <div className="tech-timeline__no-territory" style={{ height: TOTAL_HOURS * HOUR_HEIGHT }} />
                )}

                {/* Gray overlay for past time (today only) */}
                {isToday && pastHeight > 0 && (
                    <>
                        <div className="tech-timeline__past" style={{ height: pastHeight }} />
                        <div className="tech-timeline__now-line" style={{ top: pastHeight }} />
                    </>
                )}

                {/* Hour grid lines only (labels are shared outside) */}
                {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => (
                    <div key={i} className="tech-timeline__hour-line" style={{ top: i * HOUR_HEIGHT }} />
                ))}

                {/* Existing job blocks */}
                {tech.jobs.map((job) => {
                    if (!job.start_date || !job.end_date) return null;
                    const startMin = minutesSinceMidnight(new Date(job.start_date), companyTz) - HOUR_START * 60;
                    const endMin = minutesSinceMidnight(new Date(job.end_date), companyTz) - HOUR_START * 60;
                    const top = (startMin / 60) * HOUR_HEIGHT;
                    const height = Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, 28);
                    const sTime = fmtTime(new Date(job.start_date), companyTz);
                    const eTime = fmtTime(new Date(job.end_date), companyTz);
                    return (
                        <div
                            key={job.id}
                            className="tech-timeline__job"
                            style={{ top, height, background: color.bg + 'cc', borderColor: color.bg }}
                            title={`${job.customer_name} ${sTime}–${eTime}`}
                        >
                            <span className="tech-timeline__job-time">{sTime}–{eTime}</span>
                            <span className="tech-timeline__job-name">{job.customer_name}</span>
                        </div>
                    );
                })}

                {/* Hover preview */}
                {hoverMinutes !== null && !isSelected && (
                    <div
                        className="tech-timeline__preview"
                        style={{
                            top: (hoverMinutes / 60) * HOUR_HEIGHT,
                            height: Math.min((durationMin / 60) * HOUR_HEIGHT, (TOTAL_HOURS * 60 - hoverMinutes) / 60 * HOUR_HEIGHT),
                        }}
                    />
                )}

                {/* Selected slot */}
                {isSelected && (
                    <div
                        className="tech-timeline__selected"
                        style={{ top: selectedTop, height: selectedHeight }}
                    >
                        <span className="tech-timeline__selected-label">
                            ★ New: {fmtTime(selectedSlot!.start, companyTz)}–{fmtTime(selectedSlot!.end, companyTz)}
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── JobMap ───────────────────────────────────────────────────────────────────

interface JobMapProps {
    jobs: LocalJob[];
    techGroups: TechGroup[];
    newJobCoords?: { lat: number; lng: number } | null;
    newJobAddress?: string;
    loading: boolean;
    companyTz: string;
}

function JobMap({ jobs, techGroups, newJobCoords, newJobAddress, loading, companyTz }: JobMapProps) {
    const mapRef = useRef<HTMLDivElement>(null);
    const mapInstanceRef = useRef<google.maps.Map | null>(null);
    const markersRef = useRef<google.maps.Marker[]>([]);
    const newJobMarkerRef = useRef<google.maps.Marker | null>(null);
    const [resolvedNewJobCoords, setResolvedNewJobCoords] = useState<{ lat: number; lng: number } | null>(null);
    const geocodeCacheRef = useRef<Map<string, { lat: number; lng: number } | null>>(new Map());

    const DEFAULT_CENTER = { lat: 42.05, lng: -71.41 };
    const DEFAULT_ZOOM = 9;

    // Initialize map
    useEffect(() => {
        if (!mapRef.current || mapInstanceRef.current) return;
        if (typeof google === 'undefined' || !google.maps) return;
        mapInstanceRef.current = new google.maps.Map(mapRef.current, {
            center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM,
            mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
            styles: [
                { featureType: 'poi', stylers: [{ visibility: 'off' }] },
                { featureType: 'transit', stylers: [{ visibility: 'off' }] },
            ],
        });
    }, []);

    // Geocode via new Place API (replaces deprecated PlacesService)
    const geocodeAddress = useCallback(async (address: string): Promise<{ lat: number; lng: number } | null> => {
        if (geocodeCacheRef.current.has(address)) return geocodeCacheRef.current.get(address)!;
        if (typeof google === 'undefined' || !google.maps?.places) return null;
        try {
            // Use new google.maps.places.Place.searchByText API
            const PlaceClass = google.maps.places.Place;
            if (PlaceClass && typeof PlaceClass.searchByText === 'function') {
                const { places } = await PlaceClass.searchByText({ textQuery: address, fields: ['location'], maxResultCount: 1 });
                if (places?.[0]?.location) {
                    const loc = { lat: places[0].location.lat(), lng: places[0].location.lng() };
                    geocodeCacheRef.current.set(address, loc);
                    return loc;
                }
            } else {
                // Fallback to legacy PlacesService if new API not available
                if (!mapInstanceRef.current) return null;
                return new Promise((resolve) => {
                    const service = new google.maps.places.PlacesService(mapInstanceRef.current!);
                    service.findPlaceFromQuery({ query: address, fields: ['geometry'] }, (results: any, status: any) => {
                        if (status === 'OK' && results?.[0]?.geometry?.location) {
                            const loc = { lat: results[0].geometry.location.lat(), lng: results[0].geometry.location.lng() };
                            geocodeCacheRef.current.set(address, loc);
                            resolve(loc);
                        } else { geocodeCacheRef.current.set(address, null); resolve(null); }
                    });
                });
            }
            geocodeCacheRef.current.set(address, null);
            return null;
        } catch { geocodeCacheRef.current.set(address, null); return null; }
    }, []);

    // Resolve new job coords
    useEffect(() => {
        if (newJobCoords?.lat && newJobCoords?.lng) { setResolvedNewJobCoords(newJobCoords); return; }
        if (newJobAddress) { geocodeAddress(newJobAddress).then(setResolvedNewJobCoords); }
        else { setResolvedNewJobCoords(null); }
    }, [newJobCoords, newJobAddress, geocodeAddress]);



    // Clear markers
    const clearMarkers = useCallback(() => {
        markersRef.current.forEach(m => m.setMap(null));
        markersRef.current = [];
    }, []);

    // Create colored SVG marker icon
    const makePinSvg = useCallback((num: number, color: string) => {
        return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
            <svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40">
                <path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.27 21.73 0 14 0z" fill="${color}" stroke="#fff" stroke-width="1.5"/>
                <text x="14" y="19" text-anchor="middle" fill="#fff" font-size="12" font-weight="bold" font-family="Arial">${num}</text>
            </svg>
        `);
    }, []);

    // Place markers
    useEffect(() => {
        if (!mapInstanceRef.current) return;
        clearMarkers();

        const bounds = new google.maps.LatLngBounds();
        let hasPoints = false;

        // New job marker
        if (resolvedNewJobCoords) {
            if (newJobMarkerRef.current) newJobMarkerRef.current.setMap(null);
            newJobMarkerRef.current = new google.maps.Marker({
                position: resolvedNewJobCoords, map: mapInstanceRef.current,
                icon: {
                    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
                        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="44" viewBox="0 0 32 44">
                            <path d="M16 0C7.16 0 0 7.16 0 16c0 12 16 28 16 28s16-16 16-28C32 7.16 24.84 0 16 0z" fill="${NEW_JOB_COLOR}" stroke="#fff" stroke-width="2"/>
                            <text x="16" y="20" text-anchor="middle" fill="#fff" font-size="16" font-weight="bold" font-family="Arial">★</text>
                        </svg>`),
                    scaledSize: new google.maps.Size(32, 44), anchor: new google.maps.Point(16, 44),
                },
                title: 'New Job Location', zIndex: 999,
            });
            bounds.extend(resolvedNewJobCoords);
            hasPoints = true;
        } else {
            if (newJobMarkerRef.current) { newJobMarkerRef.current.setMap(null); newJobMarkerRef.current = null; }
        }

        // Per-tech markers
        (async () => {
            for (const group of techGroups) {
                const color = TECH_COLORS[group.colorIndex].bg;
                for (let i = 0; i < group.jobs.length; i++) {
                    const job = group.jobs[i];
                    let position: { lat: number; lng: number } | null = null;
                    if (job.lat && job.lng) position = { lat: job.lat, lng: job.lng };
                    else if (job.address) {
                        position = await geocodeAddress(job.address);
                        if (position && job.id) updateJobCoords(job.id, position.lat, position.lng).catch(() => {});
                    }
                    if (!position || !mapInstanceRef.current) continue;

                    const num = i + 1;
                    const timeStr = job.start_date ? fmtTime(new Date(job.start_date), companyTz) : '';
                    const marker = new google.maps.Marker({
                        position, map: mapInstanceRef.current,
                        icon: { url: makePinSvg(num, color), scaledSize: new google.maps.Size(28, 40), anchor: new google.maps.Point(14, 40) },
                        title: `${group.name} #${num} — ${job.customer_name}`,
                        zIndex: 100 - i,
                    });
                    const infoContent = `<div style="font-size:13px;max-width:220px">
                        <div style="font-weight:700;margin-bottom:3px;color:${color}">${group.name} #${num} — ${job.customer_name || `Job #${job.id}`}</div>
                        ${timeStr ? `<div style="color:#6b7280">🕓 ${timeStr}</div>` : ''}
                        ${job.service_name ? `<div style="color:#6b7280">🔧 ${job.service_name}</div>` : ''}
                        ${job.address ? `<div style="color:#9ca3af;font-size:11px;margin-top:2px">${job.address}</div>` : ''}
                    </div>`;
                    const infoWindow = new google.maps.InfoWindow({ content: infoContent });
                    marker.addListener('click', () => infoWindow.open(mapInstanceRef.current!, marker));
                    markersRef.current.push(marker);
                    bounds.extend(position);
                    hasPoints = true;
                }
            }

            if (hasPoints && mapInstanceRef.current) {
                mapInstanceRef.current.fitBounds(bounds);
                const listener = google.maps.event.addListener(mapInstanceRef.current, 'idle', () => {
                    if (mapInstanceRef.current!.getZoom()! > 14) mapInstanceRef.current!.setZoom(14);
                    google.maps.event.removeListener(listener);
                });
            } else if (!hasPoints && mapInstanceRef.current) {
                mapInstanceRef.current.setCenter(DEFAULT_CENTER);
                mapInstanceRef.current.setZoom(DEFAULT_ZOOM);
            }
        })();
    }, [jobs, techGroups, resolvedNewJobCoords, clearMarkers, geocodeAddress, makePinSvg]);

    return (
        <div className="ctm-map">
            <div ref={mapRef} style={{ width: '100%', height: '100%', minHeight: 320 }} />
            {loading && (
                <div className="ctm-map__overlay animate-pulse">Loading jobs…</div>
            )}
            {/* Legend */}
            {techGroups.length > 0 && (
                <div className="ctm-map__legend">
                    {techGroups.map(g => (
                        <span key={g.id} className="ctm-map__legend-item">
                            <span className="ctm-map__legend-dot" style={{ background: TECH_COLORS[g.colorIndex].bg }} />
                            {g.name}
                        </span>
                    ))}
                    <span className="ctm-map__legend-item">
                        <span className="ctm-map__legend-dot" style={{ background: NEW_JOB_COLOR }}>★</span>
                        New
                    </span>
                </div>
            )}
        </div>
    );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export function CustomTimeModal({ open, onClose, onConfirm, newJobCoords, newJobAddress, newJobDuration, territoryId, excludeJobId, initialSlot }: CustomTimeModalProps) {
    const { company } = useAuth();
    const companyTz = company?.timezone || 'America/New_York';

    const getInitialDate = () => {
        if (initialSlot?.start) return new Intl.DateTimeFormat('en-CA', { timeZone: companyTz }).format(new Date(initialSlot.start));
        return todayInTZ(companyTz);
    };
    const getInitialSlot = (): SelectedSlot | null => {
        if (initialSlot) return { techId: initialSlot.techId, start: new Date(initialSlot.start), end: new Date(initialSlot.end) };
        return null;
    };
    const [selectedDate, setSelectedDate] = useState(getInitialDate);
    const [selectedSlot, setSelectedSlot] = useState<SelectedSlot | null>(getInitialSlot);
    const [calendarOpen, setCalendarOpen] = useState(false);

    // Re-populate when modal re-opens with initialSlot (reschedule mode)
    useEffect(() => {
        if (open && initialSlot) {
            const slotDate = new Intl.DateTimeFormat('en-CA', { timeZone: companyTz }).format(new Date(initialSlot.start));
            setSelectedDate(slotDate);
            setSelectedSlot({
                techId: initialSlot.techId,
                start: new Date(initialSlot.start),
                end: new Date(initialSlot.end),
            });
        }
    }, [open]);
    const [techPage, setTechPage] = useState(0);
    const [jobs, setJobs] = useState<LocalJob[]>([]);
    const [providers, setProviders] = useState<TeamMember[]>([]);
    const [loading, setLoading] = useState(false);
    const durationMin = newJobDuration || DEFAULT_DURATION_MIN;

    // Fetch providers once
    useEffect(() => {
        let cancelled = false;
        getTeamMembers().then(members => {
            if (!cancelled) setProviders(members);
        }).catch(() => {});
        return () => { cancelled = true; };
    }, []);

    // dateObj for Calendar UI — browser-local Date so Calendar component highlights correct day
    const dateObj = useMemo(() => {
        const [y, m, d] = selectedDate.split('-').map(Number);
        return new Date(y, m - 1, d);
    }, [selectedDate]);

    // Fetch jobs
    useEffect(() => {
        let cancelled = false;
        async function fetchJobs() {
            setLoading(true);
            try {
                const result = await listJobs({ start_date: selectedDate, end_date: selectedDate, limit: 200 });
                const allJobs = result.results || [];
                if (!cancelled) setJobs(excludeJobId ? allJobs.filter(j => j.id !== excludeJobId) : allJobs);
            } catch { if (!cancelled) setJobs([]); }
            finally { if (!cancelled) setLoading(false); }
        }
        fetchJobs();
        return () => { cancelled = true; };
    }, [selectedDate]);

    // Group jobs by tech — all providers, priority sorted
    const techGroups = useMemo(() => buildTechGroups(providers, jobs, territoryId), [providers, jobs, territoryId]);
    const totalPages = Math.max(1, Math.ceil(techGroups.length / 2));
    const visibleTechs = techGroups.slice(techPage * 2, techPage * 2 + 2);

    // Reset page when date changes; only clear slot if it doesn't match the new date
    useEffect(() => {
        setTechPage(0);
        setSelectedSlot(prev => {
            if (!prev) return null;
            const slotDate = new Intl.DateTimeFormat('en-CA', { timeZone: companyTz }).format(prev.start);
            return slotDate === selectedDate ? prev : null;
        });
    }, [selectedDate]);

    const handleConfirm = () => {
        if (!selectedSlot) return;
        // Prevent confirming a timeslot in the past
        if (selectedSlot.start.getTime() < Date.now()) {
            alert('Selected time is in the past. Please choose a future time.');
            return;
        }
        const dateLabel = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const techName = techGroups.find(g => g.id === selectedSlot.techId)?.name || '';
        const formatted = `${fmtTime(selectedSlot.start, companyTz)} – ${fmtTime(selectedSlot.end, companyTz)} — ${dateLabel}${techName ? ` (${techName})` : ''}`;
        onConfirm({
            type: 'arrival_window',
            start: selectedSlot.start.toISOString(),
            end: selectedSlot.end.toISOString(),
            formatted,
            techId: selectedSlot.techId,
        });
    };

    // Date navigation — use company timezone for "today"
    const today = todayInTZ(companyTz);
    const prevDate = () => {
        const [y, m, d] = selectedDate.split('-').map(Number);
        const prev = new Date(Date.UTC(y, m - 1, d - 1));
        const prevStr = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
        if (prevStr >= today) setSelectedDate(prevStr);
    };
    const nextDate = () => {
        const [y, m, d] = selectedDate.split('-').map(Number);
        const next = new Date(Date.UTC(y, m - 1, d + 1));
        const nextStr = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
        setSelectedDate(nextStr);
    };

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
            <DialogContent className="max-w-5xl max-h-[90vh] ctm-dialog" aria-describedby={undefined}>
                <DialogTitle className="sr-only">Schedule Time Slot</DialogTitle>

                {/* Date navigation */}
                <div className="ctm-date-nav">
                    <Button variant="ghost" size="icon" className="ctm-date-nav__arrow" onClick={prevDate} disabled={selectedDate <= today}>
                        <ChevronLeft className="w-4" />
                    </Button>
                    <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                        <PopoverTrigger asChild>
                            <button type="button" className="ctm-date-nav__trigger">
                                <CalendarIcon className="w-4 h-4 opacity-60" />
                                <span className="ctm-date-nav__text">{formatDateLabel(dateObj)}</span>
                            </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="center">
                            <Calendar
                                mode="single"
                                selected={dateObj}
                                onSelect={(day) => { if (day) { const ds = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; setSelectedDate(ds); setCalendarOpen(false); } }}
                                disabled={{ before: new Date(today + 'T00:00:00') }}
                                defaultMonth={dateObj}
                            />
                        </PopoverContent>
                    </Popover>
                    <Button variant="ghost" size="icon" className="ctm-date-nav__arrow" onClick={nextDate}>
                        <ChevronRight className="w-4" />
                    </Button>
                    {getRelativeDayHint(selectedDate, companyTz) && (
                        <span className="ctm-date-nav__hint">{getRelativeDayHint(selectedDate, companyTz)}</span>
                    )}
                </div>

                <div className="ctm-body">
                    {/* ── Left: Technician Timelines ── */}
                    <div className="ctm-timelines">
                        {/* Tech name bar */}
                        {visibleTechs.length > 0 && (
                            <div className="ctm-tech-bar-container">
                                <div className="ctm-tech-bar-spacer">
                                    {totalPages > 1 && (
                                        <button
                                            className="ctm-tech-bar__arrow"
                                            onClick={() => setTechPage(p => Math.max(0, p - 1))}
                                            disabled={techPage === 0}
                                        >
                                            <ChevronLeft className="w-4" />
                                        </button>
                                    )}
                                </div>
                                <div className="ctm-tech-bar">
                                    {visibleTechs.map(tech => (
                                        <div key={tech.id} className="ctm-tech-bar__item">
                                            <span className="ctm-tech-bar__dot" style={{ background: TECH_COLORS[tech.colorIndex].bg }} />
                                            <span className="ctm-tech-bar__name">{tech.name}</span>
                                        </div>
                                    ))}
                                </div>
                                {totalPages > 1 && (
                                    <div className="ctm-tech-bar-spacer ctm-tech-bar-spacer--right">
                                        <button
                                            className="ctm-tech-bar__arrow"
                                            onClick={() => setTechPage(p => Math.min(totalPages - 1, p + 1))}
                                            disabled={techPage >= totalPages - 1}
                                        >
                                            <ChevronRight className="w-4" />
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {techGroups.length === 0 && !loading && (
                            <div className="ctm-timelines__empty">No technicians found</div>
                        )}

                        {techGroups.length > 0 && (
                            <div className="ctm-timelines__wrapper">
                                {/* Hour labels column + tech columns */}
                                <div className="ctm-timelines__scroll">
                                    <div className="ctm-timelines__grid-area">
                                        {/* Shared hour labels */}
                                        <div className="ctm-hours">
                                            {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => (
                                                <div key={i} className="ctm-hours__label" style={{ top: i * HOUR_HEIGHT }}>
                                                    {fmtTime(dateInTZ(dateObj.getFullYear(), dateObj.getMonth() + 1, dateObj.getDate(), HOUR_START + i, 0, companyTz), companyTz)}
                                                </div>
                                            ))}
                                            {selectedDate === today && (() => {
                                                const nowMin = minutesSinceMidnight(new Date(), companyTz) - HOUR_START * 60;
                                                const clampedPx = Math.max(0, Math.min(nowMin, TOTAL_HOURS * 60)) / 60 * HOUR_HEIGHT;
                                                return clampedPx > 0 ? <div className="tech-timeline__now-line" style={{ top: clampedPx }} /> : null;
                                            })()}
                                        </div>
                                        {/* Tech columns */}
                                        <div className="ctm-timelines__columns">
                                            {visibleTechs.map(tech => (
                                                <TechTimeline
                                                    key={tech.id}
                                                    tech={tech}
                                                    selectedDate={selectedDate}
                                                    durationMin={durationMin}
                                                    selectedSlot={selectedSlot}
                                                    onSelectSlot={setSelectedSlot}
                                                    matchesTerritory={tech.matchesTerritory}
                                                    companyTz={companyTz}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                    </div>

                    {/* ── Right: Map ── */}
                    <JobMap
                        jobs={jobs}
                        techGroups={techGroups}
                        newJobCoords={newJobCoords}
                        newJobAddress={newJobAddress}
                        loading={loading}
                        companyTz={companyTz}
                    />
                </div>

                <DialogFooter className="ctm-footer">
                    {selectedSlot && !techGroups.find(g => g.id === selectedSlot.techId)?.matchesTerritory && (
                        <span className="ctm-footer__territory-warn">⚠ This technician does not serve this territory</span>
                    )}
                    <Button variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button onClick={handleConfirm} disabled={!selectedSlot}>
                        {selectedSlot ? `Confirm ${fmtTime(selectedSlot.start, companyTz)} – ${fmtTime(selectedSlot.end, companyTz)}` : 'Select a timeslot'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
