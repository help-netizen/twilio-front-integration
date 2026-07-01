/**
 * Popover — Radix popover on desktop, canonical mobile BottomSheet on mobile
 * (OVERLAY-CANON-002, Phase 2b).
 *
 * The public compound API is UNCHANGED — call sites keep writing
 *   <Popover open? onOpenChange?><PopoverTrigger asChild>…</PopoverTrigger>
 *   <PopoverContent>…arbitrary children…</PopoverContent></Popover>
 * and nothing else changes for them.
 *
 * Mechanism (context-based responsive wrapper):
 *   • The ROOT (`Popover`) owns a CONTROLLED open state and publishes a small context
 *     `{ open, setOpen, isMobile, sheetTitle }`. It renders `PopoverPrimitive.Root`
 *     controlled (open / onOpenChange), so the Radix trigger + positioning are unchanged
 *     on desktop. If a call site passes `open`/`onOpenChange` (controlled Popover) or
 *     `defaultOpen`, we honor it; otherwise we self-manage.
 *   • `PopoverTrigger` stays the Radix trigger on both platforms — it toggles the same
 *     controlled open state (Radix drives onOpenChange → our setOpen).
 *   • `PopoverContent`:
 *       – desktop → the ORIGINAL Radix popper content, BYTE-IDENTICAL to before.
 *       – mobile  → a <BottomSheet open onClose title> holding the SAME children. The
 *         Radix Content is NOT rendered on mobile; the sheet owns display + dismissal.
 *
 * Popover has no item semantics — children are arbitrary — so mobile is just "same
 * children inside the canonical sheet". A new OPTIONAL `sheetTitle` on the ROOT lets a
 * call site title the mobile sheet; it defaults to undefined (headerless sheet), so
 * every existing call compiles untouched.
 */

import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { cn } from "../../lib/utils"
import { useIsMobile } from "../../hooks/useIsMobile"
import { BottomSheet } from "./BottomSheet"

interface PopoverCtx {
    open: boolean
    setOpen: (open: boolean) => void
    isMobile: boolean
    /** Title for the mobile BottomSheet (optional — headerless when unset). */
    sheetTitle?: string
}

const PopoverContext = React.createContext<PopoverCtx | null>(null)

type PopoverRootProps = React.ComponentProps<typeof PopoverPrimitive.Root> & {
    /** OPTIONAL — title shown on the mobile BottomSheet header. Default: none (headerless). */
    sheetTitle?: string
}

function Popover({
    open: openProp,
    defaultOpen,
    onOpenChange,
    sheetTitle,
    children,
    ...props
}: PopoverRootProps) {
    const isMobile = useIsMobile()

    // Controlled if the call site drives `open`; else self-manage (seeded by defaultOpen).
    const isControlled = openProp !== undefined
    const [uncontrolledOpen, setUncontrolledOpen] = React.useState<boolean>(!!defaultOpen)
    const open = isControlled ? !!openProp : uncontrolledOpen

    const setOpen = React.useCallback(
        (next: boolean) => {
            if (!isControlled) setUncontrolledOpen(next)
            onOpenChange?.(next)
        },
        [isControlled, onOpenChange],
    )

    const ctx = React.useMemo<PopoverCtx>(
        () => ({ open, setOpen, isMobile, sheetTitle }),
        [open, setOpen, isMobile, sheetTitle],
    )

    // DESKTOP: forward open/defaultOpen/onOpenChange EXACTLY as given (controlled OR
    // uncontrolled) so Radix behaves byte-identically to the pre-wrapper re-export.
    // MOBILE: drive Radix controlled by our mirrored open so trigger taps open the sheet.
    const radixOpenProps = isMobile
        ? { open, onOpenChange: setOpen }
        : { open: openProp, defaultOpen, onOpenChange }

    return (
        <PopoverContext.Provider value={ctx}>
            <PopoverPrimitive.Root {...radixOpenProps} {...props}>
                {children}
            </PopoverPrimitive.Root>
        </PopoverContext.Provider>
    )
}

const PopoverTrigger = PopoverPrimitive.Trigger
const PopoverAnchor = PopoverPrimitive.Anchor

const PopoverContent = React.forwardRef<
    React.ElementRef<typeof PopoverPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, children, ...props }, ref) => {
    const ctx = React.useContext(PopoverContext)

    // Mobile → canonical BottomSheet with the SAME children. Radix Content not rendered.
    if (ctx?.isMobile) {
        return (
            <BottomSheet
                open={ctx.open}
                onClose={() => ctx.setOpen(false)}
                title={ctx.sheetTitle}
                size="auto"
            >
                {children}
            </BottomSheet>
        )
    }

    // Desktop → ORIGINAL Radix popper content (byte-identical to pre-Phase-2b).
    return (
        <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content
                ref={ref}
                align={align}
                sideOffset={sideOffset}
                className={cn(
                    // z-[150] === OVERLAY_Z.dropdown (overlayLayout.ts), above modal(140) by design.
                    "z-[150] w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
                    className
                )}
                {...props}
            >
                {children}
            </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
    )
})
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
