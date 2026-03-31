/**
 * useScheduleDnD — Shared drag-and-drop state for schedule views.
 * Uses HTML5 Drag and Drop API with snap-to-grid.
 * Leads are never draggable.
 */

import { useState, useCallback, useRef } from 'react';
import type { ScheduleItem } from '../services/scheduleApi';

export interface DragPayload {
    item: ScheduleItem;
    durationMin: number;
}

export interface DropResult {
    /** New start time in minutes since midnight (company TZ) */
    startMin: number;
    /** Day key "yyyy-MM-dd" (for cross-day drops in WeekView) */
    dayKey?: string;
    /** Provider id (for reassign in Timeline views) */
    providerId?: string;
}

interface UseScheduleDnDOptions {
    slotDuration: number; // minutes (for snap-to-grid)
}

export function useScheduleDnD({ slotDuration }: UseScheduleDnDOptions) {
    const [dragItem, setDragItem] = useState<DragPayload | null>(null);
    const [dropPreview, setDropPreview] = useState<{ topPx: number; dayKey?: string; providerId?: string } | null>(null);
    const dragRef = useRef<DragPayload | null>(null);

    const canDrag = (item: ScheduleItem) => item.entity_type !== 'lead';

    const handleDragStart = useCallback((item: ScheduleItem, durationMin: number) => {
        const payload = { item, durationMin };
        dragRef.current = payload;
        setDragItem(payload);
    }, []);

    const handleDragEnd = useCallback(() => {
        dragRef.current = null;
        setDragItem(null);
        setDropPreview(null);
    }, []);

    /** Snap raw minutes to nearest slot boundary */
    const snapToGrid = useCallback((rawMin: number): number => {
        return Math.round(rawMin / slotDuration) * slotDuration;
    }, [slotDuration]);

    return {
        dragItem,
        dropPreview,
        canDrag,
        handleDragStart,
        handleDragEnd,
        setDropPreview,
        snapToGrid,
        dragRef,
    };
}

// ── Drag data helpers (serialized in dataTransfer) ──────────────────────────

const DRAG_TYPE = 'application/x-schedule-item';

export function setDragData(e: React.DragEvent, item: ScheduleItem, durationMin: number) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({
        entityType: item.entity_type,
        entityId: item.entity_id,
        title: item.title,
        durationMin,
    }));
}

export interface DragData {
    entityType: string;
    entityId: number;
    title: string;
    durationMin: number;
}

export function getDragData(e: React.DragEvent): DragData | null {
    try {
        const raw = e.dataTransfer.getData(DRAG_TYPE);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export function hasDragData(e: React.DragEvent): boolean {
    return e.dataTransfer.types.includes(DRAG_TYPE);
}
