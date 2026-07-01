/**
 * DropdownMenu — Radix menu on desktop, canonical mobile BottomSheet on mobile
 * (OVERLAY-CANON-002, Phase 2b).
 *
 * Public compound API UNCHANGED — call sites keep writing
 *   <DropdownMenu><DropdownMenuTrigger asChild>…</DropdownMenuTrigger>
 *     <DropdownMenuContent>
 *       <DropdownMenuLabel>…</DropdownMenuLabel>
 *       <DropdownMenuItem onClick|onSelect>…</DropdownMenuItem>
 *       <DropdownMenuSeparator/>
 *     </DropdownMenuContent></DropdownMenu>
 * and nothing else changes for them.
 *
 * Mechanism (context-based responsive wrapper):
 *   • ROOT (`DropdownMenu`) owns a CONTROLLED open state + publishes context
 *     `{ open, setOpen, isMobile, sheetTitle }`. Renders `DropdownMenuPrimitive.Root`
 *     controlled; honors a call site's `open`/`onOpenChange`/`defaultOpen` if present.
 *   • `DropdownMenuTrigger` stays the Radix trigger (both platforms), toggling that state.
 *   • `DropdownMenuContent`:
 *       – desktop → ORIGINAL Radix popper content, BYTE-IDENTICAL to before.
 *       – mobile  → <BottomSheet> holding the SAME children. Radix Content not rendered.
 *   • `DropdownMenuItem`:
 *       – desktop → Radix Item.
 *       – mobile  → a tappable sheet ROW (<button>) that runs the item's action
 *         (`onSelect` and/or `onClick` — both are honored, matching how call sites vary)
 *         then closes the sheet. `disabled` and the destructive item's className carry over.
 *   • `DropdownMenuLabel` → sheet section header on mobile; `DropdownMenuSeparator` → divider.
 *
 * A new OPTIONAL `sheetTitle` on the ROOT titles the mobile sheet; defaults to none, so
 * every existing call compiles untouched.
 */

import * as React from "react"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"
import { cn } from "../../lib/utils"
import { useIsMobile } from "../../hooks/useIsMobile"
import { BottomSheet } from "./BottomSheet"

interface DropdownCtx {
    open: boolean
    setOpen: (open: boolean) => void
    isMobile: boolean
    /** Title for the mobile BottomSheet header (optional — headerless when unset). */
    sheetTitle?: string
}

const DropdownContext = React.createContext<DropdownCtx | null>(null)

type DropdownRootProps = React.ComponentProps<typeof DropdownMenuPrimitive.Root> & {
    /** OPTIONAL — title shown on the mobile BottomSheet header. Default: none (headerless). */
    sheetTitle?: string
}

function DropdownMenu({
    open: openProp,
    defaultOpen,
    onOpenChange,
    sheetTitle,
    children,
    ...props
}: DropdownRootProps) {
    const isMobile = useIsMobile()

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

    const ctx = React.useMemo<DropdownCtx>(
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
        <DropdownContext.Provider value={ctx}>
            <DropdownMenuPrimitive.Root {...radixOpenProps} {...props}>
                {children}
            </DropdownMenuPrimitive.Root>
        </DropdownContext.Provider>
    )
}

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
const DropdownMenuGroup = DropdownMenuPrimitive.Group

const DropdownMenuContent = React.forwardRef<
    React.ElementRef<typeof DropdownMenuPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, children, ...props }, ref) => {
    const ctx = React.useContext(DropdownContext)

    // Mobile → canonical BottomSheet with the SAME children (Items become sheet rows).
    if (ctx?.isMobile) {
        return (
            <BottomSheet
                open={ctx.open}
                onClose={() => ctx.setOpen(false)}
                title={ctx.sheetTitle}
                size="auto"
            >
                <div className="flex flex-col gap-0.5 py-1">{children}</div>
            </BottomSheet>
        )
    }

    // Desktop → ORIGINAL Radix popper content (byte-identical).
    return (
        <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
                ref={ref}
                sideOffset={sideOffset}
                className={cn(
                    // z-[150] === OVERLAY_Z.dropdown (overlayLayout.ts), above modal(140) by design.
                    "z-[150] min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
                    "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
                    className
                )}
                {...props}
            >
                {children}
            </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
    )
})
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName

type DropdownItemProps = React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean
}

const DropdownMenuItem = React.forwardRef<
    React.ElementRef<typeof DropdownMenuPrimitive.Item>,
    DropdownItemProps
>(({ className, inset, children, onSelect, onClick, disabled, asChild, ...props }, ref) => {
    const ctx = React.useContext(DropdownContext)

    // Mobile → tappable sheet row. Fire whatever action the call site wired
    // (onSelect and/or onClick — both patterns exist in the codebase), then close.
    if (ctx?.isMobile) {
        const handleTap = (event: React.MouseEvent) => {
            if (disabled) return
            // onSelect's native type is (e: Event); pass the underlying nativeEvent.
            onSelect?.(event.nativeEvent)
            // Radix Item's onClick is typed for a <div>; our row is a <button>. The event
            // shape is compatible — call sites only read currentTarget/preventDefault — so
            // forward it with a cast rather than fabricating a synthetic div event.
            onClick?.(event as unknown as React.MouseEvent<HTMLDivElement>)
            ctx.setOpen(false)
        }
        const rowClassName = cn(
            "relative flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm outline-none transition-colors",
            "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
            "disabled:pointer-events-none disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0",
            inset && "pl-8",
            className
        )
        // asChild (e.g. <a href="tel:">): clone the child and wire the tap onto IT, rather
        // than nesting it inside a <button> (invalid interactive nesting) as a plain wrap would.
        if (asChild && React.isValidElement(children)) {
            const child = children as React.ReactElement<{ className?: string; onClick?: React.MouseEventHandler }>
            return React.cloneElement(child, {
                "data-slot": "dropdown-menu-item",
                className: cn(rowClassName, child.props.className),
                onClick: (e: React.MouseEvent) => { child.props.onClick?.(e); handleTap(e) },
            } as Record<string, unknown>)
        }
        return (
            <button
                type="button"
                disabled={disabled}
                data-slot="dropdown-menu-item"
                onClick={handleTap}
                className={rowClassName}
            >
                {children}
            </button>
        )
    }

    // Desktop → Radix Item (byte-identical).
    return (
        <DropdownMenuPrimitive.Item
            ref={ref}
            asChild={asChild}
            onSelect={onSelect}
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0",
                inset && "pl-8",
                className
            )}
            {...props}
        >
            {children}
        </DropdownMenuPrimitive.Item>
    )
})
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName

const DropdownMenuSeparator = React.forwardRef<
    React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
    React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => {
    const ctx = React.useContext(DropdownContext)

    if (ctx?.isMobile) {
        // Sheet divider — same visual weight as the desktop separator.
        return <div className={cn("-mx-1 my-1 h-px bg-muted", className)} />
    }

    return (
        <DropdownMenuPrimitive.Separator
            ref={ref}
            className={cn("-mx-1 my-1 h-px bg-muted", className)}
            {...props}
        />
    )
})
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName

const DropdownMenuLabel = React.forwardRef<
    React.ElementRef<typeof DropdownMenuPrimitive.Label>,
    React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
        inset?: boolean
    }
>(({ className, inset, children, ...props }, ref) => {
    const ctx = React.useContext(DropdownContext)

    if (ctx?.isMobile) {
        // Sheet section header.
        return (
            <div
                className={cn(
                    "px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground",
                    inset && "pl-8",
                    className
                )}
            >
                {children}
            </div>
        )
    }

    return (
        <DropdownMenuPrimitive.Label
            ref={ref}
            className={cn("px-2 py-1.5 text-sm font-semibold", inset && "pl-8", className)}
            {...props}
        >
            {children}
        </DropdownMenuPrimitive.Label>
    )
})
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName

export {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuLabel,
    DropdownMenuGroup,
}
