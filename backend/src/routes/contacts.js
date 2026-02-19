const express = require('express');
const router = express.Router();
const contactsService = require('../services/contactsService');
const contactDedupeService = require('../services/contactDedupeService');

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
        const allowedFields = ['first_name', 'last_name', 'company_name', 'phone_e164', 'secondary_phone', 'email', 'notes'];
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
             SET first_name = $1, last_name = $2, phone = $3, email = $4, updated_at = NOW()
             WHERE contact_id = $5`,
            [updated.first_name || '', updated.last_name || '', updated.phone_e164 || '', updated.email || '', id]
        );
        console.log(`[ContactsAPI][${reqId}] Cascaded contact fields to linked leads for contact ${id}`);

        // Return updated contact
        res.json(successResponse({ contact: updated }, reqId));
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
    } catch (err) {
        console.error(`[ContactsAPI][${reqId}] Error:`, err);
        res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
    }
});

module.exports = router;
