import { X } from 'lucide-react';
import { Overlay } from './Overlay';
import { OverlayClose } from './OverlayClose';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useSheetViewport } from '../../hooks/useSheetViewport';

interface Props {
    open: boolean;
    onClose: () => void;
    wide?: boolean;
    children: React.ReactNode;
}

export function FloatingDetailPanel({ open, onClose, wide, children }: Props) {
    // NON-MODAL on desktop (variant="right-drawer" modal={false}): the core wires no
    // focus-trap and renders NO default backdrop — the desktop panel is a 420px right
    // drawer, so the background list stays scrollable + clickable, and this panel's scrim is
    // the CSS-driven `.blanc-floating-backdrop` below (hidden on desktop, dark tap-to-close
    // on mobile). Esc-to-close and mobile backdrop-tap-to-close are kept via the core; the
    // panel's z-index stays CSS-owned (.blanc-floating-panel 80 desktop / 120 mobile), so we
    // intentionally do NOT apply the render-prop `z` here.
    //
    // MOBILE body-scroll-lock (scrollLock={isMobile}) — OVERLAY-SCROLL-CHAIN fix: on mobile
    // the panel is a full-screen OPAQUE cover (CSS `@media (max-width:768px)` → inset:0 /
    // 100dvh / z-120), so the page behind it is fully hidden and must NOT scroll. Without the
    // lock, a touch that overscrolls the panel content chains through to the (non-modal)
    // <body> and drags the background list underneath — the reported "receipt scroll moves
    // the page behind it" bug, shared by every FloatingDetailPanel consumer (most inner
    // scrollers lack `overscroll-contain`). Locking here fixes them all at once. Desktop
    // stays unlocked — the drawer is only 420px and the list beside it is meant to scroll.
    const isMobile = useIsMobile();
    // MOBILE KEYBOARD (owner, 2026-08-16 — "нажать на почту, форма уезжает").
    // The mobile panel is `position: fixed; inset: 0; height: 100dvh`. On iOS the
    // keyboard shrinks the VISUAL viewport but not the layout one, so the browser
    // scrolls the layout viewport to reveal the focused input — and drags this
    // fixed, full-height panel off the visible area with it. The email field on
    // the receipt (TransactionReview) ended up behind the keyboard with the job
    // card showing through above it.
    //
    // BottomSheet and Dialog already follow visualViewport through the shared
    // hook; this panel was simply never wired to it. Same canon, same numbers.
    const sheetViewport = useSheetViewport({ open, enabled: isMobile });
    return (
        <Overlay open={open} onClose={onClose} variant="right-drawer" modal={false} backdrop={false} scrollLock={isMobile}>
            {({ panelProps, backdropProps, stack }) => (
        <>
            {/* Mobile: dark backdrop that closes on tap. Desktop: CSS-hidden — list stays clickable */}
            <div className="blanc-floating-backdrop" onClick={backdropProps.onClick} />
            {/* `peer` so the desktop slideover close button's peer-hover reveal fires */}
            <div
                {...panelProps}
                onFocusCapture={sheetViewport.onFocusCapture}
                className={`blanc-floating-panel peer${wide ? ' blanc-floating-panel--wide' : ''}`}
                // Desktop card-stack (Phase 3): when a modal/dialog opens OVER this non-modal
                // view card, it slides left + dims + scales so it peeks behind the top layer.
                // `.blanc-floating-panel` has no base transform on desktop, so compose directly.
                // `stack` is EMPTY on mobile (z-cover) and when it's the top → unchanged there.
                style={{
                    transform: stack.transform || undefined,
                    transformOrigin: stack.transformOrigin,
                    filter: stack.filter,
                    transition: stack.transition,
                    // Follow the visible viewport while the keyboard is up: the panel
                    // stops at the keyboard instead of being pushed underneath it.
                    ...(sheetViewport.geometry
                        ? {
                            top: sheetViewport.geometry.visualTop,
                            bottom: sheetViewport.geometry.bottomInset,
                            height: 'auto',
                            maxHeight: sheetViewport.geometry.usableHeight,
                        }
                        : {}),
                }}
            >
                {/* Mobile-only close ×. Rendered as a CHILD of the full-screen panel
                    (NOT a sibling) so it lives in the panel's own stacking context and paints
                    ABOVE the content → tappable on mobile (the OVERLAY-CLOSE-CANON regression
                    was a sibling × hidden behind the z-index:120 panel). Absolutely positioned
                    at the top-right corner, aligned with the header's top row, so it does NOT
                    push the content down. Content headers add a max-md: right-gutter to keep
                    their own top-right clusters clear of this ×. */}
                <button
                    type="button"
                    aria-label="Close"
                    onClick={onClose}
                    className="md:hidden absolute top-3 right-3 z-10 inline-flex items-center justify-center h-10 w-10 rounded-xl transition-colors"
                    style={{ background: 'rgba(25,25,25,0.06)', color: 'var(--blanc-ink-1)' }}
                >
                    <X size={20} />
                </button>
                {children}
            </div>
            {/* Desktop hover-reveal × anchored to THIS panel's real width (not the shared
                size table) so the panel keeps its own 420px / --blanc-layer-width sizing */}
            <OverlayClose variant="slideover" anchorRight={wide ? 'var(--blanc-layer-width-wide)' : '420px'} onClose={onClose} />
        </>
            )}
        </Overlay>
    );
}
