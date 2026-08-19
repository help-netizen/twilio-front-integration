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

/**
 * Height of the area the user can actually SEE right now (visualViewport). Sizing a growing
 * composer off `window.innerHeight` is wrong on iOS: Safari counts the space behind its own
 * collapsed toolbars, the installed PWA counts the full screen — same code, two different
 * ceilings. The visible height is the one number both shells agree on.
 */
export function useVisibleViewportHeight(active: boolean): number {
    const [height, setHeight] = useState(() =>
        typeof window === 'undefined' ? 800 : window.visualViewport?.height ?? window.innerHeight);
    useEffect(() => {
        if (!active || typeof window === 'undefined') return;
        const read = () => setHeight(window.visualViewport?.height ?? window.innerHeight);
        read();
        window.visualViewport?.addEventListener('resize', read);
        window.visualViewport?.addEventListener('scroll', read);
        window.addEventListener('resize', read);
        const poll = window.setInterval(read, 250);
        return () => {
            window.visualViewport?.removeEventListener('resize', read);
            window.visualViewport?.removeEventListener('scroll', read);
            window.removeEventListener('resize', read);
            clearInterval(poll);
        };
    }, [active]);
    return height;
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

    /*
     * NOTHING BEHIND THE SCRIM SCROLLS (owner, 2026-08-19: "какой скролл, если я в инпуте?").
     *
     * pushFloatingOverlay pins the PAGE (body → position:fixed), which is why the page itself
     * holds still. It cannot stop an inner `overflow-y:auto` scroller, and the host sheet has
     * one: dragging over the scrim scrolled the Record-payment body underneath, and iOS carried
     * this fixed card down with the layout viewport until the input sat under the keyboard.
     * Two "fixes" before this one treated the symptom because they never crossed that gap.
     *
     * So the gesture is refused at the document, in the capture phase, for every touch that is
     * NOT inside the editable itself — a long value still scrolls INSIDE the field, which is the
     * only scrolling this screen has any use for.
     */
    useEffect(() => {
        if (!open) return;
        const onTouchMove = (event: TouchEvent) => {
            const target = event.target as Element | null;
            if (target?.closest?.('textarea, input, [data-composer-scroll]')) return;
            if (event.cancelable) event.preventDefault();
        };
        document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
        return () => document.removeEventListener('touchmove', onTouchMove, { capture: true } as EventListenerOptions);
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
                        ? '0 10px 0'
                        : '0 10px calc(8px + env(safe-area-inset-bottom))',
                }}
            >
                {children}
                {/* KEYBOARD-SHELF — iOS 26 draws its form bar as a FLOATING pill with a transparent
                    margin above it, and Safari and the installed PWA measure the keyboard's top edge
                    differently (innerHeight counts Safari's collapsed toolbars, standalone counts the
                    whole screen). Whatever is left between the composer and the keyboard therefore
                    showed as a strip of dark scrim — the "empty space under the input". This shelf
                    paints that strip in the composer's own colour, so the input always reads as
                    sitting ON the keyboard, identically in both shells. Purely cosmetic: it lives
                    outside the card's box and is clipped by whichever shell owns that band. */}
                {keyboardInset > 0 && (
                    <div
                        aria-hidden
                        style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            top: '100%',
                            height: 72,
                            background: 'var(--blanc-field)',
                        }}
                    />
                )}
            </div>
        </div>,
        document.body,
    );
}
