import * as React from "react"
import { cn } from "../../lib/utils"

interface FloatingFieldProps {
    label: string
    id?: string
    value?: string
    onChange?: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void
    type?: string
    /** Render a multi-line textarea instead of a single-line input. */
    textarea?: boolean
    rows?: number
    className?: string
    containerClassName?: string
    disabled?: boolean
    name?: string
    inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"]
    onBlur?: React.FocusEventHandler<HTMLInputElement | HTMLTextAreaElement>
    onFocus?: React.FocusEventHandler<HTMLInputElement | HTMLTextAreaElement>
    onKeyDown?: React.KeyboardEventHandler<HTMLInputElement | HTMLTextAreaElement>
}

/**
 * Floating-label field (Albusto canon): the label starts as the placeholder inside
 * the field and lifts to sit on the top border on focus or when filled — so a form
 * needs no separate stacked/side labels. The label's background matches the field
 * so it cleanly notches the border.
 *
 * CSS-only via the `:placeholder-shown` peer trick (the real placeholder is a single
 * hidden space) — no JS state, works with controlled inputs.
 */
function FloatingField({
    label, id, textarea, rows = 3, className, containerClassName,
    onBlur, onFocus, onKeyDown, ...field
}: FloatingFieldProps) {
    const reactId = React.useId()
    const fieldId = id || reactId

    // Field shares the panel's surface colour — delineated by border only.
    const fieldBase =
        "peer w-full rounded-xl border-[1.5px] border-input bg-transparent text-[15px] font-medium text-[var(--blanc-ink-1)] outline-none transition-colors placeholder:text-transparent focus:border-ring disabled:cursor-not-allowed disabled:opacity-50"

    // As a placeholder (centered, over the field) the label is transparent; once floated
    // onto the TOP BORDER it takes the SAME surface colour as the field/panel, so it reads
    // as a clean gap in the outline — no colour seam, no brick.
    const labelBase =
        "pointer-events-none absolute left-3 z-10 px-1 bg-transparent font-normal text-[var(--blanc-ink-3)] transition-all duration-150 peer-focus:bg-[var(--blanc-panel-surface,#fffdf9)] peer-focus:text-[var(--blanc-ink-2)] peer-[:not(:placeholder-shown)]:bg-[var(--blanc-panel-surface,#fffdf9)]"

    if (textarea) {
        return (
            <div className={cn("relative", containerClassName)}>
                <textarea
                    id={fieldId}
                    placeholder=" "
                    autoComplete="off"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    rows={rows}
                    className={cn(fieldBase, "block resize-none px-3.5 pb-2.5 pt-3.5 leading-relaxed", className)}
                    onBlur={onBlur}
                    onFocus={onFocus}
                    onKeyDown={onKeyDown}
                    {...field}
                />
                <label
                    htmlFor={fieldId}
                    className={cn(
                        labelBase,
                        "top-3.5 text-[15px]",
                        "peer-focus:-top-[9px] peer-focus:text-[11px]",
                        "peer-[:not(:placeholder-shown)]:-top-[9px] peer-[:not(:placeholder-shown)]:text-[11px]",
                    )}
                >
                    {label}
                </label>
            </div>
        )
    }

    return (
        <div className={cn("relative", containerClassName)}>
            <input
                id={fieldId}
                placeholder=" "
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                className={cn(fieldBase, "h-[50px] px-3.5", className)}
                onBlur={onBlur}
                onFocus={onFocus}
                onKeyDown={onKeyDown}
                {...field}
            />
            <label
                htmlFor={fieldId}
                className={cn(
                    labelBase,
                    "top-1/2 -translate-y-1/2 text-[15px]",
                    "peer-focus:top-0 peer-focus:text-[11px]",
                    "peer-[:not(:placeholder-shown)]:top-0 peer-[:not(:placeholder-shown)]:text-[11px]",
                )}
            >
                {label}
            </label>
        </div>
    )
}

/**
 * Generic floating-label wrapper for controls that can't use the `:placeholder-shown`
 * trick (Radix Select, PhoneInput, money inputs, anything custom). The label floats when
 * the control is focused (`focus-within`) OR when `filled` is true. Style the inner
 * control border-only + transparent bg, with no visible placeholder of its own.
 */
function FloatingLabel({
    label, htmlFor, filled, className, children,
}: {
    label: string; htmlFor?: string; filled?: boolean; className?: string; children: React.ReactNode;
}) {
    return (
        <div className={cn("group relative", className)} data-filled={filled ? "true" : undefined}>
            {children}
            <label
                htmlFor={htmlFor}
                className={cn(
                    "pointer-events-none absolute left-3 z-10 px-1 font-normal text-[var(--blanc-ink-3)] transition-all duration-150",
                    "top-1/2 -translate-y-1/2 text-[15px]",
                    "group-focus-within:top-0 group-focus-within:text-[11px] group-focus-within:text-[var(--blanc-ink-2)] group-focus-within:bg-[var(--blanc-panel-surface,#fffdf9)]",
                    "group-data-[filled=true]:top-0 group-data-[filled=true]:text-[11px] group-data-[filled=true]:text-[var(--blanc-ink-2)] group-data-[filled=true]:bg-[var(--blanc-panel-surface,#fffdf9)]",
                )}
            >
                {label}
            </label>
        </div>
    )
}

export { FloatingField, FloatingLabel }
