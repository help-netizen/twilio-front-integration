import { useState, useCallback } from 'react';
import { Input } from './input';

// ── Utilities ────────────────────────────────────────────────────────────────

/** Strip everything except digits */
function digitsOnly(value: string): string {
    return value.replace(/\D/g, '');
}

/**
 * Normalise to E.164 for storage:  +1XXXXXXXXXX
 * Accepts both 10-digit (without country code) and 11-digit (with leading 1).
 * For anything else returns the raw digits prefixed with +.
 */
export function toE164(raw: string): string {
    const d = digitsOnly(raw);
    if (d.length === 10) return `+1${d}`;
    if (d.length === 11 && d[0] === '1') return `+${d}`;
    // non-standard — just prefix with +
    return d.length > 0 ? `+${d}` : '';
}

/**
 * Format raw digits for display:
 *   10 digits → +1 (XXX) XXX-XXXX
 *   11 digits starting with 1 → +1 (XXX) XXX-XXXX
 *   fewer digits → partial format as you type
 */
function formatDigits(digits: string): string {
    let d = digits;
    // Strip leading country code 1 for uniform handling
    if (d.length >= 11 && d[0] === '1') d = d.slice(1);
    if (d.length > 10) d = d.slice(0, 10);

    if (d.length === 0) return '';
    if (d.length <= 3) return `+1 (${d}`;
    if (d.length <= 6) return `+1 (${d.slice(0, 3)}) ${d.slice(3)}`;
    return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/**
 * Format any phone string (E.164, raw digits, or already-formatted) for display.
 */
export function formatUSPhone(raw: string): string {
    return formatDigits(digitsOnly(raw));
}

/** Check if the phone has exactly 10 digits (or 11 starting with 1) */
export function isValidUSPhone(raw: string): boolean {
    const d = digitsOnly(raw);
    return d.length === 10 || (d.length === 11 && d[0] === '1');
}

// ── Component ────────────────────────────────────────────────────────────────

interface PhoneInputProps {
    id?: string;
    /** Controlled value — can be E.164, formatted, or raw digits */
    value: string;
    /** Called with display-formatted value */
    onChange: (formatted: string) => void;
    placeholder?: string;
    required?: boolean;
    disabled?: boolean;
    className?: string;
}

/**
 * Phone input that auto-formats US numbers as +1 (XXX) XXX-XXXX.
 *
 * Internally we track only the *digits* the user has entered (without
 * the US country-code "1" that we add ourselves).  The parent's
 * `value` is always re-parsed to digits on render so there is no
 * double-formatting loop.
 */
export function PhoneInput({
    id,
    value,
    onChange,
    placeholder = '+1 (___) ___-____',
    required,
    disabled,
    className,
}: PhoneInputProps) {
    const [focused, setFocused] = useState(false);

    // Always derive digits & display from the canonical value
    const allDigits = digitsOnly(value);
    // Strip the leading country-code 1 so we only count the local 10 digits
    const localDigits = (allDigits.length >= 11 && allDigits[0] === '1')
        ? allDigits.slice(1)
        : (allDigits[0] === '1' && allDigits.length === 11) ? allDigits.slice(1) : allDigits;
    const displayValue = formatDigits(allDigits);

    const valid = isValidUSPhone(value);
    const hasDigits = allDigits.length > 0;
    const showWarning = focused && hasDigits && !valid;

    const handleChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            // Extract only digits from whatever the user typed / pasted
            const raw = e.target.value;
            const d = digitsOnly(raw);
            // Format and send up
            onChange(formatDigits(d));
        },
        [onChange],
    );

    return (
        <div className="phone-input-wrapper" style={{ position: 'relative' }}>
            <Input
                id={id}
                type="tel"
                value={displayValue}
                onChange={handleChange}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder={placeholder}
                required={required}
                disabled={disabled}
                className={className}
                style={
                    showWarning
                        ? { borderColor: '#d97706', boxShadow: '0 0 0 2px rgba(217,119,6,0.2)' }
                        : undefined
                }
            />
            {showWarning && (
                <div
                    style={{
                        position: 'absolute',
                        top: '100%',
                        left: 0,
                        right: 0,
                        marginTop: 4,
                        padding: '6px 10px',
                        fontSize: 11,
                        lineHeight: 1.3,
                        color: '#92400e',
                        background: '#fef3c7',
                        border: '1px solid #fde68a',
                        borderRadius: 6,
                        zIndex: 10,
                    }}
                >
                    This phone number looks incomplete. If it is correct, you may proceed.
                </div>
            )}
        </div>
    );
}
