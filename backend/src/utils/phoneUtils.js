/**
 * Phone number utilities.
 * Centralised E.164 normalisation so every write path stores "+1XXXXXXXXXX".
 */

/**
 * Normalise a phone string to E.164 format.
 *  - 10 digits           → +1XXXXXXXXXX
 *  - 11 digits (1…)      → +1XXXXXXXXXX
 *  - already +…digits    → returned as-is
 *  - non-US / other      → +<digits>
 *  - null / empty        → null
 */
function toE164(phone) {
    if (!phone) return null;
    const digits = String(phone).replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    // Already looks correct or international — just ensure leading +
    return `+${digits}`;
}

module.exports = { toE164 };
