/**
 * overlayLayout — single home for the overlay/panel sizing + close-anchoring math.
 *
 * OVERLAY-CLOSE-CANON-001. Every right-side "layer" (the dialog.tsx panel variant,
 * the FloatingDetailPanel view card) anchors its hover-reveal close button just
 * OUTSIDE the panel's left edge. That anchor depends on the panel's width, so the
 * width-per-size table lives here and both the panel and the close affordance import
 * it from one place (no drift between the panel width and where the × sits).
 *
 * `DialogSize` is defined here (not in dialog.tsx) because dialog.tsx imports FROM
 * this module — this is the lower layer.
 */

/** Width tier for a centered dialog OR a right-side panel/slide-over. */
export type DialogSize = "sm" | "default" | "wide" | "full"

/**
 * Raw panel width per size (mirrors dialog.tsx PANEL_WIDTH without the `md:w-[]`
 * wrapper) — used to anchor the hover-reveal close just LEFT of the panel's edge at
 * any width. Standard forms use --blanc-layer-width (the SAME width as the
 * job/lead/estimate VIEW card), so create- and view-layers line up; only heavy
 * document editors (wide/full) get extra width.
 */
export const PANEL_CLOSE_RIGHT: Record<DialogSize, string> = {
    sm: "var(--blanc-layer-width)",
    default: "var(--blanc-layer-width)",
    wide: "min(1020px,calc(100vw-100px))",
    full: "min(1320px,calc(100vw-72px))",
}

/**
 * OVERLAY-CANON-002 (Phase 0) — the single z-index scale for every overlay layer.
 * Values PRESERVE the pre-existing z-order; this is centralization, not a re-stack.
 *
 *   panel(80)     FloatingDetailPanel — the non-modal right "view" card (desktop).
 *   modal(140)    Dialog + AIAssistantModal panel.
 *   dropdown(150) Select / Popover / DropdownMenu content. INTENTIONALLY ABOVE
 *                 modal(140): a <Select> opened inside a <Dialog> must pop ABOVE the
 *                 dialog, or its options render behind the modal. Do NOT "fix" this
 *                 by dropping it below modal — that is the bug it prevents.
 *   sheet(200)    BottomSheet panel (mobile) — above everything below it.
 *   lightbox(1000) Fullscreen image viewer — the top-most surface.
 */
export const OVERLAY_Z = { panel: 80, modal: 140, dropdown: 150, sheet: 200, lightbox: 1000 } as const

/**
 * Backdrop tier per overlay. A backdrop sits JUST BELOW its own panel (modal panel
 * 140 / its scrim 140 paints first in DOM order; sheet panel 200 / scrim 190;
 * lightbox 1000 / scrim 999). `panel` and `dropdown` are non-modal → no scrim (0).
 */
export const OVERLAY_Z_BACKDROP = { panel: 0, modal: 140, dropdown: 0, sheet: 190, lightbox: 999 } as const

/** OverlayClose hover-reveal affordance — one notch above a modal panel. */
export const OVERLAY_CLOSE_Z = 141

/**
 * OVERLAY-CANON-002 (Phase 3) — DESKTOP card-stack transform.
 *
 * When 2+ overlays are open on desktop, every layer that has something ABOVE it
 * slides LEFT + dims + scales down slightly, so the lower one "peeks" on the left
 * behind the top layer (owner: "нижнюю чуть видно слева, он как бы съезжает чуть чуть").
 * MOBILE gets NO transform — the top simply covers the lower (owner-explicit).
 *
 * `layersAbove` = how many overlays sit on top of this one (0 = it IS the top; the
 * common single-overlay case is always 0 → returns empty pieces → visually UNCHANGED).
 * The pieces are returned SEPARATELY (not a ready `transform` string) because each
 * surface owns its own base transform that this must COMPOSE with, not clobber:
 *   • a centered dialog is centered via translate(-50%, -50%),
 *   • a bottom-sheet adds a drag translateY,
 *   • a right-drawer's slide-in is a CSS @keyframes (no fill-mode) that this inline
 *     transform correctly takes over from once it settles.
 * Callers build `transform: [<their base>, cardStack.transform].filter(Boolean).join(' ')`.
 */
export interface CardStackStyle {
    /** The card-stack transform fragment (translateX + scale). '' when inactive. */
    transform: string
    /** transform-origin for the pivot ('center left'). undefined when inactive. */
    transformOrigin: string | undefined
    /** Dim via brightness/saturate. undefined when inactive. */
    filter: string | undefined
    /** Smooth push-back / return transition. undefined when inactive. */
    transition: string | undefined
}

/** Per-layer horizontal shove (px). Owner wanted a small peek ("чуть чуть"). */
const CARD_STACK_OFFSET = 26
/** Per-layer scale reduction. */
const CARD_STACK_SCALE_STEP = 0.03
/** Per-layer brightness reduction (capped so a deep stack never goes black). */
const CARD_STACK_DIM_STEP = 0.14
/** Depth beyond which extra dim/offset stops compounding (keeps a deep pile legible). */
const CARD_STACK_MAX_DEPTH = 2
/** One shared transition for both push-back and return, matching the sheet spring. */
export const CARD_STACK_TRANSITION =
    'transform 0.25s cubic-bezier(0.32, 0.72, 0, 1), filter 0.25s ease'

const CARD_STACK_INACTIVE: CardStackStyle = {
    transform: '',
    transformOrigin: undefined,
    filter: undefined,
    transition: undefined,
}

/**
 * Compute the desktop card-stack fragments for a layer with `layersAbove` overlays
 * on top of it. `isMobile` true OR `layersAbove <= 0` → the INACTIVE (empty) result,
 * so mobile and the single-overlay desktop case are byte-identical to pre-Phase-3.
 */
export function cardStackStyle(layersAbove: number, isMobile: boolean): CardStackStyle {
    if (isMobile || layersAbove <= 0) return CARD_STACK_INACTIVE
    // Offset keeps accumulating a little per layer (so 2 vs 3 deep still differ) but the
    // scale/dim clamp at MAX_DEPTH so a tall stack stays readable and never inverts.
    const dimLayers = Math.min(layersAbove, CARD_STACK_MAX_DEPTH)
    const scale = 1 - CARD_STACK_SCALE_STEP * dimLayers
    const brightness = 1 - CARD_STACK_DIM_STEP * dimLayers
    return {
        transform: `translateX(${-CARD_STACK_OFFSET * layersAbove}px) scale(${scale})`,
        transformOrigin: 'center left',
        filter: `brightness(${brightness}) saturate(0.92)`,
        transition: CARD_STACK_TRANSITION,
    }
}

/**
 * class-vs-inline split (why some sites keep a `z-[NNN]` Tailwind class and only add
 * a `/* OVERLAY_Z.* *​/` comment instead of importing the const):
 *   • Portal'd Radix content (dialog/select/popover/dropdown) + OverlayClose set z via
 *     a `cn(...)` className string. Swapping to `style={{ zIndex }}` would fight Radix's
 *     own inline positioning, and a *computed* `z-[${n}]` class is invisible to the
 *     Tailwind JIT (the utility would never be generated). So those sites keep the
 *     literal `z-[NNN]` class — kept in lock-step with this scale by the trailing
 *     comment — and only the hand-rolled inline-style overlays (BottomSheet,
 *     FullscreenImageViewer, AIAssistantModal) reference the const directly.
 *   • FloatingDetailPanel's z lives in plain CSS (design-system.css .blanc-floating-panel:
 *     80 desktop / 120 mobile-cover) which can't import TS — it carries a comment there.
 */
