/**
 * Zenbooker Sync Service
 *
 * Bi-directional sync between Blanc contacts and Zenbooker customers.
 * Blanc is the master source of truth.
 *
 * All mutations are guarded by FEATURE_ZENBOOKER_SYNC env flag.
 */

const db = require('../db/connection');
const zenbookerClient = require('./zenbookerClient');
const contactsService = require('./contactsService');

const FEATURE_ENABLED = process.env.FEATURE_ZENBOOKER_SYNC === 'true';

/**
 * Strip phone to digits only — Zenbooker expects e.g. "6195551234" not "+16195551234"
 */
function stripPhone(phone) {
    if (!phone) return undefined;
    const digits = phone.replace(/\D/g, '');
    // Remove leading country code '1' if 11 digits
    if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
    return digits;
}

// =============================================================================
// Feature flag guard
// =============================================================================
function assertEnabled() {
    if (!FEATURE_ENABLED) {
        throw Object.assign(new Error('Zenbooker sync is disabled'), { code: 'FEATURE_DISABLED' });
    }
}

// =============================================================================
// Push: Create Zenbooker Customer from Blanc Contact
// =============================================================================
/**
 * Creates a new Zenbooker customer from a Blanc contact.
 * Persists the returned Zenbooker ID back to the contact.
 *
 * @param {number} contactId
 * @returns {Object} { zenbooker_customer_id, contact }
 */
async function pushContactToZenbooker(contactId) {
    assertEnabled();

    const contact = await contactsService.getContactById(contactId);
    if (contact.zenbooker_customer_id) {
        throw Object.assign(
            new Error('Contact already linked to Zenbooker'),
            { code: 'ALREADY_LINKED', httpStatus: 409 }
        );
    }

    // Build Zenbooker customer payload
    const customerData = {
        name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.full_name || '',
    };
    const phone = stripPhone(contact.phone_e164);
    if (phone) customerData.phone = phone;
    if (contact.email) customerData.email = contact.email;

    // Set status to pending before API call
    await db.query(
        `UPDATE contacts SET zenbooker_sync_status = 'pending', zenbooker_last_error = NULL WHERE id = $1`,
        [contactId]
    );

    try {
        const zbCustomer = await zenbookerClient.createCustomer(customerData);
        const zbId = String(zbCustomer.id);

        // Persist linkage
        await db.query(
            `UPDATE contacts
             SET zenbooker_customer_id = $1,
                 zenbooker_sync_status = 'linked',
                 zenbooker_synced_at = NOW(),
                 zenbooker_last_error = NULL
             WHERE id = $2`,
            [zbId, contactId]
        );

        // Push existing addresses to Zenbooker
        await pushExistingAddresses(contactId, zbId);

        const updated = await contactsService.getContactById(contactId);
        console.log(`[ZbSync] Contact ${contactId} linked to Zenbooker customer ${zbId}`);
        return { zenbooker_customer_id: zbId, contact: updated };
    } catch (err) {
        const errorMsg = err.response?.data?.error?.message || err.message;
        await db.query(
            `UPDATE contacts SET zenbooker_sync_status = 'error', zenbooker_last_error = $1 WHERE id = $2`,
            [errorMsg, contactId]
        );
        throw err;
    }
}

// =============================================================================
// Push: Sync Blanc Contact Updates to Zenbooker
// =============================================================================
/**
 * Pushes Blanc contact field updates to linked Zenbooker customer.
 * Called after PATCH /api/contacts/:id.
 *
 * @param {number} contactId
 */
async function syncContactToZenbooker(contactId) {
    assertEnabled();

    const contact = await contactsService.getContactById(contactId);
    if (!contact.zenbooker_customer_id) {
        console.log(`[ZbSync] Contact ${contactId} not linked, skipping sync`);
        return;
    }

    const updateData = {
        name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.full_name || '',
    };
    const phone = stripPhone(contact.phone_e164);
    if (phone) updateData.phone = phone;
    if (contact.email) updateData.email = contact.email;

    try {
        await zenbookerClient.updateCustomer(contact.zenbooker_customer_id, updateData);

        // Sync secondary phone as a note (Zenbooker only supports one phone field)
        if (contact.secondary_phone) {
            const label = contact.secondary_phone_name || 'Secondary';
            const noteText = `${label} phone: ${contact.secondary_phone}`;
            try {
                await zenbookerClient.addCustomerNote(contact.zenbooker_customer_id, noteText);
                console.log(`[ZbSync] Added secondary phone note for contact ${contactId}`);
            } catch (noteErr) {
                console.warn(`[ZbSync] Failed to add secondary phone note:`, noteErr.message);
            }
        }

        // Sync contact notes to Zenbooker
        if (contact.notes) {
            try {
                await zenbookerClient.addCustomerNote(contact.zenbooker_customer_id, contact.notes);
                console.log(`[ZbSync] Added notes for contact ${contactId}`);
            } catch (noteErr) {
                console.warn(`[ZbSync] Failed to add notes:`, noteErr.message);
            }
        }

        await db.query(
            `UPDATE contacts SET zenbooker_synced_at = NOW(), zenbooker_sync_status = 'linked', zenbooker_last_error = NULL WHERE id = $1`,
            [contactId]
        );
        console.log(`[ZbSync] Contact ${contactId} synced to Zenbooker`);
    } catch (err) {
        const errorMsg = err.response?.data?.error?.message || err.message;
        await db.query(
            `UPDATE contacts SET zenbooker_sync_status = 'error', zenbooker_last_error = $1 WHERE id = $2`,
            [errorMsg, contactId]
        );
        console.error(`[ZbSync] Failed to sync contact ${contactId}:`, errorMsg);
        // Don't rethrow — sync failure shouldn't block the original save
    }
}

// =============================================================================
// Push: Sync Address Changes to Zenbooker
// =============================================================================
/**
 * Syncs a single address change to Zenbooker.
 * - If address has zenbooker_address_id → PUT (edit)
 * - If address has no zenbooker_address_id → POST (add)
 *
 * @param {number} contactId
 * @param {number} addressId
 */
async function syncAddressToZenbooker(contactId, addressId) {
    assertEnabled();

    // Get contact's Zenbooker customer ID
    const { rows: cRows } = await db.query(
        'SELECT zenbooker_customer_id FROM contacts WHERE id = $1',
        [contactId]
    );
    const zbCustomerId = cRows[0]?.zenbooker_customer_id;
    if (!zbCustomerId) {
        console.log(`[ZbSync] Contact ${contactId} not linked, skipping address sync`);
        return;
    }

    // Get address
    const { rows: aRows } = await db.query(
        `SELECT id, street_line1, street_line2, city, state, postal_code, country, zenbooker_address_id
         FROM contact_addresses WHERE id = $1 AND contact_id = $2`,
        [addressId, contactId]
    );
    if (aRows.length === 0) return;
    const addr = aRows[0];

    const zbAddr = {
        line1: addr.street_line1 || '',
        line2: addr.street_line2 || '',
        city: addr.city || '',
        state: addr.state || '',
        postal_code: addr.postal_code || '',
    };

    try {
        if (addr.zenbooker_address_id) {
            // Edit existing
            await zenbookerClient.editCustomerAddress(zbCustomerId, addr.zenbooker_address_id, zbAddr);
            console.log(`[ZbSync] Address ${addressId} (zb:${addr.zenbooker_address_id}) updated in Zenbooker`);
        } else {
            // Add new
            const result = await zenbookerClient.addCustomerAddress(zbCustomerId, zbAddr);
            // Persist returned Zenbooker address ID
            const zbAddrId = result?.id || result?.address_id;
            if (zbAddrId) {
                await db.query(
                    `UPDATE contact_addresses SET zenbooker_address_id = $1, zenbooker_customer_id = $2 WHERE id = $3`,
                    [String(zbAddrId), zbCustomerId, addressId]
                );
                console.log(`[ZbSync] Address ${addressId} pushed to Zenbooker as ${zbAddrId}`);
            }
        }
    } catch (err) {
        console.error(`[ZbSync] Failed to sync address ${addressId}:`, err.response?.data || err.message);
        // Don't rethrow — address sync failure shouldn't block the original save
    }
}

// =============================================================================
// Push existing addresses when first linking contact
// =============================================================================
async function pushExistingAddresses(contactId, zbCustomerId) {
    const { rows } = await db.query(
        `SELECT id, street_line1, street_line2, city, state, postal_code, country
         FROM contact_addresses WHERE contact_id = $1 ORDER BY is_primary DESC`,
        [contactId]
    );

    for (const addr of rows) {
        try {
            const zbAddr = {
                line1: addr.street_line1 || '',
                line2: addr.street_line2 || '',
                city: addr.city || '',
                state: addr.state || '',
                postal_code: addr.postal_code || '',
            };
            const result = await zenbookerClient.addCustomerAddress(zbCustomerId, zbAddr);
            const zbAddrId = result?.id || result?.address_id;
            if (zbAddrId) {
                await db.query(
                    `UPDATE contact_addresses SET zenbooker_address_id = $1, zenbooker_customer_id = $2 WHERE id = $3`,
                    [String(zbAddrId), zbCustomerId, addr.id]
                );
            }
        } catch (err) {
            console.error(`[ZbSync] Failed to push address ${addr.id} to Zenbooker:`, err.message);
        }
    }
}

// =============================================================================
// Pull: Handle Zenbooker Webhook Payload
// =============================================================================
/**
 * Process a Zenbooker webhook payload.
 * Resolves matching Blanc contact, creates or updates as needed.
 *
 * @param {Object} payload - { event, data, account, webhook_id, retry_count }
 */
async function handleWebhookPayload(payload) {
    assertEnabled();

    const { event, data, account } = payload;
    if (!data?.id) {
        console.warn('[ZbSync] Webhook payload missing data.id, skipping');
        return;
    }

    const customerId = String(data.id);
    console.log(`[ZbSync] Processing webhook event=${event} customer=${customerId}`);

    // 1. Try exact match by zenbooker_customer_id
    const { rows: exact } = await db.query(
        'SELECT id FROM contacts WHERE zenbooker_customer_id = $1',
        [customerId]
    );

    if (exact.length > 0) {
        // Existing linked contact — update from Zenbooker data
        await updateContactFromZenbooker(exact[0].id, data, account);
        return;
    }

    // 2. Try match by name + phone
    const phone = normalizePhone(data.phone);
    const firstName = (data.first_name || '').trim().toLowerCase();
    const lastName = (data.last_name || '').trim().toLowerCase();
    const email = (data.email || '').trim().toLowerCase();

    if (phone && firstName && lastName) {
        const { rows: byPhone } = await db.query(
            `SELECT id FROM contacts
             WHERE LOWER(TRIM(first_name)) = $1
               AND LOWER(TRIM(last_name)) = $2
               AND phone_e164 = $3`,
            [firstName, lastName, phone]
        );
        if (byPhone.length === 1) {
            await linkAndUpdate(byPhone[0].id, customerId, data, account);
            return;
        }
    }

    // 3. Try match by name + email
    if (email && firstName && lastName) {
        const { rows: byEmail } = await db.query(
            `SELECT id FROM contacts
             WHERE LOWER(TRIM(first_name)) = $1
               AND LOWER(TRIM(last_name)) = $2
               AND LOWER(TRIM(email)) = $3`,
            [firstName, lastName, email]
        );
        if (byEmail.length === 1) {
            await linkAndUpdate(byEmail[0].id, customerId, data, account);
            return;
        }
    }

    // 4. No match — create new Blanc contact
    const fullName = [data.first_name, data.last_name].filter(Boolean).join(' ') || null;
    const { rows: newRows } = await db.query(
        `INSERT INTO contacts (full_name, first_name, last_name, phone_e164, email,
                               zenbooker_customer_id, zenbooker_account_id,
                               zenbooker_sync_status, zenbooker_synced_at, zenbooker_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'linked', NOW(), $8::jsonb)
         ON CONFLICT (zenbooker_customer_id) DO UPDATE SET
             zenbooker_data = EXCLUDED.zenbooker_data,
             zenbooker_synced_at = NOW()
         RETURNING id`,
        [fullName, data.first_name || null, data.last_name || null,
            phone || null, data.email || null,
            customerId, account || null,
            JSON.stringify(data)]
    );
    console.log(`[ZbSync] Created new contact ${newRows[0]?.id} from Zenbooker customer ${customerId}`);

    // Import addresses
    if (newRows[0]?.id && data.addresses?.length) {
        await importAddresses(newRows[0].id, customerId, data.addresses);
    }
}

// =============================================================================
// Helpers
// =============================================================================

async function linkAndUpdate(contactId, zbCustomerId, data, account) {
    await db.query(
        `UPDATE contacts
         SET zenbooker_customer_id = $1,
             zenbooker_account_id = $2,
             zenbooker_sync_status = 'linked',
             zenbooker_synced_at = NOW(),
             zenbooker_data = $3::jsonb,
             zenbooker_last_error = NULL
         WHERE id = $4`,
        [zbCustomerId, account || null, JSON.stringify(data), contactId]
    );
    console.log(`[ZbSync] Linked contact ${contactId} to Zenbooker customer ${zbCustomerId}`);

    if (data.addresses?.length) {
        await importAddresses(contactId, zbCustomerId, data.addresses);
    }
}

async function updateContactFromZenbooker(contactId, data, account) {
    // Parse name — ZB sends `name` (full) or `first_name`/`last_name`
    let firstName = data.first_name || null;
    let lastName = data.last_name || null;
    let fullName = data.name || null;

    if (!firstName && !lastName && fullName) {
        const parts = fullName.trim().split(/\s+/);
        firstName = parts[0] || null;
        lastName = parts.length > 1 ? parts.slice(1).join(' ') : null;
    }
    if (!fullName && (firstName || lastName)) {
        fullName = [firstName, lastName].filter(Boolean).join(' ');
    }

    const phone = normalizePhone(data.phone);
    const email = (data.email || '').trim() || null;

    // Update master fields + zenbooker_data
    await db.query(
        `UPDATE contacts
         SET zenbooker_data = $1::jsonb,
             zenbooker_synced_at = NOW(),
             zenbooker_account_id = COALESCE($2, zenbooker_account_id),
             zenbooker_sync_status = 'linked',
             zenbooker_last_error = NULL,
             full_name = COALESCE($3, full_name),
             first_name = COALESCE($4, first_name),
             last_name = COALESCE($5, last_name),
             phone_e164 = COALESCE($6, phone_e164),
             email = COALESCE($7, email)
         WHERE id = $8`,
        [JSON.stringify(data), account || null,
            fullName, firstName, lastName, phone, email,
            contactId]
    );
    console.log(`[ZbSync] Updated contact ${contactId} from Zenbooker (name=${fullName}, phone=${phone}, email=${email})`);

    if (data.addresses?.length) {
        await importAddresses(contactId, data.id ? String(data.id) : null, data.addresses);
    }
}

async function importAddresses(contactId, zbCustomerId, addresses) {
    for (const addr of addresses) {
        const zbAddrId = addr.id ? String(addr.id) : null;
        if (!zbAddrId) continue;

        // Check if already imported
        const { rows: existing } = await db.query(
            'SELECT id FROM contact_addresses WHERE contact_id = $1 AND zenbooker_address_id = $2',
            [contactId, zbAddrId]
        );
        if (existing.length > 0) continue; // skip duplicate

        // Insert or dedupe by hash
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update([
            (addr.line1 || '').trim().toLowerCase(),
            (addr.city || '').trim().toLowerCase(),
            (addr.state || '').trim().toLowerCase(),
            (addr.postal_code || '').trim(),
        ].join('|')).digest('hex');

        await db.query(
            `INSERT INTO contact_addresses
                (contact_id, street_line1, street_line2, city, state, postal_code, country,
                 zenbooker_address_id, zenbooker_customer_id, address_normalized_hash, is_primary)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false)
             ON CONFLICT DO NOTHING`,
            [contactId, addr.line1 || '', addr.line2 || '', addr.city || '', addr.state || '',
                addr.postal_code || '', addr.country || 'US', zbAddrId, zbCustomerId, hash]
        );
    }
}

function normalizePhone(phone) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (phone.startsWith('+')) return phone;
    return null;
}

// =============================================================================
// Exports
// =============================================================================
module.exports = {
    pushContactToZenbooker,
    syncContactToZenbooker,
    syncAddressToZenbooker,
    handleWebhookPayload,
    FEATURE_ENABLED,
};
