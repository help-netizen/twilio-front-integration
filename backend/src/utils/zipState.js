/**
 * zipToState — map a US ZIP code to its 2-letter state.
 *
 * Zenbooker's POST /jobs requires `address.state`. Leads/bookings sometimes
 * arrive with only city + ZIP (no state), which made job creation fail with
 * 400 "Address object is missing required fields: state". US ZIP codes map
 * unambiguously to a primary state by their first three digits, so we derive
 * the state when it's missing rather than dropping the field.
 *
 * Ranges are on the 3-digit ZIP prefix (inclusive). Source: USPS ZIP prefix
 * allocations. Only used to BACKFILL a missing state — never overrides one.
 */

// [minPrefix, maxPrefix, state] — inclusive, non-overlapping.
const RANGES = [
    [6, 9, 'PR'], [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'],
    [50, 59, 'VT'], [60, 69, 'CT'], [70, 89, 'NJ'], [100, 149, 'NY'], [150, 196, 'PA'],
    [197, 199, 'DE'], [200, 205, 'DC'], [206, 219, 'MD'], [220, 246, 'VA'], [247, 268, 'WV'],
    [270, 289, 'NC'], [290, 299, 'SC'], [300, 319, 'GA'], [320, 349, 'FL'], [350, 369, 'AL'],
    [370, 385, 'TN'], [386, 397, 'MS'], [398, 399, 'GA'], [400, 427, 'KY'], [430, 459, 'OH'],
    [460, 479, 'IN'], [480, 499, 'MI'], [500, 528, 'IA'], [530, 549, 'WI'], [550, 567, 'MN'],
    [570, 577, 'SD'], [580, 588, 'ND'], [590, 599, 'MT'], [600, 629, 'IL'], [630, 658, 'MO'],
    [660, 679, 'KS'], [680, 693, 'NE'], [700, 714, 'LA'], [716, 729, 'AR'], [730, 749, 'OK'],
    [750, 799, 'TX'], [800, 816, 'CO'], [820, 831, 'WY'], [832, 838, 'ID'], [840, 847, 'UT'],
    [850, 865, 'AZ'], [870, 884, 'NM'], [885, 885, 'TX'], [889, 898, 'NV'], [900, 961, 'CA'],
    [967, 968, 'HI'], [970, 979, 'OR'], [980, 994, 'WA'], [995, 999, 'AK'],
];

/**
 * @param {string|number} zip - a US ZIP (5-digit or ZIP+4; leading zeros ok)
 * @returns {string|null} 2-letter state, or null if not derivable
 */
function zipToState(zip) {
    if (zip == null) return null;
    const digits = String(zip).trim().replace(/\D/g, '');
    if (digits.length < 3) return null;
    const prefix = parseInt(digits.slice(0, 3), 10);
    if (Number.isNaN(prefix)) return null;
    for (const [min, max, state] of RANGES) {
        if (prefix >= min && prefix <= max) return state;
    }
    return null;
}

module.exports = { zipToState };
