import { X } from 'lucide-react';
import { Overlay } from './Overlay';
import { OverlayClose } from './OverlayClose';

interface Props {
    open: boolean;
    onClose: () => void;
    wide?: boolean;
    children: React.ReactNode;
}

export function FloatingDetailPanel({ open, onClose, wide, children }: Props) {
    // NON-MODAL on desktop (variant="right-drawer" modal={false}): the core wires no
    // scroll-lock and no focus-trap (so the background list stays scrollable + clickable),
    // and renders NO default backdrop — this panel's scrim is the CSS-driven
    // `.blanc-floating-backdrop` below (hidden on desktop, dark tap-to-close on mobile).
    // Esc-to-close and mobile backdrop-tap-to-close are kept via the core; the panel's
    // z-index stays CSS-owned (.blanc-floating-panel 80 desktop / 120 mobile), so we
    // intentionally do NOT apply the render-prop `z` here.
    return (
        <Overlay open={open} onClose={onClose} variant="right-drawer" modal={false} backdrop={false}>
            {({ panelProps, backdropProps, stack }) => (
        <>
            {/* Mobile: dark backdrop that closes on tap. Desktop: CSS-hidden — list stays clickable */}
            <div className="blanc-floating-backdrop" onClick={backdropProps.onClick} />
            {/* `peer` so the desktop slideover close button's peer-hover reveal fires */}
            <div
                {...panelProps}
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
            <OverlayClose variant="slideover" anchorRight={wide ? 'var(--blanc-layer-width)' : '420px'} onClose={onClose} />
        </>
            )}
        </Overlay>
    );
}
