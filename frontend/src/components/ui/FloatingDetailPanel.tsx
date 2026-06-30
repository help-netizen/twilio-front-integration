import { createPortal } from 'react-dom';
import { ArrowLeft } from 'lucide-react';
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
                {/* Mobile-only back affordance. Rendered as a CHILD of the full-screen panel
                    (NOT a sibling) so it lives in the panel's own stacking context and paints
                    ABOVE the content → tappable on mobile (the OVERLAY-CLOSE-CANON regression
                    was a sibling × hidden behind the z-index:120 panel). A slim flex-shrink-0
                    top bar pushes the content header (px-5 pt-5) below it → no overlap. */}
                <div className="md:hidden flex-shrink-0 flex items-center px-5 pt-4 pb-1">
                    <button
                        type="button"
                        aria-label="Back"
                        onClick={onClose}
                        className="inline-flex items-center justify-center h-10 w-10 rounded-full transition-colors"
                        style={{ background: 'rgba(117,106,89,0.08)', color: 'var(--blanc-ink-1)' }}
                    >
                        <ArrowLeft size={20} />
                    </button>
                </div>
                {children}
            </div>
            {/* Desktop hover-reveal × anchored to THIS panel's real width (not the shared
                size table) so the panel keeps its own 420px / --blanc-layer-width sizing */}
            <OverlayClose variant="slideover" anchorRight={wide ? 'var(--blanc-layer-width)' : '420px'} onClose={onClose} />
        </>,
        document.body
    );
}
