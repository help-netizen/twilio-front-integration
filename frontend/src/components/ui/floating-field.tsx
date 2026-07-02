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
 * Floating-label field (Albusto canon, PALETTE-V2 filled/«Т2»): the field is a flat
 * fill (`--blanc-field`) with a transparent border (same width, so geometry never
 * shifts). The label starts as the placeholder centered inside the fill and, on focus
 * or when filled, floats to the TOP of the fill (inside the field, ~6px down) — no
 * background patch needed since there is no border to notch. The value gets top
 * padding so it never collides with the floated label; total field height unchanged.
 * Focus = `--blanc-line-strong` border appearing on the transparent border.
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

    // Filled canon: fill + transparent border (border kept for stable geometry + focus).
    const fieldBase =
        "peer w-full rounded-xl border-[1.5px] border-transparent bg-[var(--blanc-field,#F0F0F0)] text-[15px] font-medium text-[var(--blanc-ink-1)] outline-none transition-colors placeholder:text-transparent focus:border-[var(--blanc-line-strong)] disabled:cursor-not-allowed disabled:opacity-50"

    // Label lives INSIDE the fill: centered as a placeholder at rest, pinned to the
    // top of the fill when floated. No background — nothing to patch over.
    const labelBase =
        "pointer-events-none absolute left-3 z-10 px-1 font-normal text-[var(--blanc-ink-3)] transition-all duration-150"

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
                    className={cn(fieldBase, "block resize-none px-3.5 pt-5 pb-1 leading-relaxed", className)}
                    onBlur={onBlur}
                    onFocus={onFocus}
                    onKeyDown={onKeyDown}
                    {...field}
                />
                <label
                    htmlFor={fieldId}
                    className={cn(
                        labelBase,
                        "top-5 text-[15px]",
                        "peer-focus:top-[6px] peer-focus:text-[11px]",
                        "peer-[:not(:placeholder-shown)]:top-[6px] peer-[:not(:placeholder-shown)]:text-[11px]",
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
                className={cn(fieldBase, "h-[50px] px-3.5 pt-[18px] pb-[6px]", className)}
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
                    "peer-focus:top-[6px] peer-focus:translate-y-0 peer-focus:text-[11px]",
                    "peer-[:not(:placeholder-shown)]:top-[6px] peer-[:not(:placeholder-shown)]:translate-y-0 peer-[:not(:placeholder-shown)]:text-[11px]",
                )}
            >
                {label}
            </label>
        </div>
    )
}

/**
 * Generic floating-label wrapper for controls that can't use the `:placeholder-shown`
 * trick (Radix Select, PhoneInput, money inputs, anything custom). The label floats to
 * the top of the fill when the control is focused (`focus-within`) OR when `filled` is
 * true. Filled canon (PALETTE-V2): the WRAPPER paints the field fill (`--blanc-field`),
 * so style the inner control transparent-bg with a transparent border and no visible
 * placeholder of its own. The wrapper also neutralizes any legacy `border-input` on a
 * wrapped <input> and pads its value zone ([&_input] rules — higher specificity than
 * the control's own single-class utilities, while focus/invalid variants still win),
 * so pre-canon call sites render filled without edits.
 */
function FloatingLabel({
    label, htmlFor, filled, className, children,
}: {
    label: string; htmlFor?: string; filled?: boolean; className?: string; children: React.ReactNode;
}) {
    return (
        <div
            className={cn(
                "group relative rounded-xl bg-[var(--blanc-field,#F0F0F0)]",
                "[&_input]:border-transparent [&_input]:pt-[18px] [&_input]:pb-[6px]",
                className,
            )}
            data-filled={filled ? "true" : undefined}
        >
            {children}
            <label
                htmlFor={htmlFor}
                className={cn(
                    "pointer-events-none absolute left-3 z-10 px-1 font-normal text-[var(--blanc-ink-3)] transition-all duration-150",
                    "top-1/2 -translate-y-1/2 text-[15px]",
                    "group-focus-within:top-[6px] group-focus-within:translate-y-0 group-focus-within:text-[11px]",
                    "group-data-[filled=true]:top-[6px] group-data-[filled=true]:translate-y-0 group-data-[filled=true]:text-[11px]",
                )}
            >
                {label}
            </label>
        </div>
    )
}

export { FloatingField, FloatingLabel }
