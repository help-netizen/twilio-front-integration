import * as React from "react"
import { Select, SelectContent, SelectTrigger, SelectValue } from "./select"
import { FloatingLabel } from "./floating-field"
import { cn } from "../../lib/utils"

interface FloatingSelectProps {
    label: string
    value?: string
    onValueChange?: (value: string) => void
    /** <SelectItem> children */
    children: React.ReactNode
    id?: string
    disabled?: boolean
    className?: string
    triggerClassName?: string
}

/**
 * Floating-label select (Albusto canon, PALETTE-V2 filled): same look as FloatingField —
 * 50px filled field (fill painted by the FloatingLabel wrapper), transparent border, the
 * label sits as a placeholder and lifts to the top of the fill once a value is chosen.
 * The value zone is padded down to clear the floated label; the chevron gets a negative
 * top margin so it stays optically centered in the 50px box despite the asymmetric
 * padding. Focus = `--blanc-line-strong` border (ring suppressed to match the canon).
 */
function FloatingSelect({
    label, value, onValueChange, children, id, disabled, className, triggerClassName,
}: FloatingSelectProps) {
    return (
        <FloatingLabel label={label} htmlFor={id} filled={!!value} className={className}>
            <Select value={value} onValueChange={onValueChange} disabled={disabled}>
                <SelectTrigger
                    id={id}
                    className={cn(
                        "h-[50px] w-full rounded-xl border-[1.5px] border-transparent bg-transparent px-3.5 pt-[22px] pb-[6px] text-[15px] data-[size=default]:h-[50px]",
                        "focus-visible:border-[var(--blanc-line-strong)] focus-visible:ring-0",
                        "[&>svg]:-mt-3",
                        triggerClassName,
                    )}
                >
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>{children}</SelectContent>
            </Select>
        </FloatingLabel>
    )
}

export { FloatingSelect }
