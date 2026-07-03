/**
 * OverlayClose — THE single renderer of overlay close controls
 * (OVERLAY-CLOSE-CANON-001).
 *
 * Consolidates the close affordances that were copy-pasted across the app:
 *   • the centered/inside top-right × (dialog.tsx centered, BottomSheet, AI + viewer)
 *   • the desktop hover-reveal × anchored just LEFT of a right-side panel (dialog.tsx
 *     panel variant + FloatingDetailPanel `.blanc-floating-close-btn`)
 *
 * Two variants, each rendering EXACTLY ONE `<button>`, `forwardRef`'d to it, and
 * spreading any injected `...rest` props onto that single child. This makes the
 * component drop-in for `<DialogPrimitive.Close asChild>` — Radix injects
 * onClick/data-state/ref onto its lone child, and we pass them straight through:
 *
 *     <DialogPrimitive.Close asChild>
 *       <OverlayClose variant="corner" />
 *     </DialogPrimitive.Close>
 *
 *   • variant="corner"    — one inside top-right × (soft pill bg). Use for centered
 *                            dialogs, bottom-sheets, and full-screen viewers.
 *   • variant="slideover" — one DESKTOP-ONLY fixed hover-reveal × (`md:flex hidden`),
 *                            anchored via PANEL_CLOSE_RIGHT[size]. It renders NO mobile
 *                            button — consumers add a separate `corner` for mobile.
 *
 * ── COMPOSITION (migrators: follow this) ──────────────────────────────────────
 * A full right-side SLIDE-OVER surface renders BOTH buttons:
 *
 *     <OverlayClose variant="corner" className="md:hidden" onClose={close} />   // mobile
 *     <OverlayClose variant="slideover" size={size} onClose={close} />          // desktop
 *
 * The panel element that owns the desktop button MUST carry the `peer` class, so the
 * desktop button's `peer-hover:*` reveal fires when the panel is hovered.
 *
 * A CENTERED MODAL or BOTTOM SHEET renders only the corner button:
 *
 *     <OverlayClose variant="corner" onClose={close} />
 *
 * onClose vs. Radix: `onClose` is for standalone use. When wrapped by
 * `<DialogPrimitive.Close asChild>`, Radix injects its own onClick via `...rest`;
 * we merge the two (both fire) so the Radix-driven close always works.
 */

import type * as React from "react"
import { forwardRef } from "react"
import { X } from "lucide-react"
import { cn } from "../../lib/utils"
import { PANEL_CLOSE_RIGHT, type DialogSize } from "./overlayLayout"

export interface OverlayCloseProps extends React.ComponentPropsWithoutRef<"button"> {
    variant: "slideover" | "corner"
    /** Required for `slideover` — anchors the desktop hover-reveal × to the panel's edge. */
    size?: DialogSize
    /**
     * Slideover only: overrides the close-× horizontal anchor with the panel's ACTUAL
     * right-edge width (a CSS length, e.g. "420px" or "var(--blanc-layer-width)"). Use when
     * a panel's width doesn't match a `PANEL_CLOSE_RIGHT[size]` entry (e.g. FloatingDetailPanel),
     * so the × lands on its edge without resizing the panel. Falls back to PANEL_CLOSE_RIGHT[size].
     */
    anchorRight?: string
    /**
     * Close handler for standalone use. When wrapped by `<DialogPrimitive.Close asChild>`,
     * Radix's injected onClick (via `...rest`) also fires — we merge, never clobber.
     */
    onClose?: () => void
}

// Inside top-right × — dialog.tsx's centered close look (`absolute right-4 top-[18px]`,
// Lucide X size-4 + sr-only "Close"), plus the soft pill background that the
// bottom-sheet / AI / viewer × already use, so migrating those to `corner` is identical.
const CORNER_CLASSES = cn(
    "absolute right-4 top-[18px] inline-flex items-center justify-center rounded-xl p-2",
    "text-[var(--blanc-ink-2)] transition-opacity hover:opacity-70",
    "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
)
const CORNER_PILL_STYLE: React.CSSProperties = { background: "rgba(25,25,25,0.06)" }

// Desktop hover-reveal × anchored LEFT of the panel (dialog.tsx panel button, line 130):
// fixed, desktop-only (`md:flex hidden`), hidden until the `peer` panel (or the button
// itself) is hovered.
const SLIDEOVER_DESKTOP_CLASSES = cn(
    // z-[141] === OVERLAY_CLOSE_Z (overlayLayout.ts), one notch above a modal panel —
    // kept as a literal class (a computed z-[${n}] is invisible to the Tailwind JIT).
    "fixed z-[141] hidden h-7 w-7 items-center justify-center rounded-full",
    "bg-transparent text-transparent opacity-0 transition-all duration-150",
    "focus:outline-none md:flex",
    "peer-hover:bg-[var(--blanc-ink-1)] peer-hover:text-white peer-hover:opacity-100 peer-hover:shadow-[0_4px_12px_rgba(0,0,0,0.15)]",
    "hover:bg-[var(--blanc-ink-1)] hover:text-white hover:opacity-100 hover:shadow-[0_4px_12px_rgba(0,0,0,0.15)]",
)

export const OverlayClose = forwardRef<HTMLButtonElement, OverlayCloseProps>(
    ({ variant, size, anchorRight, onClose, className, style, onClick, ...rest }, ref) => {
        // Merge `onClose` (standalone) with any injected onClick (Radix Close asChild) —
        // both run, so wiring up `onClose` never silences Radix's close, and vice-versa.
        const handleClick: React.MouseEventHandler<HTMLButtonElement> = (event) => {
            onClick?.(event)
            onClose?.()
        }

        if (variant === "corner") {
            return (
                <button
                    ref={ref}
                    type="button"
                    aria-label="Close"
                    onClick={handleClick}
                    className={cn(CORNER_CLASSES, className)}
                    style={{ ...CORNER_PILL_STYLE, ...style }}
                    {...rest}
                >
                    <X className="size-4" />
                    <span className="sr-only">Close</span>
                </button>
            )
        }

        // variant === "slideover" — single desktop-only hover-reveal ×, anchored just
        // outside the panel's left edge at the panel's width.
        const anchor = anchorRight ?? PANEL_CLOSE_RIGHT[size ?? "default"]
        return (
            <button
                ref={ref}
                type="button"
                title="Close"
                onClick={handleClick}
                className={cn(SLIDEOVER_DESKTOP_CLASSES, className)}
                style={{
                    top: "calc(var(--blanc-layer-top) + 12px)",
                    right: `calc(${anchor} + 8px)`,
                    ...style,
                }}
                {...rest}
            >
                <X className="size-3.5" />
                <span className="sr-only">Close</span>
            </button>
        )
    },
)
OverlayClose.displayName = "OverlayClose"
