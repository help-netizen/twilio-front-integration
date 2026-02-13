import { useState, useCallback, useRef, useEffect } from 'react';
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
 * Format for display:
 *   10 digits → +1 (XXX) XXX-XXXX
 *   11 digits starting with 1 → +1 (XXX) XXX-XXXX
 *   incomplete → partial format as you type
 */
export function formatUSPhone(raw: string): string {
    let d = digitsOnly(raw);
    // Strip leading 1 for uniform handling
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length > 10) d = d.slice(0, 10);

    if (d.length === 0) return '';
    if (d.length <= 3) return `+1 (${d}`;
    if (d.length <= 6) return `+1 (${d.slice(0, 3)}) ${d.slice(3)}`;
    return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
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
    /** Called with E.164 value (for API/DB) — optional optimisation */
    onChangeE164?: (e164: string) => void;
    placeholder?: string;
    required?: boolean;
    disabled?: boolean;
    className?: string;
}

export function PhoneInput({
    id,
    value,
    onChange,
    onChangeE164,
    placeholder = '+1 (___) ___-____',
    required,
    disabled,
    className,
}: PhoneInputProps) {
    const [focused, setFocused] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const valid = isValidUSPhone(value);
    const hasDigits = digitsOnly(value).length > 0;
    const showWarning = focused && hasDigits && !valid;

    // Format the display value
    const displayValue = formatUSPhone(value);

    const handleChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const raw = e.target.value;
            const formatted = formatUSPhone(raw);
            onChange(formatted);
            onChangeE164?.(toE164(raw));
        },
        [onChange, onChangeE164],
    );

    // On blur, also format (in case user pastes something odd)
    const handleBlur = useCallback(() => {
        setFocused(false);
        // Re-format on blur
        const formatted = formatUSPhone(value);
        if (formatted !== value) {
            onChange(formatted);
        }
    }, [value, onChange]);

    // Preserve cursor position after formatting
    useEffect(() => {
        const el = inputRef.current;
        if (!el || !focused) return;
        // Move cursor to end after format
        const len = displayValue.length;
        requestAnimationFrame(() => {
            el.setSelectionRange(len, len);
        });
    }, [displayValue, focused]);

    return (
        <div className="phone-input-wrapper" style={{ position: 'relative' }}>
            <Input
                ref={inputRef}
                id={id}
                type="tel"
                value={displayValue}
                onChange={handleChange}
                onFocus={() => setFocused(true)}
                onBlur={handleBlur}
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
