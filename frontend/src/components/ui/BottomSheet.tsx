/**
 * BottomSheet — reusable mobile bottom-sheet.
 *
 * Portals to <body>, dims the page behind a dark backdrop (tap to close), and
 * slides a full-width panel up from the bottom with rounded top corners. The
 * panel caps at ~85vh and scrolls internally, and respects the iOS home-bar
 * safe area. ESC and backdrop close it; body scroll is locked while open.
 *
 * Generic — pass { open, onClose, title, children }. Albusto tokens only.
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface Props {
    open: boolean;
    onClose: () => void;
    title: string;
    children: React.ReactNode;
}

export function BottomSheet({ open, onClose, title, children }: Props) {
    // ESC to close.
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [open, onClose]);

    // Lock body scroll while open.
    useEffect(() => {
        if (!open) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, [open]);

    if (!open) return null;

    return createPortal(
        <>
            {/* Inline keyframes so the slide-up animation stays self-contained. */}
            <style>{`@keyframes blancSheetUp{from{transform:translateY(100%)}to{transform:translateY(0)}}`}</style>

            {/* Dark backdrop — tap to close */}
            <div
                onClick={onClose}
                style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(40, 33, 22, 0.42)',
                    zIndex: 200,
                    animation: 'blancFadeIn 0.15s ease-out',
                }}
            />

            {/* Sheet panel */}
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title}
                style={{
                    position: 'fixed',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    zIndex: 201,
                    maxHeight: '85vh',
                    display: 'flex',
                    flexDirection: 'column',
                    background: 'var(--blanc-surface-strong, #fffdf9)',
                    borderTop: '1px solid var(--blanc-line, rgba(117, 106, 89, 0.18))',
                    borderRadius: '28px 28px 0 0',
                    boxShadow: '0 -12px 40px rgba(40, 33, 22, 0.22)',
                    animation: 'blancSheetUp 0.22s cubic-bezier(0.32, 0.72, 0, 1)',
                    paddingBottom: 'env(safe-area-inset-bottom)',
                }}
            >
                {/* Grab handle */}
                <div
                    style={{
                        width: 40,
                        height: 4,
                        borderRadius: 999,
                        background: 'var(--blanc-line, rgba(117, 106, 89, 0.28))',
                        margin: '10px auto 4px',
                        flexShrink: 0,
                    }}
                />

                {/* Header */}
                <div
                    className="flex items-center justify-between gap-3 px-5 pt-1 pb-3"
                    style={{ flexShrink: 0 }}
                >
                    <h2
                        className="font-bold"
                        style={{
                            fontFamily: 'Manrope, sans-serif',
                            fontSize: '18px',
                            letterSpacing: '-0.02em',
                            color: 'var(--blanc-ink-1)',
                            margin: 0,
                        }}
                    >
                        {title}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="p-2 rounded-xl transition-opacity hover:opacity-70"
                        style={{ background: 'rgba(117, 106, 89, 0.08)', color: 'var(--blanc-ink-2)' }}
                    >
                        <X className="size-4" />
                    </button>
                </div>

                {/* Scrollable body */}
                <div className="px-5 pb-5 overflow-y-auto" style={{ flex: 1 }}>
                    {children}
                </div>
            </div>
        </>,
        document.body,
    );
}
