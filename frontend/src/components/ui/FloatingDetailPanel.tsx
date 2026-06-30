import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { OverlayClose } from './OverlayClose';

interface Props {
    open: boolean;
    onClose: () => void;
    wide?: boolean;
    children: React.ReactNode;
}

export function FloatingDetailPanel({ open, onClose, wide, children }: Props) {
    // NON-MODAL on desktop: no scroll-lock, no focus-trap (so the background list stays
    // scrollable + clickable). Esc-to-close and mobile backdrop-tap-to-close are kept.
    // focusTrap:false → panelProps gives aria-modal: undefined, preserving non-modal a11y.
    const { panelProps, backdropProps } = useOverlayDismiss({
        open,
        onClose,
        esc: true,
        closeOnBackdrop: true,
        scrollLock: false,
        focusTrap: false,
    });

    if (!open) return null;

    return createPortal(
        <>
            {/* Mobile: dark backdrop that closes on tap. Desktop: CSS-hidden — list stays clickable */}
            <div className="blanc-floating-backdrop" onClick={backdropProps.onClick} />
            {/* `peer` so the desktop slideover close button's peer-hover reveal fires */}
            <div
                {...panelProps}
                className={`blanc-floating-panel peer${wide ? ' blanc-floating-panel--wide' : ''}`}
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
                    style={{ background: 'rgba(117,106,89,0.08)', color: 'var(--blanc-ink-1)' }}
                >
                    <X size={20} />
                </button>
                {children}
            </div>
            {/* Desktop hover-reveal × anchored to THIS panel's real width (not the shared
                size table) so the panel keeps its own 420px / --blanc-layer-width sizing */}
            <OverlayClose variant="slideover" anchorRight={wide ? 'var(--blanc-layer-width)' : '420px'} onClose={onClose} />
        </>,
        document.body
    );
}
