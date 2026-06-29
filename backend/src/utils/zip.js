'use strict';

/**
 * normalizeZip — recover a US ZIP that lost its leading zero.
 *
 * Boston/MA/RI ZIPs start with 0, and several paths drop it (the voice model
 * treats a ZIP as a number → "01721" arrives as "1721"; CSV imports / spreadsheets
 * strip leading zeros too). `service_territories` is an EXACT text-match lookup, so
 * a dropped zero silently misses. Left-pad the digits back to a 5-char string
 * (ZIP+4 / longer → first 5; non-numeric → ''). Apply this everywhere a ZIP is
 * looked up OR stored so the leading zero stays consistent across services.
 *
 * Origin: ZIP-fix 0a3830c (was a private helper in vapi-tools.js; promoted here so
 * the territory query layer + every caller normalize identically).
 */
function normalizeZip(zip) {
    if (zip == null) return '';
    const digits = String(zip).replace(/\D/g, '');
    if (!digits) return '';
    return digits.length >= 5 ? digits.slice(0, 5) : digits.padStart(5, '0');
}

module.exports = { normalizeZip };
