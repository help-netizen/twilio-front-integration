/**
 * Phone number utilities (frontend).
 *
 * Normalizes US phone input to E.164 and provides display formatting.
 */

/**
 * Normalize a phone string to E.164 format (US-centric).
 * Accepts formats like: (617) 500-6181, 6175006181, 1-617-500-6181, +16175006181
 * Returns null if the input can't be normalized.
 */
export function normalizeToE164(input: string): string | null {
    if (!input) return null;
    const digits = input.replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    // Already has country code or international
    if (digits.length > 10) return `+${digits}`;
    return null; // Too short
}

/**
 * Format an E.164 number for display: +16175006181 → (617) 500-6181
 */
export function formatPhoneDisplay(e164: string): string {
    if (!e164) return '';
    const digits = e164.replace(/\D/g, '');
    // US number: 1XXXXXXXXXX or XXXXXXXXXX
    const national = digits.startsWith('1') && digits.length === 11 ? digits.slice(1) : digits;
    if (national.length === 10) {
        return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
    }
    // International or other — just return with +
    return e164;
}

/**
 * Detect if input looks like a phone number (vs. name for search).
 * Returns true if input is predominantly digits/phone chars.
 */
export function isLikelyPhoneInput(input: string): boolean {
    if (!input || input.trim().length === 0) return false;
    const stripped = input.replace(/[\s\-().+]/g, '');
    // If after removing phone formatting chars it's all digits and 3+ chars long
    return /^\d+$/.test(stripped) && stripped.length >= 3;
}
