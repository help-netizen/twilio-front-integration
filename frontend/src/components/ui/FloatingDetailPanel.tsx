import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface Props {
    open: boolean;
    onClose: () => void;
    wide?: boolean;
    children: React.ReactNode;
}

export function FloatingDetailPanel({ open, onClose, wide, children }: Props) {
    const panelRef = useRef<HTMLDivElement>(null);
    const [hovered, setHovered] = useState(false);

    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [open, onClose]);

    useEffect(() => { if (!open) setHovered(false); }, [open]);

    if (!open) return null;

    return createPortal(
        <>
            {/* Mobile: dark backdrop that closes on tap. Desktop: no backdrop — list stays clickable */}
            <div className="blanc-floating-backdrop" onClick={onClose} />
            <div
                className="blanc-floating-close-zone"
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
            >
                {/* Hover bridge — always receives pointer events so cursor can travel from panel to close button */}
                <div className="blanc-floating-hover-bridge" />
                <div
                    ref={panelRef}
                    className={`blanc-floating-panel${wide ? ' blanc-floating-panel--wide' : ''}`}
                    onMouseEnter={() => setHovered(true)}
                >
                    {/* Mobile close button — visible only on mobile since hover close is hidden */}
                    <button
                        type="button"
                        onClick={onClose}
                        className="absolute top-3 right-3 z-10 p-2 rounded-xl md:hidden"
                        style={{ background: 'rgba(117, 106, 89, 0.08)', color: 'var(--blanc-ink-2)' }}
                    >
                        <X className="size-4" />
                    </button>
                    {children}
                </div>
                {/* Hover close button — left of the panel */}
                <button
                    type="button"
                    onClick={onClose}
                    className="blanc-floating-close-btn"
                    style={{
                        opacity: hovered ? 1 : 0,
                        background: hovered ? 'var(--blanc-ink-1)' : 'transparent',
                        color: hovered ? '#fff' : 'transparent',
                        boxShadow: hovered ? '0 4px 12px rgba(0,0,0,0.15)' : 'none',
                    }}
                    title="Close"
                >
                    <X className="size-3.5" />
                </button>
            </div>
        </>,
        document.body
    );
}
