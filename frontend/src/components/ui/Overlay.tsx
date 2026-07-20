/**
 * Overlay — THE shared plumbing core for every hand-rolled overlay surface
 * (OVERLAY-CANON-002, Phase 1).
 *
 * The hand-rolled surfaces (BottomSheet, FloatingDetailPanel,
 * FullscreenImageViewer) each re-implemented the SAME boilerplate: an SSR/closed
 * guard, `createPortal` to <body>, a backdrop element, the `useOverlayDismiss`
 * wiring, and picking a z-index off `OVERLAY_Z` / `OVERLAY_Z_BACKDROP`. That plumbing
 * now lives here ONCE; each surface keeps only its own panel markup.
 *
 * This is deliberately a THIN, render-prop core — NOT a mega-component. It owns:
 *   • the SSR guard + `open` short-circuit,
 *   • the portal to `document.body`,
 *   • one `useOverlayDismiss` call, with behavior defaults derived from the variant
 *     (each independently overridable so a surface's exact behavior is unchanged),
 *   • an OPTIONAL default backdrop (inline-styled per variant, z from the scale),
 *   • the panel z-index for the variant's tier.
 *
 * It does NOT own any panel markup: the consumer renders its OWN panel via the
 * render-prop child, spreading `panelProps` (and, for a sheet, `dragHandlers` /
 * `dragOffset` / `isDragging`). So each surface's rendered output stays byte-identical
 * — the core only hoists the surrounding plumbing.
 *
 * Backdrop flexibility: surfaces with a bespoke backdrop (FloatingDetailPanel's
 * CSS-class `.blanc-floating-backdrop`; the lightbox whose scrim IS its own container)
 * pass `backdrop={false}` and render their own scrim inside the child, wiring it with
 * the `backdropProps.onClick` the child receives. The default backdrop is only for the
 * plain inline-styled case (BottomSheet and centered overlays).
 *
 * Stacking (Esc/Tab-trap gating on the top-most layer) comes for free: the single
 * `useOverlayDismiss` call carries the Phase-0 OverlayStack awareness, so every
 * surface gains it without touching its wrapper.
 */

import type * as React from 'react'
import { createPortal } from 'react-dom'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import type {
    OverlayDragHandlers,
    UseOverlayDismissOptions,
} from '../../hooks/useOverlayDismiss'
import { OVERLAY_Z, OVERLAY_Z_BACKDROP, type CardStackStyle } from './overlayLayout'

export type OverlayVariant = 'bottom-sheet' | 'right-drawer' | 'centered' | 'lightbox'

/** Which z-index tier (panel/modal/sheet/lightbox) an overlay paints on. */
export type OverlayTier = 'panel' | 'modal' | 'sheet' | 'lightbox'

/**
 * What the render-prop child receives. It composes its OWN panel with these — the core
 * never renders panel markup itself.
 */
export interface OverlayRenderProps {
    /** Spread onto the panel element (ref + role + aria-modal + tabIndex + onKeyDown). */
    panelProps: ReturnType<typeof useOverlayDismiss>['panelProps']
    /** `{ onClick }` for a custom backdrop the consumer renders itself (backdrop={false}). */
    backdropProps: ReturnType<typeof useOverlayDismiss>['backdropProps']
    /** Populated when drag-to-dismiss is on (spread onto the drag region); else empty. */
    dragHandlers: OverlayDragHandlers | Record<never, never>
    /** Live downward drag offset in px (0 when idle). Map to translateY in the consumer. */
    dragOffset: number
    /** True while a drag is in progress — suppress the spring transition. */
    isDragging: boolean
    /** z-index for the panel (from OVERLAY_Z, resolved for this variant's tier). */
    z: number
    /** The resolved tier name. */
    tier: OverlayTier
    // ── Desktop card-stack (OVERLAY-CANON-002, Phase 3) ──────────────────────────
    /**
     * Card-stack fragments for this layer when overlays sit ABOVE it on DESKTOP
     * (translateX + scale in `.transform`, plus `.transformOrigin` / `.filter` /
     * `.transition`). EMPTY (all fields undefined / '') when this is the top layer,
     * when it's the only overlay, or on mobile — so the common single-overlay case is
     * visually UNCHANGED. Consumers COMPOSE `stack.transform` into their own base
     * transform (e.g. a sheet's drag translateY): they must NOT let it clobber theirs.
     */
    stack: CardStackStyle
    /** How many overlays are stacked above this one (0 = top / lone). */
    layersAbove: number
}

export interface OverlayProps {
    /** Whether the overlay is mounted/open. */
    open: boolean
    /** Close handler (Esc / backdrop / drag route through this). */
    onClose: () => void
    /** Positioning + behavior-defaults family. */
    variant: OverlayVariant
    /**
     * right-drawer only: modal (scroll-lock + focus-trap + modal tier) vs. non-modal
     * (panel tier, no scroll-lock/focus-trap). Default true. Ignored for other variants.
     */
    modal?: boolean

    // ── Behavior overrides (default = per-variant, see resolveBehavior) ──────────
    esc?: boolean
    closeOnBackdrop?: boolean
    scrollLock?: boolean
    focusTrap?: boolean
    restoreFocus?: boolean
    dragToDismiss?: boolean
    dragThreshold?: number
    stopEscPropagation?: boolean

    // ── Default backdrop (inline case only) ──────────────────────────────────────
    /**
     * Render the core's default (inline-styled) backdrop. Default true for
     * bottom-sheet / centered; false for right-drawer / lightbox (which render their
     * own scrim inside the child). Pass false to fully suppress it.
     */
    backdrop?: boolean
    /** Extra inline style merged onto the default backdrop. */
    backdropStyle?: React.CSSProperties
    /** className for the default backdrop. */
    backdropClassName?: string

    /** Render-prop: compose the panel with the supplied plumbing props. */
    children: (props: OverlayRenderProps) => React.ReactNode
}

/** variant → z-index tier. right-drawer splits on `modal`. */
function resolveTier(variant: OverlayVariant, modal: boolean): OverlayTier {
    switch (variant) {
        case 'bottom-sheet':
            return 'sheet'
        case 'centered':
            return 'modal'
        case 'lightbox':
            return 'lightbox'
        case 'right-drawer':
            return modal ? 'modal' : 'panel'
    }
}

/**
 * Per-variant behavior defaults for `useOverlayDismiss`. Each is overridable via the
 * matching Overlay prop — these only fill in the omitted ones, so a wrapper reproduces
 * its exact prior behavior. `undefined` = "leave the hook's own default".
 */
type Behavior = Pick<
    UseOverlayDismissOptions,
    | 'esc'
    | 'closeOnBackdrop'
    | 'scrollLock'
    | 'focusTrap'
    | 'restoreFocus'
    | 'dragToDismiss'
    | 'dragThreshold'
    | 'stopEscPropagation'
>

function resolveBehavior(variant: OverlayVariant, modal: boolean): Behavior {
    switch (variant) {
        case 'bottom-sheet':
            // scroll-lock + focus-trap + drag-to-dismiss (grab handle is the wrapper's).
            return {
                esc: true,
                closeOnBackdrop: true,
                scrollLock: true,
                focusTrap: true,
                dragToDismiss: true,
                dragThreshold: 80,
                stopEscPropagation: true,
            }
        case 'centered':
            // scroll-lock + focus-trap.
            return {
                esc: true,
                closeOnBackdrop: true,
                scrollLock: true,
                focusTrap: true,
            }
        case 'right-drawer':
            // modal → scroll-lock + focus-trap; non-modal → neither (background stays live).
            return {
                esc: true,
                closeOnBackdrop: true,
                scrollLock: modal,
                focusTrap: modal,
            }
        case 'lightbox':
            // scroll-lock; focus-trap OFF; backdrop-close OFF by default (custom guard).
            return {
                esc: true,
                closeOnBackdrop: false,
                scrollLock: true,
                focusTrap: false,
            }
    }
}

/** Default backdrop enabled? (inline-styled scrim). */
function defaultBackdropOn(variant: OverlayVariant): boolean {
    return variant === 'bottom-sheet' || variant === 'centered'
}

/** Inline style for the core's default backdrop, per variant. */
function defaultBackdropStyle(variant: OverlayVariant, tier: OverlayTier): React.CSSProperties {
    // Every OverlayTier ('panel'|'modal'|'sheet'|'lightbox') is a valid backdrop key.
    const base: React.CSSProperties = {
        position: 'fixed',
        inset: 0,
        zIndex: OVERLAY_Z_BACKDROP[tier],
        // SELECT-IN-DIALOG-TAP-FIX-001 — when this overlay is opened from INSIDE a Radix
        // modal Dialog (e.g. the State <Select> in the New Job form), Radix locks the page
        // by setting `pointer-events: none` on <body>. `pointer-events` INHERITS, and this
        // portal is a direct child of <body> OUTSIDE Radix's own layer, so without an
        // explicit re-enable the backdrop is dead: tap-to-close stops working and the touch
        // falls through to the form behind. Forcing `auto` fixes it and is a no-op normally.
        pointerEvents: 'auto',
    }
    if (variant === 'bottom-sheet') {
        return {
            ...base,
            background: 'rgba(40, 33, 22, 0.42)',
            backdropFilter: 'blur(2px)',
            WebkitBackdropFilter: 'blur(2px)',
            animation: 'blancFadeIn 0.15s ease-out',
        }
    }
    // centered (modal)
    return {
        ...base,
        background: 'rgba(32, 39, 52, 0.65)',
        backdropFilter: 'blur(8px)',
    }
}

export function Overlay({
    open,
    onClose,
    variant,
    modal = true,
    esc,
    closeOnBackdrop,
    scrollLock,
    focusTrap,
    restoreFocus,
    dragToDismiss,
    dragThreshold,
    stopEscPropagation,
    backdrop,
    backdropStyle,
    backdropClassName,
    children,
}: OverlayProps) {
    const tier = resolveTier(variant, modal)
    const defaults = resolveBehavior(variant, modal)

    // Explicit prop wins over the per-variant default; `?? undefined` lets the hook's
    // own default apply for anything neither sets.
    const { panelProps, backdropProps, dragHandlers, dragOffset, isDragging, stack, layersAbove } = useOverlayDismiss({
        open,
        onClose,
        esc: esc ?? defaults.esc,
        closeOnBackdrop: closeOnBackdrop ?? defaults.closeOnBackdrop,
        scrollLock: scrollLock ?? defaults.scrollLock,
        focusTrap: focusTrap ?? defaults.focusTrap,
        restoreFocus: restoreFocus ?? defaults.restoreFocus,
        dragToDismiss: dragToDismiss ?? defaults.dragToDismiss,
        dragThreshold: dragThreshold ?? defaults.dragThreshold,
        stopEscPropagation: stopEscPropagation ?? defaults.stopEscPropagation,
        // Paint z-tier → card-stack ordering. A non-modal right-drawer (panel tier, z 80)
        // thus never ranks above a modal (z 140); it recedes under it, not vice-versa.
        z: OVERLAY_Z[tier],
    })

    if (typeof document === 'undefined') return null // SSR-safe.
    if (!open) return null

    const showBackdrop = backdrop ?? defaultBackdropOn(variant)
    const z = OVERLAY_Z[tier]

    return createPortal(
        <>
            {showBackdrop && (
                <div
                    {...backdropProps}
                    className={backdropClassName}
                    style={{ ...defaultBackdropStyle(variant, tier), ...backdropStyle }}
                />
            )}
            {children({ panelProps, backdropProps, dragHandlers, dragOffset, isDragging, z, tier, stack, layersAbove })}
        </>,
        document.body,
    )
}
