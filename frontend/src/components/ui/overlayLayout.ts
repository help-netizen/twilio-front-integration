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
