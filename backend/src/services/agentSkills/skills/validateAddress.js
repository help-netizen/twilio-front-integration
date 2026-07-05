/**
 * agentSkills / skills / validateAddress — RELOCATED legacy L0 tool
 * (AGENT-SKILLS-001, spec §7.3 / task T3).
 *
 * Byte-identical relocation of `handleValidateAddress` from
 * `routes/vapi-tools.js` (the pre-T4 source of truth). This is the module the
 * `https`/Google-Geocoding code MOVES INTO — after T4, `vapi-tools.js` no longer
 * references `maps.googleapis.com` (spec §7.2 / ASK-VAPI-21). Internals are
 * RELOCATED, NOT rewritten:
 *   - dedicated server-side key with back-compat fallback:
 *     GOOGLE_GEOCODING_KEY → VITE_GOOGLE_MAPS_API_KEY;
 *   - OK          → { valid:true, standardized, correctedZip, lat, lng };
 *   - ZERO_RESULTS/empty/error/no-key → { valid:false } (never throws).
 *
 * FROZEN shape (no ok/speak). `companyId` is accepted for signature uniformity
 * but unused (Geocoding is tenant-agnostic, exactly as the old handler).
 * `verifiedContext` is unused (L0).
 */

'use strict';

const https = require('https');
// ZIP normalization (recover a dropped leading zero) — shared util.
const { normalizeZip } = require('../../../utils/zip');

/**
 * @param {string} _companyId Unused (Geocoding is tenant-agnostic).
 * @param {object} _verifiedContext Unused for this L0 tool.
 * @param {{ street?, apt?, city?, state?, zip? }} input The tool arguments.
 * @returns {Promise<object>} Frozen legacy shape (no ok/speak); never throws.
 */
async function run(_companyId, _verifiedContext, input = {}) {
    const { street, apt, city, state, zip } = input;

    // Dedicated server-side Geocoding key (IP-restricted). Falls back to the
    // frontend Maps key for back-compat if the dedicated one isn't set.
    const apiKey = process.env.GOOGLE_GEOCODING_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
        console.warn('[vapi-tools] GOOGLE_GEOCODING_KEY not set — address validation skipped');
        return { valid: false, error: 'GOOGLE_GEOCODING_KEY not configured' };
    }

    try {
        const z = normalizeZip(zip);
        const parts = [street, apt, city, state, z].filter(Boolean);
        const addressQuery = parts.join(', ');
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addressQuery)}&key=${apiKey}`;

        const data = await new Promise((resolve, reject) => {
            https.get(url, (res) => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); }
                    catch (e) { reject(new Error('Invalid JSON from Geocoding API')); }
                });
            }).on('error', reject);
        });

        if (!data.results || data.results.length === 0 || data.status === 'ZERO_RESULTS') {
            return { valid: false };
        }

        const result = data.results[0];
        const components = result.address_components || [];

        const postalComponent = components.find(c => c.types.includes('postal_code'));
        const correctedZip = postalComponent?.short_name || z || '';

        // Strip ", USA" from formatted address for cleaner speech output
        const standardized = (result.formatted_address || '').replace(/, USA$/, '').trim();

        return {
            valid: true,
            standardized,
            correctedZip,
            lat: result.geometry?.location?.lat ?? null,
            lng: result.geometry?.location?.lng ?? null,
        };
    } catch (err) {
        console.error('[vapi-tools] validateAddress error:', err.message);
        return { valid: false };
    }
}

module.exports = { run };
