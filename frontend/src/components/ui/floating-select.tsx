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
 * Floating-label select (Albusto canon): same look as FloatingField — 50px, border-only,
 * the label sits as a placeholder and lifts onto the border once a value is chosen.
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
                        "h-[50px] w-full rounded-xl border-[1.5px] bg-transparent px-3.5 text-[15px] data-[size=default]:h-[50px]",
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
