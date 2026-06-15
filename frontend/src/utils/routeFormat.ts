/**
 * SCHED-ROUTE-001 — pure formatting helpers for the schedule UI.
 * No Google calls; just turns stored values into display strings.
 */
import type { GeocodingStatus, RouteSegment } from '../services/scheduleApi';

export type DistanceUnit = 'mi' | 'km';

const METERS_PER_MILE = 1609.344;

/** Stored distance_meters → localized short label, e.g. "3.2 mi" / "5.1 km". */
export function formatDistance(meters: number | null | undefined, unit: DistanceUnit = 'mi'): string {
    if (meters == null || !isFinite(meters)) return '';
    const value = unit === 'mi' ? meters / METERS_PER_MILE : meters / 1000;
    const digits = value >= 10 ? 0 : 1;
    return `${value.toFixed(digits)} ${unit}`;
}

/** Stored duration_minutes → "12 min" / "1 h 5 min". */
export function formatDuration(minutes: number | null | undefined): string {
    if (minutes == null || !isFinite(minutes)) return '';
    const m = Math.round(minutes);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h} h ${rem} min` : `${h} h`;
}

/**
 * Single-line route-leg label for the connector between two consecutive jobs.
 * Success → "3.2 mi · 12 min"; everything else → a short human status so the
 * dispatcher knows why a distance is absent (never a silent blank for a known
 * problem).
 */
export function routeSegmentLabel(seg: RouteSegment | undefined, unit: DistanceUnit = 'mi'): string {
    if (!seg) return '';
    switch (seg.status) {
        case 'success': {
            const d = formatDistance(seg.distance_meters, unit);
            const t = formatDuration(seg.duration_minutes);
            return [d, t].filter(Boolean).join(' · ');
        }
        case 'pending':               return 'Calculating route…';
        case 'failed':                return 'Route unavailable';
        case 'missing_address':       return 'No address';
        case 'address_needs_review':  return 'Check address';
        default:                      return '';
    }
}

/** Tone for the leg label so the UI can de-emphasize / warn consistently. */
export function routeSegmentTone(seg: RouteSegment | undefined): 'ok' | 'pending' | 'warn' | 'none' {
    if (!seg) return 'none';
    if (seg.status === 'success') return 'ok';
    if (seg.status === 'pending') return 'pending';
    if (seg.status === 'stale') return 'none';
    return 'warn';
}

/**
 * Build a Google Maps search link from coords (preferred — pins the exact spot)
 * or a free-text address. Mirrors the server-side generator; null if neither is
 * usable. No Google call.
 */
export function googleMapsUrl(
    { lat, lng, address }: { lat?: number | null; lng?: number | null; address?: string | null } = {},
): string | null {
    if (lat != null && lng != null) {
        return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    }
    if (address && address.trim()) {
        return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
    }
    return null;
}

/** Short geocoding-state label for a job card; null when nothing to show. */
export function geocodingLabel(status: GeocodingStatus | null | undefined): string | null {
    switch (status) {
        case 'pending':       return 'Locating…';
        case 'needs_review':  return 'Approx. location';
        case 'failed':        return 'No location';
        default:              return null;   // not_geocoded / success / null → no badge
    }
}
