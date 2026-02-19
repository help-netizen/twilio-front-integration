import { useState, useCallback } from 'react';
import { Input } from './input';

// ── Utilities ────────────────────────────────────────────────────────────────

/** Strip everything except digits */
function digitsOnly(value: string): string {
    return value.replace(/\D/g, '');
}

/**
 * Normalise to E.164 for storage:  +1XXXXXXXXXX
 * Only applied on save — never during typing.
 */
export function toE164(raw: string): string {
    const d = digitsOnly(raw);
    if (d.length === 10) return `+1${d}`;
    if (d.length === 11 && d[0] === '1') return `+${d}`;
    return d.length > 0 ? `+${d}` : '';
}

/**
 * Format digits for display: (XXX) XXX-XXXX
 * No country code prefix — shown raw as user types.
 */
function formatDigits(digits: string): string {
    let d = digits;
    // If user pasted/loaded with leading country code 1, strip it
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length > 10) d = d.slice(0, 10);

    if (d.length === 0) return '';
    if (d.length <= 3) return `(${d}`;
    if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/**
 * Format any phone string for display.
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
    value: string;
    onChange: (formatted: string) => void;
    onBlur?: () => void;
    placeholder?: string;
    required?: boolean;
    disabled?: boolean;
    className?: string;
}

export function PhoneInput({
    id,
    value,
    onChange,
    onBlur,
    placeholder = '(___) ___-____',
    required,
    disabled,
    className,
}: PhoneInputProps) {
    const [focused, setFocused] = useState(false);

    const allDigits = digitsOnly(value);
    const displayValue = formatDigits(allDigits);

    const valid = isValidUSPhone(value);
    const hasDigits = allDigits.length > 0;
    const showWarning = focused && hasDigits && !valid;

    const handleChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const d = digitsOnly(e.target.value);
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
                onBlur={() => { setFocused(false); onBlur?.(); }}
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
