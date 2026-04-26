/**
 * NewJobPlaceholder — inline dashed-border card rendered absolutely inside
 * a schedule column/cell when the user clicks an empty slot. Replaces the
 * legacy floating SlotContextMenu so the new-job preview appears exactly
 * where the user clicked, sized to the chosen arrival window.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Briefcase } from 'lucide-react';
import { formatTimeInTZ } from '../../utils/companyTime';

export interface NewJobPlaceholderProps {
    /** Top offset within the column in px (relative to the absolutely-positioned parent). */
    topPx: number;
    /** Card height in px (already accounts for arrival window). */
    heightPx: number;
    /** Start of the window — ISO timestamp. */
    startAt: string;
    /** End of the window — ISO timestamp. */
    endAt: string;
    /** Optional provider context shown next to the time. */
    providerName?: string;
    /** Company timezone — required for HH:MM rendering. */
    timezone: string;
    /** Optional horizontal positioning overrides (only used in absolute/positioned mode). */
    leftCss?: string;
    rightCss?: string;
    /** Render with relative positioning instead of absolute — for cell/stack layouts (TimelineWeekView). */
    inline?: boolean;
    /** Called when the user clicks Create Job. The parent should open the
     *  full job-creation form seeded with startAt/endAt/providerName. */
    onCreate: () => void;
    /** Called when the user dismisses (Esc / outside click handled by parent). */
    onClose: () => void;
    /** Optional: enable vertical drag — receives the new top in px on each mousemove. */
    onDragMove?: (newTopPx: number) => void;
    /** Optional: called once when the drag starts (parent may capture state). */
    onDragStart?: () => void;
    /** Optional: called once when the drag ends. */
    onDragEnd?: () => void;
}

export const NewJobPlaceholder = React.forwardRef<HTMLDivElement, NewJobPlaceholderProps>(
    function NewJobPlaceholder(
        { topPx, heightPx, startAt, endAt, providerName, timezone, leftCss, rightCss, inline,
          onCreate, onClose, onDragMove, onDragStart, onDragEnd },
        ref,
    ) {
        const [dragging, setDragging] = useState(false);
        const dragStartY = useRef(0);
        const dragStartTopPx = useRef(0);

        // Vertical drag — pointer events to keep button interactions snappy.
        useEffect(() => {
            if (!dragging || !onDragMove) return;
            const onMove = (e: MouseEvent) => {
                const delta = e.clientY - dragStartY.current;
                onDragMove(dragStartTopPx.current + delta);
            };
            const onUp = () => {
                setDragging(false);
                onDragEnd?.();
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            return () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
        }, [dragging, onDragMove, onDragEnd]);

        // Esc closes the placeholder
        useEffect(() => {
            const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
            document.addEventListener('keydown', onKey);
            return () => document.removeEventListener('keydown', onKey);
        }, [onClose]);

        const beginDrag = (e: React.MouseEvent) => {
            if (!onDragMove) return;
            // Don't hijack clicks on the action button
            if ((e.target as HTMLElement).closest('button')) return;
            e.preventDefault();
            dragStartY.current = e.clientY;
            dragStartTopPx.current = topPx;
            setDragging(true);
            onDragStart?.();
        };

        const timeLabel = `${formatTimeInTZ(new Date(startAt), timezone)} – ${formatTimeInTZ(new Date(endAt), timezone)}`;

        const positioningStyle: React.CSSProperties = inline
            ? {
                position: 'relative',
                width: '100%',
                minHeight: 110,
                marginTop: 4,
            }
            : {
                position: 'absolute',
                top: topPx + 2,
                height: Math.max(heightPx - 4, 96),
                left: leftCss ?? 'calc(0% + 2px)',
                right: rightCss ?? '2px',
            };

        return (
            <div
                ref={ref}
                data-slot-placeholder
                className={`z-20 flex flex-col gap-2 p-2.5 ${onDragMove ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : ''}`}
                style={{
                    ...positioningStyle,
                    border: '2px dashed var(--sched-job)',
                    background: 'rgba(47, 99, 216, 0.08)',
                    borderRadius: '14px',
                    userSelect: dragging ? 'none' : undefined,
                }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={beginDrag}
                title={onDragMove ? 'Drag to reschedule' : undefined}
            >
                <div className="flex items-center justify-between gap-2 min-w-0">
                    <span
                        className="text-[10px] font-bold uppercase shrink-0"
                        style={{ color: 'var(--sched-job)', letterSpacing: '0.12em' }}
                    >
                        New
                    </span>
                    <span className="text-[10px] truncate" style={{ color: 'var(--sched-ink-3)' }}>
                        {timeLabel}{providerName ? ` · ${providerName}` : ''}
                    </span>
                </div>
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onCreate(); }}
                    className="mt-auto inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-bold text-white shadow transition-transform active:scale-[0.98] hover:brightness-110"
                    style={{
                        background: 'linear-gradient(180deg, var(--sched-job), #1e4fbb)',
                        boxShadow: '0 4px 10px -2px rgba(47,99,216,0.45)',
                    }}
                >
                    <Briefcase className="size-3.5" />
                    Create Job
                </button>
            </div>
        );
    },
);

/** Default arrival window for a new job placeholder (in minutes). */
export const NEW_JOB_DEFAULT_DURATION_MIN = 120;
