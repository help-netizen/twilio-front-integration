import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { cn } from "../../lib/utils"
import { OverlayClose } from "./OverlayClose"
import { cardStackStyle, type DialogSize } from "./overlayLayout"
import { useIsMobile } from "../../hooks/useIsMobile"
import { useOverlayDismiss } from "../../hooks/useOverlayDismiss"
import { useOverlayStack } from "./OverlayStack"

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogClose = DialogPrimitive.Close

const DialogPortal = DialogPrimitive.Portal

const DialogOverlay = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Overlay>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Overlay
        ref={ref}
        className={cn(
            // z-[140] === OVERLAY_Z.modal (overlayLayout.ts). Kept as a literal class, not
            // an imported const: a computed z-[${n}] is invisible to the Tailwind JIT.
            "fixed inset-0 z-[140] bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            className
        )}
        {...props}
    />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

// MODAL-REDESIGN-001 — two presentations:
//  • variant="dialog" (default) — centered modal; width via `size`. Keep for
//    confirmations / short prompts.
//  • variant="panel" — a right-side slide-in "layer", the SAME mechanic as the
//    job-detail card: anchored to the right, full-height (top/bottom inset),
//    slides in from the right, scrolls as one. This is the target for forms.
// `DialogSize` is imported from ./overlayLayout (the lower layer that also owns the
// close-anchoring math) so the panel width and the close-× anchor never drift.
const DIALOG_SIZE: Record<DialogSize, string> = {
    sm: "md:max-w-md",
    default: "md:max-w-lg",
    wide: "md:max-w-3xl",
    full: "md:max-w-5xl md:max-h-[92vh] md:overflow-y-auto",
}
// Right-side panel widths. Standard forms use --blanc-layer-width — the SAME width as
// the job/lead/estimate VIEW card (FloatingDetailPanel `wide`), so create- and view-
// layers are identical. Only heavy document editors (wide/full) get extra width.
const PANEL_WIDTH: Record<DialogSize, string> = {
    sm: "md:w-[var(--blanc-layer-width)]",
    default: "md:w-[var(--blanc-layer-width)]",
    wide: "md:w-[min(1020px,calc(100vw-100px))]",
    full: "md:w-[min(1320px,calc(100vw-72px))]",
}
// NB: the hover-reveal close's left-anchor math (was a local PANEL_CLOSE_RIGHT table)
// now lives in ./overlayLayout and is applied inside <OverlayClose variant="slideover">
// from the same `size` — single source of truth, so width and × anchor never drift.

const DialogContent = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { size?: DialogSize; variant?: "dialog" | "panel" }
>(({ className, children, size = "default", variant = "dialog", onInteractOutside, style, ...props }, ref) => {
    // ── Mobile → canonical bottom-sheet chrome (OVERLAY-CANON-002, Phase 2a) ──────
    // On mobile the `max-md:` classes already pin the content to the bottom, full-width,
    // rounded-top-22 + blancSlideUp — but that lacked the canon's GRAB HANDLE and
    // DRAG-TO-DISMISS, so dialogs felt different from a real <BottomSheet>. We add both,
    // WITHOUT replacing Radix: it keeps ownership of state / Esc / focus / portal.
    const isMobile = useIsMobile()
    // A hidden Radix <Close> we click to dismiss on a completed drag — this routes the
    // close through Radix's own onOpenChange(false), exactly like the corner × does, so
    // no call site needs an extra prop.
    const dragCloseRef = React.useRef<HTMLButtonElement>(null)
    // Reuse ONLY the pointer-drag logic from the shared hook. Radix already owns Esc /
    // focus-trap / scroll-lock / backdrop for dialogs, so every non-drag capability is
    // turned OFF here to avoid double-handling; the hook is used purely for its
    // dragHandlers + dragOffset + isDragging (offset → translateY, spring on release).
    const { dragHandlers, dragOffset, isDragging } = useOverlayDismiss({
        open: isMobile,
        onClose: () => dragCloseRef.current?.click(),
        esc: false,
        closeOnBackdrop: false,
        scrollLock: false,
        focusTrap: false,
        dragToDismiss: isMobile,
    })
    // While dragging: 1:1 finger tracking (no transition). On release: spring back — the
    // SAME mapping BottomSheet uses. Only applied on mobile; desktop style is untouched.
    const dragStyle: React.CSSProperties = isMobile
        ? {
            // Keep the transition present at REST (not only while offset>0) so an
            // under-threshold drag release springs back smoothly instead of jumping —
            // matching BottomSheet, which applies its transition unconditionally.
            transform: dragOffset > 0 ? `translateY(${dragOffset}px)` : undefined,
            transition: isDragging ? "none" : "transform 0.25s cubic-bezier(0.32, 0.72, 0, 1)",
        }
        : {}

    // ── Desktop card-stack (OVERLAY-CANON-002, Phase 3) ──────────────────────────
    // Radix's <DialogContent> is mounted ONLY while the dialog is open, so we register
    // it in the OverlayStack with a stable id and open=true for its whole mounted life.
    // This lets a Dialog-over-Dialog (e.g. the estimate/invoice item/summary editor over
    // its parent editor) OR a Dialog-over-FloatingDetailPanel take part in the depth math.
    // We DON'T route Esc/focus through useOverlayDismiss here — Radix owns those (and the
    // onInteractOutside nested-dialog guard below stays intact); this registration is
    // depth-only. When something is above THIS content on desktop, it slides left + dims.
    const dialogStackId = React.useId()
    const { depth, count } = useOverlayStack(dialogStackId, true)
    const layersAbove = Math.max(0, count - 1 - depth)
    const card = cardStackStyle(layersAbove, isMobile)
    // Compose the card-stack fragment onto the variant's BASE transform so it never
    // clobbers centering: a "dialog" is centered via translate(-50%,-50%) (a Tailwind
    // class → an inline transform would REPLACE it, so we re-state the centering here);
    // a "panel" has translate-x-0 at rest (nothing to preserve). Desktop only — on mobile
    // `card` is empty (top covers lower) and the mobile drag translateY owns the transform.
    const cardStyle: React.CSSProperties =
        !isMobile && card.transform
            ? {
                transform:
                    variant === "dialog"
                        ? `translate(-50%, -50%) ${card.transform}`
                        : card.transform,
                transformOrigin: card.transformOrigin,
                filter: card.filter,
                transition: card.transition,
            }
            : {}

    return (
    <DialogPortal>
        {/* Panel: no dimming scrim — the page stays visible behind it (job-card mechanic) */}
        <DialogOverlay className={variant === "panel" ? "bg-transparent" : undefined} />
        <DialogPrimitive.Content
            ref={ref}
            onInteractOutside={(event) => {
                // Keep this dialog open when the interaction comes from a STACKED
                // dialog or a popover/select/dropdown layer rendered above it.
                // Without this, closing a nested dialog (e.g. the estimate/invoice
                // "Summary" editor) dismisses its parent too — Radix treats the
                // click in the upper layer as "outside" the lower one.
                const target = (event.detail as { originalEvent?: Event })?.originalEvent?.target as HTMLElement | null
                if (target?.closest?.('[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]')) {
                    event.preventDefault()
                    return
                }
                onInteractOutside?.(event)
            }}
            className={cn(
                // z-[140] === OVERLAY_Z.modal (overlayLayout.ts) — literal class for the Tailwind JIT.
                "fixed z-[140] w-full border bg-[var(--blanc-panel-surface,#fffdf9)] shadow-lg duration-200",
                // Mobile: bottom-sheet — pinned to bottom, slides up (both variants). max-h caps at
                // content (like BottomSheet size="auto"); the internal region scrolls, not the sheet.
                "max-md:bottom-0 max-md:left-0 max-md:right-0 max-md:top-auto max-md:translate-x-0 max-md:translate-y-0 max-md:max-w-full max-md:max-h-[calc(100dvh-16px)] max-md:rounded-t-[22px] max-md:rounded-b-none max-md:animate-[blancSlideUp_0.25s_ease-out]",
                variant === "panel"
                    ? cn(
                        // Canon: column layout — pinned header + scrollable DialogBody + sticky footer.
                        // Surface is warm white so it (a) stands out from the beige page and
                        // (b) matches the fields — fields are delineated by border only, which
                        // lets the floating label notch the border with no colour seam.
                        "peer flex flex-col overflow-hidden bg-[var(--blanc-panel-surface,#fffdf9)]",
                        // Desktop: docked flush to the right edge, below the app header, full height —
                        // "glued to the edge, slid out from there" (same layer as the job-detail card).
                        "md:left-auto md:top-[var(--blanc-layer-top)] md:bottom-0 md:right-0 md:h-auto md:translate-x-0 md:translate-y-0 md:rounded-none md:rounded-tl-[24px] md:border-y-0 md:border-r-0 md:border-l md:border-[var(--blanc-line)] md:shadow-[-26px_0_70px_-28px_rgba(63,55,42,0.32)]",
                        PANEL_WIDTH[size],
                        "md:data-[state=open]:animate-[blancSlideInRight_0.24s_ease-out] md:data-[state=closed]:animate-out md:data-[state=closed]:fade-out-0 md:data-[state=closed]:slide-out-to-right-8",
                    )
                    : cn(
                        // Centered modal: padded grid; width by `size`
                        "grid gap-4 p-6 max-md:overflow-y-auto",
                        "md:left-[50%] md:top-[50%] md:translate-x-[-50%] md:translate-y-[-50%] md:rounded-lg",
                        DIALOG_SIZE[size],
                        "md:data-[state=open]:animate-in md:data-[state=closed]:animate-out md:data-[state=closed]:fade-out-0 md:data-[state=open]:fade-in-0 md:data-[state=closed]:zoom-out-95 md:data-[state=open]:zoom-in-95 md:data-[state=closed]:slide-out-to-left-1/2 md:data-[state=closed]:slide-out-to-top-[48%] md:data-[state=open]:slide-in-from-left-1/2 md:data-[state=open]:slide-in-from-top-[48%]",
                    ),
                className
            )}
            // Merge caller style + the DESKTOP card-stack (when a layer is above) + the
            // MOBILE drag translateY. These two are mutually exclusive by viewport
            // (cardStyle is {} on mobile, dragStyle is {} on desktop), so neither clobbers
            // the other's transform. Single desktop dialog with nothing above → both empty →
            // rendered style byte-identical to before Phase 3.
            style={{ ...style, ...cardStyle, ...dragStyle }}
            {...props}
        >
            {/* Mobile-only grab handle (same markup / tokens as BottomSheet's). It is the
                drag region: dragging it down past the hook's threshold clicks the hidden
                Close below → Radix onOpenChange(false). Absolutely pinned at the rounded top
                so it disturbs neither the centered grid nor the panel's flex column, and — being
                a separate strip above the scrollable body — dragging it never hijacks body scroll.
                md:hidden → desktop renders nothing here. */}
            {isMobile && (
                <div
                    {...dragHandlers}
                    aria-hidden
                    className="md:hidden absolute inset-x-0 top-0 z-[1] flex justify-center pt-[10px] pb-1"
                    style={{
                        cursor: "grab",
                        ...(dragHandlers as { style?: React.CSSProperties }).style,
                    }}
                >
                    <div
                        style={{
                            width: 40,
                            height: 4,
                            borderRadius: 999,
                            background: "var(--blanc-line-strong, rgba(97, 86, 71, 0.28))",
                        }}
                    />
                </div>
            )}
            {/* Hidden Radix close — the drag-dismiss target. Clicking it routes through
                Radix state exactly like the visible × does. */}
            <DialogPrimitive.Close ref={dragCloseRef} className="sr-only" aria-hidden tabIndex={-1} />
            {children}
            {/* Top-right inside × (OverlayClose `corner`) — centered dialogs always; for
                PANELS it's the MOBILE bottom-sheet only (md:hidden), since on desktop every
                panel uses the hover-left close below. Radix still owns the close via Close asChild. */}
            <DialogPrimitive.Close asChild>
                <OverlayClose variant="corner" className={variant === "panel" ? "md:hidden" : undefined} />
            </DialogPrimitive.Close>
        </DialogPrimitive.Content>
        {/* Every panel (any size), desktop: hover-reveal close to the LEFT of the layer — the
            single canonical close (OverlayClose `slideover`), identical to the FloatingDetailPanel
            view card. It MUST stay a sibling rendered AFTER the `peer` DialogContent above so the
            `peer-hover:*` reveal still fires; it anchors itself just outside the left edge from `size`.
            Radix still owns the close via Close asChild. */}
        {variant === "panel" && (
            <DialogPrimitive.Close asChild>
                <OverlayClose variant="slideover" size={size} />
            </DialogPrimitive.Close>
        )}
    </DialogPortal>
    )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

// ── Panel canon (MODAL-REDESIGN-001) ─────────────────────────────────────────
// Use inside <DialogContent variant="panel">: pinned header → scrollable body →
// sticky footer action bar. Only DialogBody scrolls.

const DialogPanelHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div
        className={cn("flex shrink-0 flex-col gap-1 px-6 pt-5 pb-4 pr-12", className)}
        {...props}
    />
)
DialogPanelHeader.displayName = "DialogPanelHeader"

// Scrollable region of a panel. Renders a soft top/bottom shadow ONLY when there
// is hidden content in that direction — so the pinned header/footer stay visually
// separated while scrolling, but the panel reads clean & borderless at rest (no
// static <hr>-style lines, per the Albusto design system).
const DialogBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ className, children, ...props }, forwardedRef) => {
        const innerRef = React.useRef<HTMLDivElement>(null)
        React.useImperativeHandle(forwardedRef, () => innerRef.current as HTMLDivElement)
        const [edge, setEdge] = React.useState({ top: false, bottom: false })

        React.useEffect(() => {
            const el = innerRef.current
            if (!el) return
            const update = () => {
                const top = el.scrollTop > 1
                const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1
                setEdge((p) => (p.top === top && p.bottom === bottom ? p : { top, bottom }))
            }
            update()
            el.addEventListener("scroll", update, { passive: true })
            const ro = new ResizeObserver(update)
            ro.observe(el)
            return () => {
                el.removeEventListener("scroll", update)
                ro.disconnect()
            }
        }, [])

        const boxShadow = [
            edge.top ? "inset 0 9px 8px -9px rgba(63,55,42,0.18)" : null,
            edge.bottom ? "inset 0 -9px 8px -9px rgba(63,55,42,0.18)" : null,
        ]
            .filter(Boolean)
            .join(", ")

        return (
            <div
                ref={innerRef}
                className={cn("flex-1 overflow-y-auto px-6 py-5", className)}
                style={boxShadow ? { boxShadow } : undefined}
                {...props}
            >
                {children}
            </div>
        )
    }
)
DialogBody.displayName = "DialogBody"

// Distinct, elevated action bar: lighter surface + top hairline + an upward shadow,
// so it reads as a pinned bar with content scrolling UNDER it (not blended in).
const DialogPanelFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div
        className={cn(
            "flex shrink-0 items-center justify-end gap-3 px-6 py-4 md:px-8",
            // Tinted (page-warm) bar against the white form body, plus an upward shadow,
            // so it reads as a grounded action tray with content scrolling under it.
            "border-t border-[var(--blanc-line)] bg-[var(--blanc-bg,#efe9df)]",
            "shadow-[0_-12px_28px_-20px_rgba(63,55,42,0.45)]",
            className
        )}
        {...props}
    />
)
DialogPanelFooter.displayName = "DialogPanelFooter"

const DialogHeader = ({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
    <div
        className={cn(
            "flex flex-col space-y-1.5 text-center sm:text-left",
            className
        )}
        {...props}
    />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
    <div
        className={cn(
            "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
            className
        )}
        {...props}
    />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Title>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Title
        ref={ref}
        className={cn(
            "text-lg font-semibold leading-none tracking-tight",
            className
        )}
        {...props}
    />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Description>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Description
        ref={ref}
        className={cn("text-sm text-muted-foreground", className)}
        {...props}
    />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
    Dialog,
    DialogPortal,
    DialogOverlay,
    DialogClose,
    DialogTrigger,
    DialogContent,
    DialogHeader,
    DialogFooter,
    DialogTitle,
    DialogDescription,
    DialogPanelHeader,
    DialogBody,
    DialogPanelFooter,
}
