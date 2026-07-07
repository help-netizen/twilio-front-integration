/**
 * notesMutationService.js — shared edit / soft-delete logic for unified notes
 * (NOTES-001).
 *
 * Notes live as JSONB arrays on three different entities (jobs.notes,
 * leads.structured_notes, contacts.structured_notes). The per-entity routes
 * supply an `adapter` that knows how to load and save that array and which
 * entity key the note_attachments rows are scoped to; everything else (the
 * permission gate, attachment add/remove, audit metadata) lives here so the
 * behaviour stays identical across entities.
 *
 *   adapter = {
 *     entityType,            // 'job' | 'lead' | 'contact'
 *     attachmentEntityId,    // note_attachments.entity_id for this entity
 *     loadNotes(),           // -> Promise<Array<note>>
 *     saveNotes(notes),      // -> Promise<void>
 *   }
 *
 *   actor = { sub, crmUserId, name }
 *     sub       — Keycloak sub (stamped into created_by / edited_by / deleted_by)
 *     crmUserId — crm_users.id used for note_attachments.uploaded_by
 *     name      — display name (unused here; routes build actor_name themselves)
 */

const noteAttachmentsService = require('./noteAttachmentsService');

/**
 * Server-side authority for whether `actor` may mutate `note`.
 * ZB-synced and legacy/no-author notes are admin-only; otherwise owner-only.
 */
function canMutateNote(note, { isAdmin, actorSub, actorCrmUserId }) {
    if (isAdmin) return true;
    if (!note) return false;
    // Notes that ORIGINATED in Zenbooker are admin-only — but discriminate origin by
    // the LOCAL author, NOT by zb_note_id alone. An app-authored note acquires a
    // zb_note_id when we push it OUT to Zenbooker (write-through); that must NOT strip
    // its author's edit/delete rights (NOTE-ZB-AUTHOR-FIX-001). A genuine ZB-origin
    // note carries an explicit `source: 'zenbooker'` and/or no local `created_by`.
    if (note.source === 'zenbooker') return false;                    // explicit external origin → admin only
    if (!note.created_by) return false;                               // no local author (incl. ZB-pulled) → admin only
    // created_by may be the Keycloak sub OR the crm_users.id — the POST-note path
    // stamped `crmUser.id || sub`, so a non-admin author whose crm_users.id differs
    // from their sub would otherwise lose edit/delete on their own note. Match either
    // (NOTE-AUTHOR-FIX-001).
    return note.created_by === actorSub
        || (actorCrmUserId != null && note.created_by === actorCrmUserId);
}

function findActiveNote(notes, noteId) {
    const idx = (notes || []).findIndex(n => n && n.id === noteId && !n.deleted_at);
    return idx === -1 ? { note: null, index: -1 } : { note: notes[idx], index: idx };
}

/**
 * Edit a note: replace text, add new file attachments, remove existing ones.
 * Returns { note, oldText, addedNames, removedNames } for audit logging.
 */
async function editNote(adapter, noteId, { text, removeAttachmentIds = [], files = [], attachmentIds = [], actor, companyId }) {
    const notes = await adapter.loadNotes();
    const { note, index } = findActiveNote(notes, noteId);
    if (!note) throw Object.assign(new Error('Note not found'), { status: 404 });

    const isAdmin = !!actor?.isAdmin;
    if (!canMutateNote(note, { isAdmin, actorSub: actor?.sub, actorCrmUserId: actor?.crmUserId })) {
        throw Object.assign(new Error('Not allowed to edit this note'), { status: 403 });
    }

    const oldText = note.text || '';
    const removedNames = [];
    const addedNames = [];

    // Remove requested attachments (DB + S3, company-scoped) and drop from the note.
    const removeIds = (removeAttachmentIds || []).map(id => String(id));
    if (removeIds.length > 0) {
        const surviving = [];
        for (const att of (note.attachments || [])) {
            if (removeIds.includes(String(att.id))) {
                removedNames.push(att.fileName || att.file_name || String(att.id));
                await noteAttachmentsService.deleteAttachment(companyId, att.id);
            } else {
                surviving.push(att);
            }
        }
        note.attachments = surviving;
    }

    // Add new attachments (capped at MAX counting survivors), stamping note_id = noteId.
    // Prefer pre-staged ids (NOTE-ATTACH-UPLOAD-001 — uploaded on attach); fall back to
    // raw files (back-compat / old clients).
    const survivingCount = (note.attachments || []).length;
    let created = [];
    if (attachmentIds && attachmentIds.length > 0) {
        created = await noteAttachmentsService.associateStagedAttachments(
            companyId,
            adapter.entityType,
            adapter.attachmentEntityId,
            attachmentIds,
            noteId,
            index,
            { existingCount: survivingCount }
        );
    } else if (files && files.length > 0) {
        created = await noteAttachmentsService.createAttachments(
            companyId,
            adapter.entityType,
            adapter.attachmentEntityId,
            index,
            files,
            actor?.crmUserId || null,
            { noteId, existingCount: survivingCount }
        );
    }
    if (created.length > 0) {
        const normalized = created.map(a => ({
            id: a.id,
            fileName: a.file_name,
            contentType: a.content_type,
            fileSize: a.file_size,
        }));
        normalized.forEach(a => addedNames.push(a.fileName));
        note.attachments = [...(note.attachments || []), ...normalized];
    }

    note.text = typeof text === 'string' ? text.trim() : (note.text || '');
    note.edited_at = new Date().toISOString();
    note.edited_by = actor?.sub || null;

    notes[index] = note;
    await adapter.saveNotes(notes);

    return { note, oldText, addedNames, removedNames };
}

/**
 * Soft-delete a note: stamp deleted_at/deleted_by, keep it in the array.
 * Returns { note } for audit logging.
 */
async function softDeleteNote(adapter, noteId, { actor, companyId }) {
    const notes = await adapter.loadNotes();
    const { note, index } = findActiveNote(notes, noteId);
    if (!note) throw Object.assign(new Error('Note not found'), { status: 404 });

    const isAdmin = !!actor?.isAdmin;
    if (!canMutateNote(note, { isAdmin, actorSub: actor?.sub, actorCrmUserId: actor?.crmUserId })) {
        throw Object.assign(new Error('Not allowed to delete this note'), { status: 403 });
    }

    note.deleted_at = new Date().toISOString();
    note.deleted_by = actor?.sub || null;

    notes[index] = note;
    await adapter.saveNotes(notes);

    return { note };
}

module.exports = { canMutateNote, editNote, softDeleteNote };
