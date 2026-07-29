import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Search, X } from 'lucide-react';
import { useKeyboardInset } from './NoteComposerOverlay';
import { pushFloatingOverlay, popFloatingOverlay } from '../../lib/floatingOverlayLock';

interface FullScreenSearchPickerProps {
    open: boolean;
    onClose: () => void;
    /** Controlled search text — the parent owns filtering (client- or server-side). */
    query: string;
    onQueryChange: (q: string) => void;
    placeholder?: string;
    /** Small eyebrow above the list for context (e.g. "Change provider"). Optional. */
    title?: string;
    /**
     * Auto-focus the search box (raising the keyboard) on open. DEFAULT false — the owner's
     * rule for this pattern: the keyboard stays DOWN until the user taps search, so they see
     * the whole list first and only summon the keyboard to narrow it.
     */
    autoFocusSearch?: boolean;
    /** Sticky bottom bar (e.g. a multi-select "N selected · Save"). Rides above the keyboard. */
    footer?: ReactNode;
    /** The list — already filtered by the parent against `query`. */
    children: ReactNode;
}

/**
 * INPUT-KBD type C — full-screen searchable list picker (mobile).
 *
 * The owner's spec: a control that picks from a list which filters as you type. On mobile it
 * opens a FULL-SCREEN layer instead of a keyboard-covered dropdown / bottom sheet:
 *   1) full-page layer; the keyboard is NOT open by default (see autoFocusSearch);
 *   2) the search input is pinned at the TOP — you type RIGHT THERE, no floating hover input
 *      (unlike type A), because a top-anchored input is never covered by the bottom keyboard;
 *   3) the list sits below and scrolls independently;
 *   4) the parent filters the list to the query.
 *
 * The layer's bottom edge tracks the keyboard (`bottom: keyboardInset`), so the list — and any
 * sticky footer — always end exactly at the keyboard's top edge; nothing is covered. While open
 * it freezes the layer behind it (floatingOverlayLock: body scroll-lock + host-sheet freeze) so
 * the background never jitters. Desktop is unaffected — callers gate this on `useIsMobile()` and
 * keep their existing popover/inline combobox.
 */
export function FullScreenSearchPicker({
    open, onClose, query, onQueryChange, placeholder, title, autoFocusSearch = false, footer, children,
}: FullScreenSearchPickerProps) {
    const keyboardInset = useKeyboardInset(open);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    // Freeze the layer behind us while open (scroll-lock + host-sheet freeze).
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
                bottom: keyboardInset, // list + footer end exactly at the keyboard's top edge
                zIndex: 1000,
                pointerEvents: 'auto', // re-enable taps when opened over a Radix modal (body pointer-events:none)
                background: 'var(--blanc-surface-strong)',
                display: 'flex',
                flexDirection: 'column',
            }}
            role="dialog"
            aria-modal="true"
        >
            {/* Header: close + the search input, pinned at the top. Type directly here. */}
            <div className="flex items-center gap-2" style={{ padding: 'calc(env(safe-area-inset-top) + 10px) 12px 10px', flexShrink: 0 }}>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close"
                    className="flex size-9 shrink-0 items-center justify-center rounded-full"
                    style={{ background: 'var(--blanc-field)', color: 'var(--blanc-ink-1)' }}
                >
                    <X className="size-5" />
                </button>
                <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2" style={{ color: 'var(--blanc-ink-3)' }} />
                    <input
                        type="text"
                        autoFocus={autoFocusSearch}
                        value={query}
                        placeholder={placeholder}
                        onChange={e => onQueryChange(e.target.value)}
                        className="h-10 w-full rounded-[10px] border-[1.5px] border-transparent bg-[var(--blanc-field)] pl-9 pr-3 text-base text-[var(--blanc-ink-1)] outline-none focus-visible:border-[var(--blanc-ink-2)]"
                    />
                </div>
            </div>

            {title && (
                <div className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--blanc-ink-3)', flexShrink: 0 }}>
                    {title}
                </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" style={{ paddingBottom: footer ? 8 : 'env(safe-area-inset-bottom)' }}>
                {children}
            </div>

            {footer && (
                <div
                    className="flex shrink-0 items-center justify-end gap-3 border-t px-4 py-3"
                    style={{ borderColor: 'var(--blanc-line)', background: 'var(--blanc-bg,#F1F1F0)', paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}
                >
                    {footer}
                </div>
            )}
        </div>,
        document.body,
    );
}

interface SearchPickerRowProps {
    onClick: () => void;
    /**
     * undefined → single-select row (no checkmark column, tap picks & closes).
     * boolean   → multi-select row (leading checkmark, filled when true).
     */
    selected?: boolean;
    /** Optional right-aligned content (a price, a chevron, a badge…). */
    right?: ReactNode;
    children: ReactNode;
}

/** Standard row for a FullScreenSearchPicker list — keeps every picker's rows consistent. */
export function SearchPickerRow({ onClick, selected, right, children }: SearchPickerRowProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex w-full items-center gap-3 px-4 text-left transition-colors active:bg-[rgba(25,25,25,0.05)]"
            style={{ minHeight: 52 }}
        >
            {selected !== undefined && (
                <Check
                    className="size-5 shrink-0 transition-opacity"
                    style={{ color: 'var(--blanc-accent)', opacity: selected ? 1 : 0 }}
                />
            )}
            <div className="min-w-0 flex-1 py-2.5">{children}</div>
            {right != null && <div className="shrink-0">{right}</div>}
        </button>
    );
}
