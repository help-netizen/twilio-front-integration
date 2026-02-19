/**
 * Contact Address Service
 *
 * Manages contact addresses: list, dedupe, create.
 * Ensures lead addresses are persisted as contact attributes.
 */

const crypto = require('crypto');
const db = require('../db/connection');

// =============================================================================
// Normalization & Hashing
// =============================================================================

function computeNormalizedHash({ street, city, state, zip }) {
    const parts = [
        (street || '').trim().toLowerCase(),
        (city || '').trim().toLowerCase(),
        (state || '').trim().toLowerCase(),
        (zip || '').trim(),
    ];
    return crypto.createHash('md5').update(parts.join('|')).digest('hex');
}

// =============================================================================
// Get addresses for a contact
// =============================================================================

async function getAddressesForContact(contactId) {
    const { rows } = await db.query(
        `SELECT id, contact_id, label, is_primary,
                street_line1, street_line2, city, state, postal_code, country,
                google_place_id, lat, lng, created_at
         FROM contact_addresses
         WHERE contact_id = $1
         ORDER BY is_primary DESC, created_at DESC`,
        [contactId]
    );
    return rows.map(rowToAddress);
}

function rowToAddress(row) {
    return {
        id: Number(row.id),
        contact_id: Number(row.contact_id),
        label: row.label || null,
        is_primary: row.is_primary,
        street_line1: row.street_line1 || '',
        street_line2: row.street_line2 || '',
        city: row.city || '',
        state: row.state || '',
        postal_code: row.postal_code || '',
        country: row.country || 'US',
        google_place_id: row.google_place_id || null,
        lat: row.lat || null,
        lng: row.lng || null,
        created_at: row.created_at,
        // Formatted one-line display
        display: formatAddressOneLine(row),
    };
}

function formatAddressOneLine(row) {
    const parts = [
        row.street_line1,
        row.street_line2 ? `${row.street_line2}` : null,
        row.city,
        row.state ? `${row.state} ${row.postal_code || ''}`.trim() : row.postal_code,
    ].filter(Boolean);
    const addr = parts.join(', ');
    return row.label ? `${addr} (${row.label})` : addr;
}

// =============================================================================
// Resolve address — dedupe or create
// =============================================================================

/**
 * Find existing or create new contact address.
 *
 * @param {number} contactId
 * @param {Object} address - { street, apt, city, state, zip, lat, lng, placeId }
 * @returns {Object} { contact_address_id, status: 'linked_existing' | 'created_new' | 'none' }
 */
async function resolveAddress(contactId, { street, apt, city, state, zip, lat, lng, placeId }) {
    if (!contactId) return { contact_address_id: null, status: 'none' };
    if (!street || !street.trim()) return { contact_address_id: null, status: 'none' };

    // 1. Try matching by place_id first (most reliable)
    if (placeId) {
        const { rows: byPlace } = await db.query(
            `SELECT id FROM contact_addresses
             WHERE contact_id = $1 AND google_place_id = $2`,
            [contactId, placeId]
        );
        if (byPlace.length > 0) {
            const addrId = Number(byPlace[0].id);
            // Update mutable fields (apt/unit, coords)
            await db.query(
                `UPDATE contact_addresses SET street_line2 = COALESCE($1, street_line2),
                    lat = COALESCE($2, lat), lng = COALESCE($3, lng), updated_at = NOW()
                 WHERE id = $4`,
                [apt || null, lat || null, lng || null, addrId]
            );
            return { contact_address_id: addrId, status: 'linked_existing' };
        }
    }

    // 2. Try matching by normalized hash
    const hash = computeNormalizedHash({ street, city, state, zip });
    const { rows: byHash } = await db.query(
        `SELECT id FROM contact_addresses
         WHERE contact_id = $1 AND address_normalized_hash = $2`,
        [contactId, hash]
    );
    if (byHash.length > 0) {
        const addrId = Number(byHash[0].id);
        // Update mutable fields (apt/unit, coords)
        await db.query(
            `UPDATE contact_addresses SET street_line2 = COALESCE($1, street_line2),
                lat = COALESCE($2, lat), lng = COALESCE($3, lng), updated_at = NOW()
             WHERE id = $4`,
            [apt || null, lat || null, lng || null, addrId]
        );
        return { contact_address_id: addrId, status: 'linked_existing' };
    }

    // 3. No match → create new additional address
    const { rows } = await db.query(
        `INSERT INTO contact_addresses
            (contact_id, street_line1, street_line2, city, state, postal_code,
             google_place_id, lat, lng, address_normalized_hash, is_primary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [contactId, street || '', apt || null, city || '', state || '', zip || '',
            placeId || null, lat || null, lng || null, hash]
    );

    if (rows.length > 0) {
        return { contact_address_id: Number(rows[0].id), status: 'created_new' };
    }

    // ON CONFLICT hit — race condition, re-fetch
    const { rows: retry } = await db.query(
        `SELECT id FROM contact_addresses
         WHERE contact_id = $1 AND address_normalized_hash = $2`,
        [contactId, hash]
    );
    if (retry.length > 0) {
        return { contact_address_id: Number(retry[0].id), status: 'linked_existing' };
    }

    return { contact_address_id: null, status: 'none' };
}

// =============================================================================
// Validate contact_address_id belongs to contact
// =============================================================================

async function validateAddressBelongsToContact(contactAddressId, contactId) {
    const { rows } = await db.query(
        'SELECT 1 FROM contact_addresses WHERE id = $1 AND contact_id = $2',
        [contactAddressId, contactId]
    );
    return rows.length > 0;
}

// =============================================================================
// Exports
// =============================================================================
module.exports = {
    getAddressesForContact,
    resolveAddress,
    validateAddressBelongsToContact,
    computeNormalizedHash,
};
