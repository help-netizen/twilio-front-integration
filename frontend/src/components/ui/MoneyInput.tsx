import { forwardRef } from 'react';

interface MoneyInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
    /** Dollar string, e.g. "10.70". Empty/invalid renders as 0.00. */
    value: string;
    /** Fires with the next dollar string, always in fixed 0.00 form. */
    onValueChange: (dollars: string) => void;
    /** Keystrokes that would exceed this are ignored (default $999,999.99). */
    maxCents?: number;
}

function toCents(value: string): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

/**
 * Call-site variant of the same cents-first mask for fields that must keep
 * their own input primitive (e.g. FloatingField). Returns the next masked
 * dollar string, '' when cleared, or null when the keystroke must be ignored
 * (overflow) — the caller keeps the previous value in that case.
 */
export function maskMoneyDigits(raw: string, maxCents = 99_999_999): string | null {
    const digits = raw.replace(/\D/g, '');
    if (digits === '') return '';
    const next = Number(digits);
    if (!Number.isFinite(next) || next > maxCents) return null;
    return (next / 100).toFixed(2);
}

/**
 * Money entry canon (owner directive 2026-07-23, OB-24): calculator-style
 * cents-first mask. The field always shows 0.00 and digits shift left as you
 * type — 1 → 0.01, 5 → 0.15, 2 → 1.52; Backspace pops the last digit. No
 * native number spinners (arrows/scroll silently change amounts). Implemented
 * by reducing the input to its digits = integer cents, so paste and deletes
 * degrade sanely and the caret stays pinned to the end.
 */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
    { value, onValueChange, maxCents = 99_999_999, ...rest }, ref,
) {
    const cents = toCents(value);
    return (
        <input
            ref={ref}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={(cents / 100).toFixed(2)}
            onChange={event => {
                const digits = event.target.value.replace(/\D/g, '');
                const next = Number(digits || '0');
                if (!Number.isFinite(next) || next > maxCents) return; // swallow overflow
                onValueChange((next / 100).toFixed(2));
            }}
            onFocus={event => {
                const el = event.currentTarget;
                requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
            }}
            {...rest}
        />
    );
});
