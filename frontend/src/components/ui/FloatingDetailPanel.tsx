import { createPortal } from 'react-dom';
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
                {children}
            </div>
            {/* Mobile inside-× (desktop hidden) */}
            <OverlayClose variant="corner" className="md:hidden" onClose={onClose} />
            {/* Desktop hover-reveal × anchored to THIS panel's real width (not the shared
                size table) so the panel keeps its own 420px / --blanc-layer-width sizing */}
            <OverlayClose variant="slideover" anchorRight={wide ? 'var(--blanc-layer-width)' : '420px'} onClose={onClose} />
        </>,
        document.body
    );
}
