const express = require('express');
const router = express.Router();
const contactsService = require('../services/contactsService');
const contactDedupeService = require('../services/contactDedupeService');
const zenbookerSyncService = require('../services/zenbookerSyncService');

// =============================================================================
// Helpers
// =============================================================================
function requestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

function successResponse(data, reqId) {
    return {
        ok: true,
        data,
        meta: {
            request_id: reqId,
            timestamp: new Date().toISOString(),
        },
    };
}

function errorResponse(code, message, reqId) {
    return {
        ok: false,
        error: {
            code,
            message,
            correlation_id: reqId,
        },
    };
}

// =============================================================================
// GET /api/contacts — List contacts
// =============================================================================
router.get('/', async (req, res) => {
    const reqId = requestId();
    try {
        const { search, offset, limit } = req.query;

        const params = {
            search: search || undefined,
            offset: offset ? Number(offset) : 0,
            limit: limit ? Math.min(Number(limit), 100) : 50,
        };

        const result = await contactsService.listContacts(params);
        res.json(successResponse(result, reqId));
    } catch (err) {
        console.error(`[ContactsAPI][${reqId}] Error:`, err);
        res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
    }
});

// =============================================================================
// GET /api/contacts/search-candidates — Dedupe search for UI
// =============================================================================
router.get('/search-candidates', async (req, res) => {
    const reqId = requestId();
    try {
        const { first_name, last_name, phone, email } = req.query;

        if (!first_name || !last_name) {
            return res.json(successResponse({ candidates: [], match_hint: 'none', will_enrich_email: false }, reqId));
        }

        const companyId = req.companyFilter?.company_id || req.user?.company_id || null;
        const result = await contactDedupeService.searchCandidates(
            { first_name, last_name, phone: phone || null, email: email || null },
            companyId
        );

        res.json(successResponse(result, reqId));
    } catch (err) {
        console.error(`[ContactsAPI][${reqId}] search-candidates error:`, err);
        res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
    }
});

// =============================================================================
// GET /api/contacts/:id — Get contact detail
// =============================================================================
router.get('/:id', async (req, res) => {
    const reqId = requestId();
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json(errorResponse('INVALID_ID', 'Contact ID must be a number', reqId));
        }

        const contact = await contactsService.getContactById(id);
        const leads = await contactsService.getContactLeads(id);

        // Merge contact_addresses from our DB into contact.addresses
        const contactAddressService = require('../services/contactAddressService');
        const dbAddresses = await contactAddressService.getAddressesForContact(id);
        const mergedAddresses = dbAddresses.map(a => ({
            id: String(a.id),
            line1: a.street_line1,
            line2: a.street_line2 || '',
            city: a.city,
            state: a.state,
            postal_code: a.postal_code,
            lat: a.lat,
            lng: a.lng,
            nickname: a.label || null,
            is_default_address_for_customer: a.is_primary,
            formatted: a.display,
            source: 'local',
        }));
        // Zenbooker addresses stay, local addresses are appended (deduped by line1)
        const zbStreets = new Set((contact.addresses || []).map(a => (a.line1 || '').toLowerCase().trim()));
        const uniqueLocal = mergedAddresses.filter(a => !zbStreets.has((a.line1 || '').toLowerCase().trim()));
        contact.addresses = [...(contact.addresses || []), ...uniqueLocal];

        res.json(successResponse({ contact, leads }, reqId));
    } catch (err) {
        if (err.code === 'NOT_FOUND') {
            return res.status(404).json(errorResponse('NOT_FOUND', err.message, reqId));
        }
        console.error(`[ContactsAPI][${reqId}] Error:`, err);
        res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
    }
});

// =============================================================================
// PATCH /api/contacts/:id — Update contact fields
// =============================================================================
router.patch('/:id', async (req, res) => {
    const reqId = requestId();
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json(errorResponse('INVALID_ID', 'Contact ID must be a number', reqId));
        }

        const db = require('../db/connection');
        const allowedFields = ['first_name', 'last_name', 'company_name', 'phone_e164', 'secondary_phone', 'secondary_phone_name', 'email', 'notes'];
        const setClauses = [];
        const params = [];
        let paramIdx = 1;

        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                setClauses.push(`${field} = $${paramIdx}`);
                params.push(req.body[field] || null);
                paramIdx++;
            }
        }

        if (setClauses.length === 0) {
            return res.status(400).json(errorResponse('NO_FIELDS', 'No valid fields to update', reqId));
        }

        // Recalculate full_name
        const firstName = req.body.first_name !== undefined ? req.body.first_name : null;
        const lastName = req.body.last_name !== undefined ? req.body.last_name : null;
        if (firstName !== null || lastName !== null) {
            // Need current values for the ones not being updated
            const { rows: current } = await db.query('SELECT first_name, last_name FROM contacts WHERE id = $1', [id]);
            if (current.length === 0) {
                return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));
            }
            const fn = firstName !== null ? firstName : current[0].first_name;
            const ln = lastName !== null ? lastName : current[0].last_name;
            const fullName = [fn, ln].filter(Boolean).join(' ') || null;
            setClauses.push(`full_name = $${paramIdx}`);
            params.push(fullName);
            paramIdx++;
        }

        setClauses.push(`updated_at = NOW()`);
        params.push(id);

        await db.query(
            `UPDATE contacts SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
            params
        );

        // Cascade contact fields to linked leads
        const updated = await contactsService.getContactById(id);
        await db.query(
            `UPDATE leads
             SET first_name = $1, last_name = $2, phone = $3, email = $4,
                 second_phone = $5, second_phone_name = $6, company = $7, updated_at = NOW()
             WHERE contact_id = $8`,
            [updated.first_name || '', updated.last_name || '', updated.phone_e164 || '', updated.email || '',
            updated.secondary_phone || null, updated.secondary_phone_name || null, updated.company_name || null, id]
        );
        console.log(`[ContactsAPI][${reqId}] Cascaded contact fields to linked leads for contact ${id}`);

        // Async: merge orphan timelines matching this contact's phones
        (async () => {
            try {
                const phones = [updated.phone_e164, updated.secondary_phone].filter(Boolean);
                if (phones.length === 0) return;

                const digits = phones.map(p => p.replace(/\D/g, '').slice(-10)).filter(d => d.length === 10);
                if (digits.length === 0) return;

                // Find orphan timelines matching any of the contact's phone digits
                const { rows: orphanTimelines } = await db.query(`
                    SELECT id, phone_e164
                    FROM timelines
                    WHERE contact_id IS NULL
                      AND phone_e164 IS NOT NULL
                      AND RIGHT(REGEXP_REPLACE(phone_e164, '[^0-9]', '', 'g'), 10) = ANY($1)
                `, [digits]);

                if (orphanTimelines.length === 0) return;

                // Does the contact already have a timeline?
                const { rows: existingTl } = await db.query(
                    'SELECT id FROM timelines WHERE contact_id = $1 LIMIT 1', [id]
                );

                if (existingTl.length > 0) {
                    // Merge: move calls from orphan timelines into the existing one
                    const mainTlId = existingTl[0].id;
                    for (const orphan of orphanTimelines) {
                        const { rowCount } = await db.query(
                            'UPDATE calls SET timeline_id = $1, contact_id = $2 WHERE timeline_id = $3',
                            [mainTlId, id, orphan.id]
                        );
                        await db.query('DELETE FROM timelines WHERE id = $1', [orphan.id]);
                        console.log(`[ContactsAPI][${reqId}] Merged timeline ${orphan.id} (${orphan.phone_e164}) into ${mainTlId} — ${rowCount} calls moved`);
                    }
                } else {
                    // Adopt the first orphan timeline, merge the rest into it
                    const mainOrphan = orphanTimelines[0];
                    await db.query('UPDATE timelines SET contact_id = $1 WHERE id = $2', [id, mainOrphan.id]);
                    await db.query('UPDATE calls SET contact_id = $1 WHERE timeline_id = $2 AND contact_id IS NULL', [id, mainOrphan.id]);
                    console.log(`[ContactsAPI][${reqId}] Adopted timeline ${mainOrphan.id} (${mainOrphan.phone_e164}) for contact ${id}`);

                    for (let i = 1; i < orphanTimelines.length; i++) {
                        const orphan = orphanTimelines[i];
                        const { rowCount } = await db.query(
                            'UPDATE calls SET timeline_id = $1, contact_id = $2 WHERE timeline_id = $3',
                            [mainOrphan.id, id, orphan.id]
                        );
                        await db.query('DELETE FROM timelines WHERE id = $1', [orphan.id]);
                        console.log(`[ContactsAPI][${reqId}] Merged extra timeline ${orphan.id} into ${mainOrphan.id} — ${rowCount} calls`);
                    }
                }

                // Also link any unlinked calls matching these phones
                await db.query(`
                    UPDATE calls SET contact_id = $1
                    WHERE contact_id IS NULL
                      AND (
                          RIGHT(REGEXP_REPLACE(from_number, '[^0-9]', '', 'g'), 10) = ANY($2)
                          OR RIGHT(REGEXP_REPLACE(to_number, '[^0-9]', '', 'g'), 10) = ANY($2)
                      )
                `, [id, digits]);
            } catch (mergeErr) {
                console.warn(`[ContactsAPI][${reqId}] Timeline merge error (non-blocking):`, mergeErr.message);
            }
        })();

        // Return updated contact
        res.json(successResponse({ contact: updated }, reqId));

        // Async: push to Zenbooker if linked
        if (zenbookerSyncService.FEATURE_ENABLED && updated.zenbooker_customer_id) {
            zenbookerSyncService.syncContactToZenbooker(id).catch(err =>
                console.error(`[ContactsAPI][${reqId}] Zenbooker sync error (non-blocking):`, err.message)
            );
        }
    } catch (err) {
        if (err.code === 'NOT_FOUND') {
            return res.status(404).json(errorResponse('NOT_FOUND', err.message, reqId));
        }
        console.error(`[ContactsAPI][${reqId}] Error:`, err);
        res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
    }
});

// =============================================================================
// GET /api/contacts/:id/addresses — List contact addresses
// =============================================================================
router.get('/:id/addresses', async (req, res) => {
    const reqId = requestId();
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json(errorResponse('INVALID_ID', 'Contact ID must be a number', reqId));
        }

        const contactAddressService = require('../services/contactAddressService');
        const addresses = await contactAddressService.getAddressesForContact(id);
        res.json(successResponse({ addresses }, reqId));
    } catch (err) {
        console.error(`[ContactsAPI][${reqId}] Error:`, err);
        res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
    }
});

// =============================================================================
// PATCH /api/contacts/:id/addresses/:addressId — Update contact address
// =============================================================================
router.patch('/:id/addresses/:addressId', async (req, res) => {
    const reqId = requestId();
    try {
        const contactId = Number(req.params.id);
        const addressId = Number(req.params.addressId);
        if (isNaN(contactId) || isNaN(addressId)) {
            return res.status(400).json(errorResponse('INVALID_ID', 'IDs must be numbers', reqId));
        }

        const contactAddressService = require('../services/contactAddressService');
        const db = require('../db/connection');

        // Verify address belongs to contact
        const valid = await contactAddressService.validateAddressBelongsToContact(addressId, contactId);
        if (!valid) {
            return res.status(404).json(errorResponse('NOT_FOUND', 'Address not found for this contact', reqId));
        }

        const { street, apt, city, state, zip, lat, lng, placeId } = req.body;
        const hash = contactAddressService.computeNormalizedHash({ street, city, state, zip });

        await db.query(
            `UPDATE contact_addresses
             SET street_line1 = $1, street_line2 = $2, city = $3, state = $4, postal_code = $5,
                 lat = $6, lng = $7, google_place_id = $8, address_normalized_hash = $9, updated_at = NOW()
             WHERE id = $10`,
            [street || '', apt || null, city || '', state || '', zip || '',
            lat || null, lng || null, placeId || null, hash, addressId]
        );

        // Cascade address fields to linked leads
        await db.query(
            `UPDATE leads
             SET address = $1, unit = $2, city = $3, state = $4, postal_code = $5, updated_at = NOW()
             WHERE contact_address_id = $6`,
            [street || '', apt || '', city || '', state || '', zip || '', addressId]
        );
        console.log(`[ContactsAPI][${reqId}] Cascaded address fields to leads with contact_address_id ${addressId}`);

        const addresses = await contactAddressService.getAddressesForContact(contactId);
        res.json(successResponse({ addresses }, reqId));

        // Async: push address to Zenbooker if linked
        if (zenbookerSyncService.FEATURE_ENABLED) {
            zenbookerSyncService.syncAddressToZenbooker(contactId, addressId).catch(err =>
                console.error(`[ContactsAPI][${reqId}] Zenbooker address sync error (non-blocking):`, err.message)
            );
        }
    } catch (err) {
        console.error(`[ContactsAPI][${reqId}] Error:`, err);
        res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
    }
});

module.exports = router;
