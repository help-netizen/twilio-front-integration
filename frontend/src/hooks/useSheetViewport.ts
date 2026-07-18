import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type * as React from 'react';

const DEFAULT_TOP_GAP = 16;
const FOCUS_REVEAL_MARGIN = 8;
const VIEWPORT_SETTLE_MS = 80;

export interface SheetViewportMetrics {
    layoutHeight: number;
    visualHeight: number;
    visualOffsetTop: number;
    topGap?: number;
}

export interface SheetViewportGeometry {
    visualTop: number;
    visualBottom: number;
    visibleHeight: number;
    bottomInset: number;
    usableHeight: number;
}

function finiteNonNegative(value: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Convert VisualViewport measurements (visual coordinates within the layout viewport)
 * into the two values a bottom sheet needs: how far to lift its bottom edge, and how
 * tall it may be while keeping the canonical top gap visible.
 */
export function computeSheetViewportGeometry(metrics: SheetViewportMetrics | null): SheetViewportGeometry | null {
    if (!metrics) return null;

    const layoutHeight = finiteNonNegative(metrics.layoutHeight);
    const visualTop = Math.min(finiteNonNegative(metrics.visualOffsetTop), layoutHeight);
    const reportedVisualHeight = finiteNonNegative(metrics.visualHeight);
    const visibleHeight = Math.min(reportedVisualHeight, Math.max(0, layoutHeight - visualTop));
    const visualBottom = visualTop + visibleHeight;
    const topGap = finiteNonNegative(metrics.topGap ?? DEFAULT_TOP_GAP);

    return {
        visualTop,
        visualBottom,
        visibleHeight,
        bottomInset: Math.max(0, layoutHeight - visualBottom),
        usableHeight: Math.max(0, visibleHeight - topGap),
    };
}

function sameGeometry(a: SheetViewportGeometry | null, b: SheetViewportGeometry | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.visualTop === b.visualTop
        && a.visualBottom === b.visualBottom
        && a.visibleHeight === b.visibleHeight
        && a.bottomInset === b.bottomInset
        && a.usableHeight === b.usableHeight;
}

function isEditableControl(target: EventTarget | null): target is HTMLElement {
    return target instanceof HTMLElement
        && target.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

export interface SheetViewportControlRect {
    top: number;
    bottom: number;
}

export function isSheetControlCovered(
    rect: SheetViewportControlRect,
    geometry: SheetViewportGeometry,
    margin = FOCUS_REVEAL_MARGIN,
): boolean {
    const visibleTop = geometry.visualTop + margin;
    const visibleBottom = geometry.visualBottom - margin;
    return rect.top < visibleTop || rect.bottom > visibleBottom;
}

function revealIfCovered(control: HTMLElement, geometry: SheetViewportGeometry | null): void {
    if (!geometry || !control.isConnected || document.activeElement !== control) return;
    const rect = control.getBoundingClientRect();
    if (isSheetControlCovered(rect, geometry)) {
        control.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
}

export interface UseSheetViewportOptions {
    open: boolean;
    enabled: boolean;
    topGap?: number;
}

export interface UseSheetViewportResult {
    geometry: SheetViewportGeometry | null;
    onFocusCapture: React.FocusEventHandler<HTMLElement>;
}

/**
 * Shared mobile-sheet viewport seam (SHEET-KEYBOARD-001).
 *
 * `dvh` follows the layout/initial viewport under the common `resizes-visual` OSK
 * policy, so a fixed bottom sheet can remain behind the keyboard. VisualViewport
 * exposes the actually visible rectangle. Both BottomSheet and mobile DialogContent
 * consume this hook, keeping their different overlay/focus/dismiss owners intact.
 */
export function useSheetViewport({
    open,
    enabled,
    topGap = DEFAULT_TOP_GAP,
}: UseSheetViewportOptions): UseSheetViewportResult {
    const [geometry, setGeometry] = useState<SheetViewportGeometry | null>(null);
    const geometryRef = useRef<SheetViewportGeometry | null>(null);
    const focusedControlRef = useRef<HTMLElement | null>(null);
    const focusRevealRafRef = useRef<number | null>(null);

    useEffect(() => {
        if (!open || !enabled || typeof window === 'undefined' || !window.visualViewport) {
            geometryRef.current = null;
            setGeometry(previous => (previous === null ? previous : null));
            return;
        }

        const viewport = window.visualViewport;
        let readRaf: number | null = null;
        let settleTimer: ReturnType<typeof setTimeout> | null = null;

        const read = () => {
            const next = computeSheetViewportGeometry({
                layoutHeight: window.innerHeight || document.documentElement.clientHeight,
                visualHeight: viewport.height,
                visualOffsetTop: viewport.offsetTop,
                topGap,
            });
            geometryRef.current = next;
            setGeometry(previous => (sameGeometry(previous, next) ? previous : next));
        };

        const scheduleRead = () => {
            if (readRaf === null) {
                readRaf = requestAnimationFrame(() => {
                    readRaf = null;
                    read();
                });
            }
            // iOS standalone can report a transient offsetTop from the resize callback;
            // take one trailing reading after the keyboard/viewport animation settles.
            if (settleTimer !== null) clearTimeout(settleTimer);
            settleTimer = setTimeout(read, VIEWPORT_SETTLE_MS);
        };

        read();
        settleTimer = setTimeout(read, VIEWPORT_SETTLE_MS);
        viewport.addEventListener('resize', scheduleRead);
        viewport.addEventListener('scroll', scheduleRead);
        window.addEventListener('resize', scheduleRead);
        window.addEventListener('orientationchange', scheduleRead);

        return () => {
            viewport.removeEventListener('resize', scheduleRead);
            viewport.removeEventListener('scroll', scheduleRead);
            window.removeEventListener('resize', scheduleRead);
            window.removeEventListener('orientationchange', scheduleRead);
            if (readRaf !== null) cancelAnimationFrame(readRaf);
            if (settleTimer !== null) clearTimeout(settleTimer);
        };
    }, [enabled, open, topGap]);

    const scheduleFocusedReveal = useCallback((control: HTMLElement) => {
        if (focusRevealRafRef.current !== null) cancelAnimationFrame(focusRevealRafRef.current);
        focusRevealRafRef.current = requestAnimationFrame(() => {
            focusRevealRafRef.current = null;
            revealIfCovered(control, geometryRef.current);
        });
    }, []);

    const onFocusCapture = useCallback<React.FocusEventHandler<HTMLElement>>((event) => {
        if (!open || !enabled || !isEditableControl(event.target)) return;
        focusedControlRef.current = event.target;
        // Covers switching fields while the keyboard is already open. The viewport-resize
        // path below covers the first field that causes the keyboard to appear.
        scheduleFocusedReveal(event.target);
    }, [enabled, open, scheduleFocusedReveal]);

    // Runs after React has committed the new bottom/max-height styles, so nested sheet
    // scrollers can reveal the active field against the final visible rectangle.
    useLayoutEffect(() => {
        if (!open || !enabled || !geometry) return;
        const control = focusedControlRef.current;
        if (control) revealIfCovered(control, geometry);
    }, [enabled, geometry, open]);

    useEffect(() => () => {
        if (focusRevealRafRef.current !== null) cancelAnimationFrame(focusRevealRafRef.current);
    }, []);

    useEffect(() => {
        if (!open || !enabled) focusedControlRef.current = null;
    }, [enabled, open]);

    return {
        geometry: open && enabled ? geometry : null,
        onFocusCapture,
    };
}
