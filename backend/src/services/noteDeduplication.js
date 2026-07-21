'use strict';

function hasValue(value) {
    return value !== undefined && value !== null && String(value).trim() !== '';
}

function noteIdentity(note) {
    if (!note || typeof note !== 'object') return null;
    const id = note.zb_note_id || note.id;
    return hasValue(id) ? String(id) : null;
}

function noteRichness(note) {
    if (!note || typeof note !== 'object') return 0;

    // Local mutation markers outweigh passive import metadata. This keeps an
    // Albusto edit/soft-delete authoritative when it collides with a bare ZB
    // copy, then uses the requested augmentation fields to break ordinary ties.
    let score = 0;
    if (hasValue(note.deleted_at)) score += 32;
    if (hasValue(note.edited_at)) score += 16;
    if (hasValue(note.created_by)) score += 8;
    if (hasValue(note.deleted_by)) score += 4;
    if (hasValue(note.edited_by)) score += 4;
    if (Array.isArray(note.attachments) && note.attachments.length > 0) score += 2;
    if (hasValue(note.created)) score += 1;
    return score;
}

/**
 * Collapse notes sharing (zb_note_id || id), preserving the first position but
 * replacing its value when a later collision contains richer local metadata.
 * Notes without an identity are kept as distinct array elements.
 */
function deduplicateNotesByIdentity(notes) {
    if (!Array.isArray(notes)) return [];

    const deduplicated = [];
    const indexById = new Map();

    for (const note of notes) {
        const id = noteIdentity(note);
        if (!id || !indexById.has(id)) {
            if (id) indexById.set(id, deduplicated.length);
            deduplicated.push(note);
            continue;
        }

        const index = indexById.get(id);
        if (noteRichness(note) > noteRichness(deduplicated[index])) {
            deduplicated[index] = note;
        }
    }

    return deduplicated;
}

module.exports = {
    deduplicateNotesByIdentity,
    noteIdentity,
    noteRichness,
};
