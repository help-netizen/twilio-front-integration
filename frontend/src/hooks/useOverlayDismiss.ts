/**
 * useOverlayDismiss — THE single source for overlay dismissal behavior
 * (OVERLAY-CLOSE-CANON-001).
 *
 * Consolidates the Esc listener, body-scroll-lock, focus capture/trap/restore, and
 * pointer drag-to-dismiss that were each re-implemented per overlay (BottomSheet,
 * dialog.tsx, FloatingDetailPanel, the viewer + AI modals). The Esc / focus / drag
 * logic is copied VERBATIM from `components/ui/BottomSheet.tsx` — migrating a surface
 * onto this hook is a no-op behaviorally.
 *
 * Each capability is independently togglable so per-surface nuance survives (e.g. a
 * non-modal slide-over can keep `focusTrap=false`; a centered dialog leaves
 * `dragToDismiss=false`). The hook owns only behavior + a11y wiring; the CONSUMER
 * owns all visuals — for drag it returns the raw `dragOffset`/`isDragging` and the
 * consumer maps that to `translateY(...)` and keeps its own spring transition, so the
 * sheet's visual feel is unchanged.
 *
 * scrollLock is REFERENCE-COUNTED at module scope (below) so nested overlays don't
 * clobber each other's restore of `body.style.overflow`.
 */

import type * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// ── Module-scoped reference-counted body-scroll lock ─────────────────────────
// Naive per-component save/restore breaks with stacked overlays: the inner one
// saves `overflow:hidden` (already set by the outer), then on close restores
// `hidden` again — the page stays locked. Counting lockers and storing the TRUE
// original once (on the 0→1 transition) and restoring it once (on the 1→0) fixes it.
let scrollLockCount = 0
let scrollLockPrevOverflow = ''

function acquireScrollLock() {
    if (typeof document === 'undefined') return
    if (scrollLockCount === 0) {
        scrollLockPrevOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
    }
    scrollLockCount += 1
}

function releaseScrollLock() {
    if (typeof document === 'undefined') return
    if (scrollLockCount === 0) return
    scrollLockCount -= 1
    if (scrollLockCount === 0) {
        document.body.style.overflow = scrollLockPrevOverflow
        scrollLockPrevOverflow = ''
    }
}

export interface UseOverlayDismissOptions {
    open: boolean
    onClose: () => void
    /** Close on Escape. Default true. */
    esc?: boolean
    /** Wire `backdropProps.onClick` to close. Default true. */
    closeOnBackdrop?: boolean
    /** Lock body scroll while open (reference-counted). Default true. */
    scrollLock?: boolean
    /** Capture/move/restore focus + Tab cycling trap inside the panel. Default true. */
    focusTrap?: boolean
    /** Restore focus to the previously-focused element on close. Default = focusTrap. */
    restoreFocus?: boolean
    /** Allow pointer drag (down) to dismiss. Default false. */
    dragToDismiss?: boolean
    /** Drag past this many px (downward) on release → dismiss. Default 80. */
    dragThreshold?: number
    /** On Escape, call stopPropagation() before onClose (don't bubble to parent overlays). Default true. */
    stopEscPropagation?: boolean
}

/** Pointer handlers wired onto the drag region when `dragToDismiss` is on. */
export interface OverlayDragHandlers {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void
    style: { touchAction: 'none' }
}

export interface UseOverlayDismissReturn {
    // RefObject<… | null> is what React 19's `useRef<T>(null)` yields; spreading
    // panelProps onto a <div> still satisfies the ref prop.
    panelProps: {
        ref: React.RefObject<HTMLDivElement | null>
        role: 'dialog'
        'aria-modal': true | undefined
        tabIndex: -1
        onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
    }
    backdropProps: { onClick: ((e: React.MouseEvent) => void) | undefined }
    /** Populated handlers when `dragToDismiss`; otherwise an empty object (spread-safe). */
    dragHandlers: OverlayDragHandlers | Record<never, never>
    dragOffset: number
    isDragging: boolean
    panelRef: React.RefObject<HTMLDivElement | null>
}

export function useOverlayDismiss(options: UseOverlayDismissOptions): UseOverlayDismissReturn {
    const {
        open,
        onClose,
        esc = true,
        closeOnBackdrop = true,
        scrollLock = true,
        focusTrap = true,
        restoreFocus = focusTrap,
        dragToDismiss = false,
        dragThreshold = 80,
        stopEscPropagation = true,
    } = options

    const panelRef = useRef<HTMLDivElement>(null)
    // Element focused before the overlay opened — restored on close.
    const restoreFocusRef = useRef<HTMLElement | null>(null)
    // Live drag offset (px). 0 when idle / not dragging.
    const [dragOffset, setDragOffset] = useState(0)
    // While dragging we suppress the spring transition so the panel tracks the finger 1:1.
    const [isDragging, setIsDragging] = useState(false)
    const dragStartY = useRef<number | null>(null)

    // ── Esc to close ──────────────────────────────────────────────────────────
    // (Copied from BottomSheet; the stopPropagation() is now opt-out via stopEscPropagation.)
    useEffect(() => {
        if (typeof document === 'undefined') return
        if (!open || !esc) return
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (stopEscPropagation) e.stopPropagation()
                onClose()
            }
        }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [open, esc, stopEscPropagation, onClose])

    // ── Lock body scroll while open (reference-counted at module scope) ────────
    useEffect(() => {
        if (typeof document === 'undefined') return
        if (!open || !scrollLock) return
        acquireScrollLock()
        return () => releaseScrollLock()
    }, [open, scrollLock])

    // ── Focus capture → move to panel; restore on close ───────────────────────
    // (Copied from BottomSheet; gated by focusTrap, restore gated by restoreFocus.)
    useEffect(() => {
        if (typeof document === 'undefined') return
        if (!open || !focusTrap) return
        restoreFocusRef.current = (document.activeElement as HTMLElement) ?? null
        // Focus the panel itself (tabIndex=-1) so the Tab trap has an anchor.
        const id = requestAnimationFrame(() => panelRef.current?.focus())
        return () => {
            cancelAnimationFrame(id)
            const el = restoreFocusRef.current
            restoreFocusRef.current = null
            // Restore focus to whatever was focused before opening (if still in the DOM).
            if (restoreFocus && el && typeof el.focus === 'function' && document.contains(el)) {
                el.focus()
            }
        }
    }, [open, focusTrap, restoreFocus])

    // ── Minimal Tab trap: keep focus cycling inside the panel ─────────────────
    // (Copied from BottomSheet. No-op when focusTrap is off.)
    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (!focusTrap) return
            if (e.key !== 'Tab') return
            const panel = panelRef.current
            if (!panel) return
            const focusable = Array.from(
                panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
            ).filter((el) => el.offsetParent !== null || el === document.activeElement)
            if (focusable.length === 0) {
                // Nothing focusable — keep focus on the panel.
                e.preventDefault()
                panel.focus()
                return
            }
            const first = focusable[0]
            const last = focusable[focusable.length - 1]
            const active = document.activeElement as HTMLElement | null
            if (e.shiftKey) {
                if (active === first || active === panel) {
                    e.preventDefault()
                    last.focus()
                }
            } else if (active === last) {
                e.preventDefault()
                first.focus()
            }
        },
        [focusTrap],
    )

    // ── Drag-to-dismiss (handle / header region only) ─────────────────────────
    // (Pointer logic copied VERBATIM from BottomSheet; threshold is now a param.)
    const onDragPointerDown = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (!dragToDismiss) return
            // Don't hijack interactions with the close button (or any control) in the header.
            if ((e.target as HTMLElement).closest('button')) return
            dragStartY.current = e.clientY
            setIsDragging(true)
            e.currentTarget.setPointerCapture(e.pointerId)
        },
        [dragToDismiss],
    )

    const onDragPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (dragStartY.current === null) return
        const delta = e.clientY - dragStartY.current
        // Only track downward drags; ignore upward pull.
        setDragOffset(Math.max(0, delta))
    }, [])

    const endDrag = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (dragStartY.current === null) return
            const delta = e.clientY - dragStartY.current
            dragStartY.current = null
            setIsDragging(false)
            if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId)
            }
            if (delta > dragThreshold) {
                onClose()
            } else {
                // Spring back to rest.
                setDragOffset(0)
            }
        },
        [dragThreshold, onClose],
    )

    // Reset transient drag state whenever the overlay is (re)opened.
    useEffect(() => {
        if (open) {
            setDragOffset(0)
            setIsDragging(false)
            dragStartY.current = null
        }
    }, [open])

    const dragHandlers = dragToDismiss
        ? {
              onPointerDown: onDragPointerDown,
              onPointerMove: onDragPointerMove,
              onPointerUp: endDrag,
              onPointerCancel: endDrag,
              style: { touchAction: 'none' as const },
          }
        : {}

    return {
        panelProps: {
            ref: panelRef,
            role: 'dialog',
            'aria-modal': focusTrap ? true : undefined,
            tabIndex: -1,
            onKeyDown,
        },
        backdropProps: {
            onClick: closeOnBackdrop ? () => onClose() : undefined,
        },
        dragHandlers,
        dragOffset,
        isDragging,
        panelRef,
    }
}
