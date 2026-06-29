/**
 * BottomSheet — THE canonical mobile bottom-sheet for the app.
 *
 * A single controlled component (open/onClose). Portals to <body>, dims the page
 * behind a dark backdrop (tap to close), and slides a full-width panel up from the
 * bottom with rounded top corners.
 *
 * Height policy — the guarantee that fixes "sheets are different heights":
 *   • size="standard" (default) → panel is a FIXED height (--blanc-sheet-h), so two
 *     different standard sheets are pixel-identical. The body scrolls internally.
 *   • size="full"               → FIXED, taller (--blanc-sheet-h-full).
 *   • size="auto"               → height by content, capped at `maxHeight` (85dvh).
 *
 * Layout = flex column: grab handle (shrink-0) → header (shrink-0) → body
 * (flex-1, min-height:0, overflow-y:auto) → footer (shrink-0). `min-height:0` on the
 * body is REQUIRED or the internal scroll never engages in a fixed-height flex panel.
 *
 * Mirrors the dialog.tsx panel canon (DialogPanelHeader → DialogBody → DialogPanelFooter)
 * but stays a self-contained component — no import of dialog.tsx. Albusto tokens only.
 *
 * Behavior: Esc + backdrop close, body-scroll-lock, focus capture/restore + Tab trap,
 * drag-to-dismiss from the handle/header (not the scrollable body), iOS safe-area.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export type BottomSheetSize = 'standard' | 'full' | 'auto';

export interface BottomSheetProps {
    open: boolean;
    onClose: () => void;
    /** 'standard' (fixed --blanc-sheet-h) | 'full' (fixed, taller) | 'auto' (content height). Default 'standard'. */
    size?: BottomSheetSize;
    /** Header title. Optional — when omitted, pass `showHeader={false}` or render your own. */
    title?: string;
    /** Render the header row. Default: !!title. */
    showHeader?: boolean;
    /** Hide the close X in the header. Default false. */
    hideCloseButton?: boolean;
    /** Sticky action bar pinned to the bottom (carries the safe-area inset when present). */
    footer?: React.ReactNode;
    /** Show the small rounded grab handle. Default true. */
    showGrabHandle?: boolean;
    /** Allow dragging the handle/header down to dismiss. Default true. */
    dragToDismiss?: boolean;
    /** Cap for size="auto" only. Default '85dvh'. */
    maxHeight?: string;
    /** Extra classes for the scrollable body. */
    bodyClassName?: string;
    /** Accessible label when there is no visible title. */
    ariaLabel?: string;
    children: React.ReactNode;
}

// Drag past this many px (downward) on release → dismiss; otherwise spring back.
const DISMISS_THRESHOLD_PX = 80;

const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function BottomSheet({
    open,
    onClose,
    size = 'standard',
    title,
    showHeader,
    hideCloseButton = false,
    footer,
    showGrabHandle = true,
    dragToDismiss = true,
    maxHeight = '85dvh',
    bodyClassName,
    ariaLabel,
    children,
}: BottomSheetProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    // Element focused before the sheet opened — restored on close.
    const restoreFocusRef = useRef<HTMLElement | null>(null);
    // Live drag offset (px). 0 when idle / not dragging.
    const [dragY, setDragY] = useState(0);
    // While dragging we suppress the spring transition so the panel tracks the finger 1:1.
    const [dragging, setDragging] = useState(false);
    const dragStartY = useRef<number | null>(null);

    const headerVisible = showHeader ?? !!title;
    const label = title ?? ariaLabel;

    // ── Esc to close ──────────────────────────────────────────────────────────
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
            }
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [open, onClose]);

    // ── Lock body scroll while open ───────────────────────────────────────────
    useEffect(() => {
        if (!open) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = prev;
        };
    }, [open]);

    // ── Focus capture → move to panel; restore on close ───────────────────────
    useEffect(() => {
        if (!open) return;
        restoreFocusRef.current = (document.activeElement as HTMLElement) ?? null;
        // Focus the panel itself (tabIndex=-1) so the Tab trap has an anchor.
        const id = requestAnimationFrame(() => panelRef.current?.focus());
        return () => {
            cancelAnimationFrame(id);
            const el = restoreFocusRef.current;
            restoreFocusRef.current = null;
            // Restore focus to whatever was focused before opening (if still in the DOM).
            if (el && typeof el.focus === 'function' && document.contains(el)) {
                el.focus();
            }
        };
    }, [open]);

    // ── Minimal Tab trap: keep focus cycling inside the panel ─────────────────
    const onKeyDownTrap = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'Tab') return;
        const panel = panelRef.current;
        if (!panel) return;
        const focusable = Array.from(
            panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (focusable.length === 0) {
            // Nothing focusable — keep focus on the panel.
            e.preventDefault();
            panel.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
            if (active === first || active === panel) {
                e.preventDefault();
                last.focus();
            }
        } else if (active === last) {
            e.preventDefault();
            first.focus();
        }
    }, []);

    // ── Drag-to-dismiss (handle / header region only) ─────────────────────────
    const onDragPointerDown = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (!dragToDismiss) return;
            // Don't hijack interactions with the close button (or any control) in the header.
            if ((e.target as HTMLElement).closest('button')) return;
            dragStartY.current = e.clientY;
            setDragging(true);
            e.currentTarget.setPointerCapture(e.pointerId);
        },
        [dragToDismiss],
    );

    const onDragPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (dragStartY.current === null) return;
        const delta = e.clientY - dragStartY.current;
        // Only track downward drags; ignore upward pull.
        setDragY(Math.max(0, delta));
    }, []);

    const endDrag = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (dragStartY.current === null) return;
            const delta = e.clientY - dragStartY.current;
            dragStartY.current = null;
            setDragging(false);
            if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
            }
            if (delta > DISMISS_THRESHOLD_PX) {
                onClose();
            } else {
                // Spring back to rest.
                setDragY(0);
            }
        },
        [onClose],
    );

    // Reset transient drag state whenever the sheet is (re)opened.
    useEffect(() => {
        if (open) {
            setDragY(0);
            setDragging(false);
            dragStartY.current = null;
        }
    }, [open]);

    if (typeof document === 'undefined') return null; // SSR-safe.
    if (!open) return null;

    // Height policy — one knob (tokens) drives standard/full; auto is content-sized.
    const heightStyle: React.CSSProperties =
        size === 'standard'
            ? { height: 'var(--blanc-sheet-h)' }
            : size === 'full'
                ? { height: 'var(--blanc-sheet-h-full)' }
                : { maxHeight };

    // While dragging: 1:1 finger tracking, no transition. On release: spring back.
    const transform = dragY > 0 ? `translateY(${dragY}px)` : undefined;
    const dragTransition = dragging ? 'none' : 'transform 0.25s cubic-bezier(0.32, 0.72, 0, 1)';

    // No footer → the body owns the safe-area bottom padding; with a footer the footer does.
    const bodyPaddingBottom = footer ? undefined : 'max(env(safe-area-inset-bottom), 12px)';

    const dragHandlers = dragToDismiss
        ? {
            onPointerDown: onDragPointerDown,
            onPointerMove: onDragPointerMove,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
            style: { touchAction: 'none' as const },
        }
        : {};

    return createPortal(
        <>
            {/* Dark backdrop — tap to close */}
            <div
                onClick={onClose}
                style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(40, 33, 22, 0.42)',
                    backdropFilter: 'blur(2px)',
                    WebkitBackdropFilter: 'blur(2px)',
                    zIndex: 190,
                    animation: 'blancFadeIn 0.15s ease-out',
                }}
            />

            {/* Sheet panel */}
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label={label}
                tabIndex={-1}
                onKeyDown={onKeyDownTrap}
                style={{
                    position: 'fixed',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    zIndex: 200,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    background: 'var(--blanc-surface-strong, #fdf8f0)',
                    borderTop: '1px solid var(--blanc-line, rgba(117, 106, 89, 0.18))',
                    borderRadius: 'var(--blanc-radius-lg, 22px) var(--blanc-radius-lg, 22px) 0 0',
                    boxShadow: '0 -12px 40px rgba(40, 33, 22, 0.22)',
                    animation: 'blancSlideUp 0.25s ease-out',
                    outline: 'none',
                    transform,
                    transition: dragTransition,
                    ...heightStyle,
                }}
            >
                {/* Grab handle (drag region) */}
                {showGrabHandle && (
                    <div
                        {...dragHandlers}
                        style={{
                            flexShrink: 0,
                            display: 'flex',
                            justifyContent: 'center',
                            paddingTop: 10,
                            paddingBottom: 4,
                            cursor: dragToDismiss ? 'grab' : undefined,
                            ...(dragHandlers as { style?: React.CSSProperties }).style,
                        }}
                    >
                        <div
                            style={{
                                width: 40,
                                height: 4,
                                borderRadius: 999,
                                background: 'var(--blanc-line-strong, rgba(97, 86, 71, 0.28))',
                            }}
                        />
                    </div>
                )}

                {/* Header (also a drag region when there is no grab handle) */}
                {headerVisible && (
                    <div
                        {...(showGrabHandle ? {} : dragHandlers)}
                        className="flex items-center justify-between gap-3 px-5 pb-3"
                        style={{
                            flexShrink: 0,
                            paddingTop: showGrabHandle ? 4 : 12,
                            ...(showGrabHandle ? {} : (dragHandlers as { style?: React.CSSProperties }).style),
                        }}
                    >
                        {title ? (
                            <h2
                                className="font-bold"
                                style={{
                                    fontFamily: 'var(--blanc-font-heading, "Manrope", sans-serif)',
                                    fontSize: '17px',
                                    letterSpacing: '-0.02em',
                                    color: 'var(--blanc-ink-1)',
                                    margin: 0,
                                }}
                            >
                                {title}
                            </h2>
                        ) : (
                            <span />
                        )}
                        {!hideCloseButton && (
                            <button
                                type="button"
                                onClick={onClose}
                                aria-label="Close"
                                className="p-2 rounded-xl transition-opacity hover:opacity-70"
                                style={{ background: 'rgba(117, 106, 89, 0.08)', color: 'var(--blanc-ink-2)' }}
                            >
                                <X className="size-4" />
                            </button>
                        )}
                    </div>
                )}

                {/* Scrollable body — min-height:0 is REQUIRED for internal scroll in a fixed-height flex panel */}
                <div
                    className={bodyClassName}
                    style={{
                        flex: '1 1 auto',
                        minHeight: 0,
                        overflowY: 'auto',
                        WebkitOverflowScrolling: 'touch',
                        paddingLeft: 20,
                        paddingRight: 20,
                        paddingTop: headerVisible ? 0 : 4,
                        paddingBottom: bodyPaddingBottom ?? 20,
                    }}
                >
                    {children}
                </div>

                {/* Sticky footer action bar */}
                {footer && (
                    <div
                        style={{
                            flexShrink: 0,
                            borderTop: '1px solid var(--blanc-line, rgba(117, 106, 89, 0.18))',
                            background: 'var(--blanc-bg, #efe9df)',
                            boxShadow: '0 -12px 28px -20px rgba(63, 55, 42, 0.45)',
                            paddingLeft: 20,
                            paddingRight: 20,
                            paddingTop: 12,
                            paddingBottom: 'max(env(safe-area-inset-bottom), 12px)',
                        }}
                    >
                        {footer}
                    </div>
                )}
            </div>
        </>,
        document.body,
    );
}
