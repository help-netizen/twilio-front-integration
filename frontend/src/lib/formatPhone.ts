/**
 * Format a phone number string to +1 (XXX) XXX-XXXX format.
 * Strips all non-digit characters, assumes US phone (10 digits or 11 with leading 1).
 * If the phone doesn't match expected digit counts, returns it as-is.
 */
export function formatPhone(phone: string | null | undefined): string {
    if (!phone) return '-';

    // Strip all non-digit characters
    const digits = phone.replace(/\D/g, '');

    // Handle 10-digit US number
    if (digits.length === 10) {
        return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }

    // Handle 11-digit US number (leading 1)
    if (digits.length === 11 && digits[0] === '1') {
        return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }

    // If doesn't match US format, return original
    return phone;
}
