const express = require('express');
const multer = require('multer');
const { randomUUID } = require('node:crypto');
const router = express.Router();
const contactsService = require('../services/contactsService');
const contactDedupeService = require('../services/contactDedupeService');
const zenbookerSyncService = require('../services/zenbookerSyncService');
const noteAttachmentsService = require('../services/noteAttachmentsService');
const notesMutationService = require('../services/notesMutationService');
const { toE164 } = require('../utils/phoneUtils');
const eventService = require('../services/eventService');
const { requirePermission } = require('../middleware/authorization');
const { getProviderScope } = require('../middleware/providerScope');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: noteAttachmentsService.MAX_FILE_SIZE },
});

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
router.get('/', requirePermission('contacts.view'), async (req, res) => {
    const reqId = requestId();
    try {
        const { search, offset, limit } = req.query;

        const params = {
            search: search || undefined,
            offset: offset ? Number(offset) : 0,
            limit: limit ? Math.min(Number(limit), 100) : 50,
            companyId: req.companyFilter?.company_id,
            providerScope: getProviderScope(req),
        };

        const result = await contactsService.listContacts(params);
        res.json(successResponse(result, reqId));
    } catch (err) {
        console.error(`[ContactsAPI][${reqId}] Error:`, err);
        res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
    }
});

// =============================================================================
// GET /api/contacts/search-candidates — Contact lookup for UI
// =============================================================================
router.get('/search-candidates', requirePermission('contacts.view'), async (req, res) => {
    const reqId = requestId();
    try {
        const { first_name, last_name, phone, email, q } = req.query;

        const companyId = req.companyFilter?.company_id || null;
        const result = await contactDedupeService.searchCandidates(
            { first_name: first_name || '', last_name: last_name || '', phone: phone || null, email: email || null, q: q || null },
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
router.get('/:id', requirePermission('contacts.view'), async (req, res) => {
    const reqId = requestId();
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json(errorResponse('INVALID_ID', 'Contact ID must be a number', reqId));
        }

        const companyId = req.companyFilter?.company_id;
        const contact = await contactsService.getContactById(id, companyId, getProviderScope(req));
        const leads = await contactsService.getContactLeads(id, companyId);

        // Surface ALL email addresses (primary + contact_emails) so the Pulse
        // composer's "To" dropdown can offer each one (EMAIL-TIMELINE-001 / TASK-ET-14).
        contact.contact_emails = await contactsService.getContactEmails(id, contact.email);

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

        // Enforce single default: if multiple addresses are flagged as default, keep only the first
        const defaultAddrs = contact.addresses.filter(a => a.is_default_address_for_customer);
        if (defaultAddrs.length > 1) {
            // Keep the first default, clear the rest
            for (let i = 1; i < defaultAddrs.length; i++) {
                defaultAddrs[i].is_default_address_for_customer = false;
            }
        }

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
router.patch('/:id', requirePermission('contacts.edit'), async (req, res) => {
    const reqId = requestId();
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json(errorResponse('INVALID_ID', 'Contact ID must be a number', reqId));
        }

        const companyId = req.companyFilter?.company_id;
        const existing = await contactsService.getById(id, companyId, getProviderScope(req));
        if (!existing) {
            return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));
        }

        const db = require('../db/connection');
        const allowedFields = ['first_name', 'last_name', 'company_name', 'phone_e164', 'secondary_phone', 'secondary_phone_name', 'email', 'notes'];
        const setClauses = [];
        const params = [];
        let paramIdx = 1;

        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                let value = req.body[field] || null;
                // Normalize phone fields to E.164
                if ((field === 'phone_e164' || field === 'secondary_phone') && value) {
                    value = toE164(value) || value;
                }
                setClauses.push(`${field} = $${paramIdx}`);
                params.push(value);
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
        params.push(companyId);

        await db.query(
            `UPDATE contacts SET ${setClauses.join(', ')} WHERE id = $${paramIdx} AND company_id = $${paramIdx + 1}`,
            params
        );

        // Cascade contact fields to linked leads
        const updated = await contactsService.getContactById(id, companyId);
        await db.query(
            `UPDATE leads
             SET first_name = $1, last_name = $2, phone = $3, email = $4,
                 second_phone = $5, second_phone_name = $6, company = $7, updated_at = NOW()
             WHERE contact_id = $8 AND company_id = $9`,
            [updated.first_name || '', updated.last_name || '', updated.phone_e164 || '', updated.email || '',
            updated.secondary_phone || null, updated.secondary_phone_name || null, updated.company_name || null, id, companyId]
        );
        console.log(`[ContactsAPI][${reqId}] Cascaded contact fields to linked leads for contact ${id}`);

        // Async: merge orphan timelines matching this contact's phones
        (async () => {
            try {
                const { mergeOrphanTimelines } = require('../services/timelineMergeService');
                await mergeOrphanTimelines(id, [updated.phone_e164, updated.secondary_phone], `[ContactsAPI][${reqId}]`);
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
router.get('/:id/addresses', requirePermission('contacts.view'), async (req, res) => {
    const reqId = requestId();
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json(errorResponse('INVALID_ID', 'Contact ID must be a number', reqId));
        }

        const owned = await contactsService.getById(id, req.companyFilter?.company_id, getProviderScope(req));
        if (!owned) return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));

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
router.patch('/:id/addresses/:addressId', requirePermission('contacts.edit'), async (req, res) => {
    const reqId = requestId();
    try {
        const contactId = Number(req.params.id);
        const addressId = Number(req.params.addressId);
        if (isNaN(contactId) || isNaN(addressId)) {
            return res.status(400).json(errorResponse('INVALID_ID', 'IDs must be numbers', reqId));
        }

        const ownedContact = await contactsService.getById(contactId, req.companyFilter?.company_id, getProviderScope(req));
        if (!ownedContact) return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));

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

// =============================================================================
// PUT /api/contacts/:id/addresses/:addressId/default — Set default address
// =============================================================================
router.put('/:id/addresses/:addressId/default', requirePermission('contacts.edit'), async (req, res) => {
    const reqId = requestId();
    try {
        const contactId = Number(req.params.id);
        const addressId = Number(req.params.addressId);
        if (isNaN(contactId) || isNaN(addressId)) {
            return res.status(400).json(errorResponse('INVALID_ID', 'IDs must be numbers', reqId));
        }

        const ownedContact2 = await contactsService.getById(contactId, req.companyFilter?.company_id, getProviderScope(req));
        if (!ownedContact2) return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));

        const contactAddressService = require('../services/contactAddressService');

        // Verify address belongs to contact
        const valid = await contactAddressService.validateAddressBelongsToContact(addressId, contactId);
        if (!valid) {
            return res.status(404).json(errorResponse('NOT_FOUND', 'Address not found for this contact', reqId));
        }

        await contactAddressService.setDefaultAddress(contactId, addressId);
        const addresses = await contactAddressService.getAddressesForContact(contactId);
        res.json(successResponse({ addresses }, reqId));
    } catch (err) {
        console.error(`[ContactsAPI][${reqId}] Error:`, err);
        res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
    }
});

// =============================================================================
// Structured Notes (with file attachments)
// =============================================================================

router.get('/:id/history', requirePermission('contacts.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const contactId = parseInt(req.params.id, 10);
        const contact = await contactsService.getById(contactId, companyId, getProviderScope(req));
        if (!contact) return res.status(404).json({ ok: false, error: 'Contact not found' });

        const history = await eventService.getEntityHistory(companyId, 'contact', contactId, contact.structured_notes || []);
        res.json({ ok: true, data: history });
    } catch (err) {
        console.error('[Contacts] History error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Note-mutation helpers (shared by PATCH/DELETE note routes, NOTES-001) ────

function isAdminActor(req) {
    return req.user?._devMode
        || req.authz?.membership?.role_key === 'tenant_admin'
        || (req.user?.roles || []).includes('company_admin');
}

function buildNoteActor(req) {
    return {
        sub: req.user?.sub || null,
        crmUserId: req.user?.sub || null,
        name: req.user?.name || null,
        isAdmin: isAdminActor(req),
    };
}

function parseRemoveAttachmentIds(raw) {
    if (raw == null || raw === '') return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
            if (parsed == null) return [];
            return [parsed];
        } catch {
            return [raw];
        }
    }
    return [raw];
}

// Build the GET-shaped, soft-delete-excluded notes list for a contact.
async function enrichContactNotes(companyId, contactId, notes) {
    const attachments = await noteAttachmentsService.getAttachmentsForEntity(companyId, 'contact', contactId);
    const byNoteId = {};
    const byNoteIndex = {};
    for (const a of attachments) {
        if (a.noteId) (byNoteId[a.noteId] ||= []).push(a);
        else (byNoteIndex[a.noteIndex] ||= []).push(a);
    }
    return (notes || [])
        .map((n, i) => ({ n, i }))
        .filter(({ n }) => !n.deleted_at)
        .map(({ n, i }) => ({
            ...n,
            id: n.id || null,
            created_by: n.created_by || null,
            source: n.source || null,
            zb_note_id: n.zb_note_id || null,
            attachments: (n.id && byNoteId[n.id]) || byNoteIndex[i] || [],
        }));
}

router.get('/:id/notes', requirePermission('contacts.view'), async (req, res) => {
    const reqId = requestId();
    try {
        const companyId = req.companyFilter?.company_id;
        const contactId = parseInt(req.params.id, 10);
        const contact = await contactsService.getById(contactId, companyId, getProviderScope(req));
        if (!contact) return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));

        const enriched = await enrichContactNotes(companyId, contactId, contact.structured_notes || []);
        res.json(successResponse(enriched, reqId));
    } catch (err) {
        console.error(`[ContactsAPI][${reqId}] Get notes error:`, err.message);
        res.status(500).json(errorResponse('INTERNAL_ERROR', err.message, reqId));
    }
});

router.post('/:id/notes', requirePermission('contacts.edit'), upload.array('attachments', noteAttachmentsService.MAX_FILES_PER_NOTE), async (req, res) => {
    const reqId = requestId();
    try {
        const companyId = req.companyFilter?.company_id;
        const userId = req.user?.crmUser?.id || req.user?.sub || null;
        const contactId = parseInt(req.params.id, 10);
        const contact = await contactsService.getById(contactId, companyId, getProviderScope(req));
        if (!contact) return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));

        const text = (req.body.text || '').trim();
        const files = req.files || [];
        const attachmentIds = parseRemoveAttachmentIds(req.body.attachment_ids); // tolerant id-array parse
        if (!text && files.length === 0 && attachmentIds.length === 0) return res.status(400).json(errorResponse('BAD_REQUEST', 'text or attachments required', reqId));

        const existingNotes = contact.structured_notes || [];

        // Migrate legacy notes text on first structured note
        if (existingNotes.length === 0 && contact.notes?.trim()) {
            existingNotes.push({ text: contact.notes.trim(), created: contact.created_at || new Date().toISOString(), migrated: true });
        }

        const noteIndex = existingNotes.length;
        const noteId = randomUUID();
        let attachmentsMeta = [];
        if (attachmentIds.length > 0) {
            // NOTE-ATTACH-UPLOAD-001: files pre-uploaded (staged) — link them to the note.
            attachmentsMeta = await noteAttachmentsService.associateStagedAttachments(
                companyId, 'contact', contactId, attachmentIds, noteId, noteIndex
            );
        } else if (files.length > 0) {
            attachmentsMeta = await noteAttachmentsService.createAttachments(
                companyId, 'contact', contactId, noteIndex, files, userId, { noteId }
            );
        }

        const author = req.user?.name?.split(' ')[0] || req.user?.email || null;
        const note = { id: noteId, text, created: new Date().toISOString(), created_by: userId, ...(author && { author }) };
        if (attachmentsMeta.length > 0) {
            note.attachments = attachmentsMeta.map(a => ({
                id: a.id, fileName: a.file_name, contentType: a.content_type, fileSize: a.file_size,
            }));
        }

        const updatedNotes = [...existingNotes, note];
        const db = require('../db/connection');
        await db.query(
            'UPDATE contacts SET structured_notes = $1::jsonb, updated_at = NOW() WHERE id = $2 AND company_id = $3',
            [JSON.stringify(updatedNotes), contactId, companyId]
        );

        res.json(successResponse({ notes: updatedNotes }, reqId));
    } catch (err) {
        console.error(`[ContactsAPI][${reqId}] Add note error:`, err.message);
        const status = err.status || 500;
        res.status(status).json(errorResponse('INTERNAL_ERROR', err.message, reqId));
    }
});

// ─── Edit / Delete Note (NOTES-001) ──────────────────────────────────────────

function buildContactNoteAdapter(companyId, contactId, scope) {
    const db = require('../db/connection');
    return {
        entityType: 'contact',
        attachmentEntityId: contactId,
        async loadNotes() {
            const contact = await contactsService.getById(contactId, companyId, scope);
            return contact ? (contact.structured_notes || []) : null;
        },
        async saveNotes(notes) {
            await db.query(
                'UPDATE contacts SET structured_notes = $1::jsonb, updated_at = NOW() WHERE id = $2 AND company_id = $3',
                [JSON.stringify(notes), contactId, companyId]
            );
        },
    };
}

router.patch('/:id/notes/:noteId', requirePermission('contacts.edit'), upload.array('attachments', noteAttachmentsService.MAX_FILES_PER_NOTE), async (req, res) => {
    const reqId = requestId();
    try {
        const companyId = req.companyFilter?.company_id;
        const contactId = parseInt(req.params.id, 10);
        const scope = getProviderScope(req);
        const contact = await contactsService.getById(contactId, companyId, scope);
        if (!contact) return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));

        const adapter = buildContactNoteAdapter(companyId, contactId, scope);
        const { note, oldText, addedNames, removedNames } = await notesMutationService.editNote(
            adapter,
            req.params.noteId,
            {
                text: req.body.text,
                removeAttachmentIds: parseRemoveAttachmentIds(req.body.remove_attachment_ids),
                attachmentIds: parseRemoveAttachmentIds(req.body.attachment_ids),
                files: req.files || [],
                actor: buildNoteActor(req),
                companyId,
            }
        );

        eventService.logEvent(companyId, 'contact', contactId, 'note_edited', {
            note_id: note.id, old_text: oldText, new_text: note.text,
            added: addedNames, removed: removedNames, actor_name: eventService.actorName(req),
        }, 'user', req.user?.sub);

        const enriched = await enrichContactNotes(companyId, contactId, await adapter.loadNotes());
        res.json(successResponse({ notes: enriched }, reqId));
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error(`[ContactsAPI][${reqId}] Edit note error:`, err.message);
        res.status(status).json(errorResponse(status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR', err.message, reqId));
    }
});

router.delete('/:id/notes/:noteId', requirePermission('contacts.edit'), async (req, res) => {
    const reqId = requestId();
    try {
        const companyId = req.companyFilter?.company_id;
        const contactId = parseInt(req.params.id, 10);
        const scope = getProviderScope(req);
        const contact = await contactsService.getById(contactId, companyId, scope);
        if (!contact) return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));

        const adapter = buildContactNoteAdapter(companyId, contactId, scope);
        const { note } = await notesMutationService.softDeleteNote(adapter, req.params.noteId, {
            actor: buildNoteActor(req),
            companyId,
        });

        eventService.logEvent(companyId, 'contact', contactId, 'note_deleted', {
            note_id: note.id, deleted_text: note.text || '', actor_name: eventService.actorName(req),
        }, 'user', req.user?.sub);

        const enriched = await enrichContactNotes(companyId, contactId, await adapter.loadNotes());
        res.json(successResponse({ notes: enriched }, reqId));
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error(`[ContactsAPI][${reqId}] Delete note error:`, err.message);
        res.status(status).json(errorResponse(status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR', err.message, reqId));
    }
});

module.exports = router;
