import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { pushFloatingOverlay, popFloatingOverlay } from '../../lib/floatingOverlayLock';

/**
 * NOTE-COMPOSER-KEYBOARD — floating note composer docked directly above the iOS keyboard
 * (owner's Todoist reference: the input "lies on top of the keyboard").
 *
 * This deliberately does NOT reuse the shared BottomSheet: on the owner's iOS 18 that sheet
 * would not lift above the keyboard, while this exact pattern — a fixed card + backdrop
 * portaled to <body>, translated up by the live visualViewport keyboard height — was verified
 * working in the keyboard-harness on the owner's device (all techniques floated). visualViewport
 * events can be flaky on iOS, so a short poll backs them up (the harness polled too).
 */
export function useKeyboardInset(active: boolean): number {
    const [inset, setInset] = useState(0);
    useEffect(() => {
        if (!active || typeof window === 'undefined' || !window.visualViewport) {
            setInset(0);
            return;
        }
        const vv = window.visualViewport;
        const read = () => setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
        read();
        vv.addEventListener('resize', read);
        vv.addEventListener('scroll', read);
        const poll = window.setInterval(read, 250); // belt — iOS vv events can miss keyboard toggles
        return () => {
            vv.removeEventListener('resize', read);
            vv.removeEventListener('scroll', read);
            clearInterval(poll);
        };
    }, [active]);
    return inset;
}

interface NoteComposerOverlayProps {
    open: boolean;
    onClose: () => void;
    children: ReactNode;
}

/** Dimmed backdrop + a bottom-docked card that rides above the keyboard. Portals to <body>. */
export function NoteComposerOverlay({ open, onClose, children }: NoteComposerOverlayProps) {
    const keyboardInset = useKeyboardInset(open);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    // Freeze the layer behind us while open: lock the background scroll AND stop the host
    // bottom-sheet from lifting to the keyboard (the keyboard is ours, not the sheet's). Both
    // are coordinated by floatingOverlayLock so nothing under the translucent scrim moves.
    useEffect(() => {
        if (!open) return;
        pushFloatingOverlay();
        return popFloatingOverlay;
    }, [open]);

    if (!open) return null;

    return createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, pointerEvents: 'auto' }} aria-modal="true" role="dialog">
            <div
                onClick={onClose}
                style={{ position: 'absolute', inset: 0, background: 'rgba(25, 25, 25, 0.38)' }}
            />
            {/* No sheet chrome — the card is transparent so ONLY the inner input floats above the
                keyboard (owner: "don't show that the input is in a bottom sheet"). Minimal padding:
                side margins + a small lift off the keyboard, no big bottom gap.
                With the keyboard DOWN there is nothing under us, so the card must clear the home
                indicator itself — otherwise its bottom edge runs off the screen. */}
            <div
                style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    transform: `translateY(${-keyboardInset}px)`,
                    background: 'transparent',
                    padding: keyboardInset > 0
                        ? '0 10px 8px'
                        : '0 10px calc(8px + env(safe-area-inset-bottom))',
                }}
            >
                {children}
            </div>
        </div>,
        document.body,
    );
}
