import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import { cn } from "../../lib/utils"

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
type DialogSize = "sm" | "default" | "wide" | "full"
const DIALOG_SIZE: Record<DialogSize, string> = {
    sm: "md:max-w-md",
    default: "md:max-w-lg",
    wide: "md:max-w-3xl",
    full: "md:max-w-5xl md:max-h-[92vh] md:overflow-y-auto",
}
// Right-side panel widths (MODAL-REDESIGN-001 canon). Forms are single-column,
// Docked to the right edge, so width is generous (~2/3 of the screen for a normal
// form) — that room is what lets labels sit beside fields and controls breathe.
const PANEL_WIDTH: Record<DialogSize, string> = {
    sm: "md:w-[min(680px,94vw)]",
    default: "md:w-[clamp(760px,74vw,1280px)]",
    wide: "md:w-[clamp(900px,82vw,1400px)]",
    full: "md:w-[min(1500px,92vw)]",
}

const DialogContent = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { size?: DialogSize; variant?: "dialog" | "panel" }
>(({ className, children, size = "default", variant = "dialog", ...props }, ref) => (
    <DialogPortal>
        {/* Panel: no dimming scrim — the page stays visible behind it (job-card mechanic) */}
        <DialogOverlay className={variant === "panel" ? "bg-transparent" : undefined} />
        <DialogPrimitive.Content
            ref={ref}
            className={cn(
                "fixed z-[140] w-full border bg-[var(--blanc-panel-surface,#fffdf9)] shadow-lg duration-200",
                // Mobile: bottom-sheet — pinned to bottom, slides up (both variants)
                "max-md:bottom-0 max-md:left-0 max-md:right-0 max-md:top-auto max-md:translate-x-0 max-md:translate-y-0 max-md:max-w-full max-md:max-h-[calc(100dvh-16px)] max-md:rounded-t-[22px] max-md:rounded-b-none max-md:animate-[blancSlideUp_0.25s_ease-out]",
                variant === "panel"
                    ? cn(
                        // Canon: column layout — pinned header + scrollable DialogBody + sticky footer.
                        // Surface is warm white so it (a) stands out from the beige page and
                        // (b) matches the fields — fields are delineated by border only, which
                        // lets the floating label notch the border with no colour seam.
                        "flex flex-col overflow-hidden bg-[var(--blanc-panel-surface,#fffdf9)]",
                        // Desktop: docked flush to the right edge, below the app header, full height —
                        // "glued to the edge, slid out from there" (like the job-detail card), no scrim.
                        "md:left-auto md:top-[60px] md:bottom-0 md:right-0 md:h-auto md:translate-x-0 md:translate-y-0 md:rounded-none md:rounded-tl-[24px] md:border-y-0 md:border-r-0 md:border-l md:border-[var(--blanc-line)] md:shadow-[-26px_0_70px_-28px_rgba(63,55,42,0.32)]",
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
            {...props}
        >
            {children}
            <DialogPrimitive.Close className="absolute right-4 top-[18px] rounded-md p-1 opacity-60 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
        </DialogPrimitive.Content>
    </DialogPortal>
))
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
// static <hr>-style lines, per the Blanc design system).
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
