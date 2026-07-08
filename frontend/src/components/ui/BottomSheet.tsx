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
 * Mirrors the dialog.tsx panel canon (DialogPanelHeader → DialogBody → DialogPanelFooter).
 * Albusto tokens only.
 *
 * Behavior (Esc + backdrop close, body-scroll-lock, focus capture/restore + Tab trap,
 * drag-to-dismiss from the handle/header — not the scrollable body) is owned by the
 * shared `useOverlayDismiss` hook (OVERLAY-CLOSE-CANON-001); this file keeps only the
 * visuals — the slide-up animation, fixed-height policy, and the translateY/spring
 * mapping of the hook's raw drag offset. iOS safe-area lives here too.
 */

import { Overlay } from './Overlay';
import { OverlayClose } from './OverlayClose';

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
    const headerVisible = showHeader ?? !!title;
    const label = title ?? ariaLabel;

    // Height policy — one knob (tokens) drives standard/full; auto is content-sized.
    const heightStyle: React.CSSProperties =
        size === 'standard'
            ? { height: 'var(--blanc-sheet-h)' }
            : size === 'full'
                ? { height: 'var(--blanc-sheet-h-full)' }
                : { maxHeight };

    // No footer → the body owns the safe-area bottom padding; with a footer the footer does.
    const bodyPaddingBottom = footer ? undefined : 'max(env(safe-area-inset-bottom), 12px)';

    // Portal + backdrop (warm dark scrim, tap-to-close) + behavior (Esc / scroll-lock /
    // focus-trap / drag-to-dismiss) come from the shared Overlay core — the drag/focus/esc
    // logic there was lifted VERBATIM from here, so this is a no-op behaviorally. This file
    // keeps only the sheet's own panel visuals; we map the raw drag offset to translateY.
    return (
        <Overlay open={open} onClose={onClose} variant="bottom-sheet" dragToDismiss={dragToDismiss}>
            {({ panelProps, dragHandlers, dragOffset, isDragging, z, stack }) => {
                // While dragging: 1:1 finger tracking, no transition. On release: spring back.
                // On DESKTOP with a layer above, compose the card-stack fragment after the drag
                // translateY (mobile → `stack` is empty, so this is byte-identical there). While
                // dragging we suppress the transition; otherwise we prefer the card-stack transition
                // (identical spring curve, adds the filter fade) and fall back to the sheet spring.
                const dragTransform = dragOffset > 0 ? `translateY(${dragOffset}px)` : '';
                const transform = [dragTransform, stack.transform].filter(Boolean).join(' ') || undefined;
                const dragTransition = isDragging
                    ? 'none'
                    : stack.transition ?? 'transform 0.25s cubic-bezier(0.32, 0.72, 0, 1)';
                // Sheet panel
                return (
            <div
                {...panelProps}
                aria-label={label}
                style={{
                    position: 'fixed',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    zIndex: z,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    background: 'var(--blanc-surface-strong, #fdf8f0)',
                    borderTop: '1px solid var(--blanc-line, var(--blanc-line))',
                    borderRadius: 'var(--blanc-radius-lg, 22px) var(--blanc-radius-lg, 22px) 0 0',
                    boxShadow: '0 -12px 40px rgba(40, 33, 22, 0.22)',
                    animation: 'blancSlideUp 0.25s ease-out',
                    outline: 'none',
                    // SELECT-IN-DIALOG-TAP-FIX-001 — a sheet opened from inside a Radix modal
                    // Dialog (e.g. the State <Select> in the New Job form) is portaled to
                    // <body> OUTSIDE Radix's layer, so it inherits Radix's `pointer-events:
                    // none` body lock: rows won't tap and the touch falls through to the form
                    // (its scroll moves instead of the list). Re-enabling `auto` here makes the
                    // sheet the real touch target again — rows tap, and touchmove targets our
                    // own scrollable body so the list scrolls. No-op outside a Radix modal.
                    pointerEvents: 'auto',
                    transform,
                    transformOrigin: stack.transformOrigin,
                    filter: stack.filter,
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
                        {!hideCloseButton && <OverlayClose variant="corner" onClose={onClose} />}
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
                        // Keep touch-scroll INSIDE the sheet — without this, dragging a long
                        // list (e.g. the 51-item State select) chains to and scrolls the form
                        // panel behind the sheet instead of the list itself (iOS Safari).
                        overscrollBehavior: 'contain',
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
                            borderTop: '1px solid var(--blanc-line, var(--blanc-line))',
                            background: 'var(--blanc-bg, #F1F1F0)',
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
                );
            }}
        </Overlay>
    );
}
