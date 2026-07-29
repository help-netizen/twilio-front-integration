import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useKeyboardInset } from './NoteComposerOverlay';
import { pushFloatingOverlay, popFloatingOverlay } from '../../lib/floatingOverlayLock';

interface FullScreenTextEditorProps {
    open: boolean;
    initialValue: string;
    onDone: (text: string) => void;
    onCancel: () => void;
    title?: string;
    placeholder?: string;
    doneLabel?: string;
}

/**
 * INPUT-KBD type B — full-screen text editor for LARGE text (a service report, a long note).
 * A small floating hover-input (FloatingTextField) is wrong for big text; this fills the screen:
 * a fixed header (close + Done) and a textarea that occupies everything above the keyboard and
 * scrolls internally. On its own layer over everything, so nothing behind it scrolls. Reuses
 * useKeyboardInset so the editable area always ends exactly at the top of the keyboard.
 */
export function FullScreenTextEditor({
    open, initialValue, onDone, onCancel, title, placeholder, doneLabel = 'Done',
}: FullScreenTextEditorProps) {
    const [text, setText] = useState(initialValue);
    const keyboardInset = useKeyboardInset(open);

    useEffect(() => { if (open) setText(initialValue); }, [open, initialValue]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onCancel]);

    // Freeze the layer behind us: lock background scroll + stop the host sheet lifting to the
    // keyboard. This editor is opaque, so the freeze mainly guarantees the background is exactly
    // where it was when we close — no scroll jump, no residual sheet-lift. See floatingOverlayLock.
    useEffect(() => {
        if (!open) return;
        pushFloatingOverlay();
        return popFloatingOverlay;
    }, [open]);

    if (!open) return null;

    return createPortal(
        <div
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: keyboardInset, // the surface ends exactly at the keyboard's top edge
                zIndex: 1000,
                pointerEvents: 'auto', // re-enable taps when opened over a Radix modal (which sets body pointer-events:none)
                background: 'var(--blanc-surface-strong)',
                display: 'flex',
                flexDirection: 'column',
            }}
            aria-modal="true"
            role="dialog"
        >
            <div
                className="flex items-center justify-between"
                style={{ padding: 'calc(env(safe-area-inset-top) + 10px) 14px 10px', flexShrink: 0 }}
            >
                <button
                    type="button"
                    onClick={onCancel}
                    aria-label="Close"
                    className="flex items-center justify-center rounded-full"
                    style={{ width: 40, height: 40, background: 'var(--blanc-field)', color: 'var(--blanc-ink-1)' }}
                >
                    <X className="size-5" />
                </button>
                {title && (
                    <span className="text-sm font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>{title}</span>
                )}
                <button
                    type="button"
                    onClick={() => onDone(text)}
                    className="rounded-full px-4 text-sm font-semibold"
                    style={{ height: 40, background: 'var(--blanc-accent)', color: '#fff' }}
                >
                    {doneLabel}
                </button>
            </div>

            <textarea
                autoFocus
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder={placeholder}
                className="w-full flex-1 resize-none bg-transparent outline-none"
                style={{
                    border: 'none',
                    padding: '4px 16px 16px',
                    fontSize: 16,
                    lineHeight: 1.55,
                    color: 'var(--blanc-ink-1)',
                }}
            />
        </div>,
        document.body,
    );
}
