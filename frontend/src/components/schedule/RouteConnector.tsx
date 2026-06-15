/**
 * RouteConnector — SCHED-ROUTE-001 FR-009.
 * A thin label drawn between two consecutive job cards showing the stored
 * driving leg (distance · duration) or a short status when it isn't available.
 * Reads pre-computed data only — never calls Google.
 */
import React from 'react';
import type { RouteSegment } from '../../services/scheduleApi';
import { routeSegmentLabel, routeSegmentTone, type DistanceUnit } from '../../utils/routeFormat';

const TONE_COLOR: Record<string, string> = {
    ok: 'var(--sched-ink-2)',
    pending: 'var(--sched-ink-3)',
    warn: '#a65312',
    none: 'var(--sched-ink-3)',
};

interface RouteConnectorProps {
    segment: RouteSegment | undefined;
    unit?: DistanceUnit;
}

export const RouteConnector: React.FC<RouteConnectorProps> = ({ segment, unit = 'mi' }) => {
    const label = routeSegmentLabel(segment, unit);
    if (!label) return null;
    const tone = routeSegmentTone(segment);
    return (
        <div
            className="flex items-center gap-1.5 px-3 py-0.5 select-none"
            style={{ color: TONE_COLOR[tone] }}
            aria-label={`Drive to next job: ${label}`}
        >
            <span
                aria-hidden
                className="inline-block flex-shrink-0"
                style={{ width: 1, height: 12, background: 'var(--sched-line)', marginLeft: 5 }}
            />
            <span className="text-[10px] font-medium tabular-nums truncate" style={{ letterSpacing: '0.01em' }}>
                ↓ {label}
            </span>
        </div>
    );
};
