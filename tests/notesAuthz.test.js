/**
 * NOTES-001 — note-mutation authorization matrix.
 *
 * Locks the server-side permission rule (canMutateNote) and the 404-vs-403
 * ordering: a note that doesn't exist on the (company-scoped) entity is a 404,
 * the permission gate only runs on a note that was actually found.
 */

jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    createAttachments: jest.fn(async () => []),
    deleteAttachment: jest.fn(async () => true),
    MAX_FILES_PER_NOTE: 5,
}));

const notesMutationService = require('../backend/src/services/notesMutationService');
const { canMutateNote } = notesMutationService;

const OWNER = 'kc-sub-owner';
const OTHER = 'kc-sub-other';

describe('canMutateNote matrix', () => {
    it('owner editing their own note → ok', () => {
        const note = { id: 'n1', created_by: OWNER };
        expect(canMutateNote(note, { isAdmin: false, actorSub: OWNER })).toBe(true);
    });

    it('non-admin editing someone else\'s note → denied', () => {
        const note = { id: 'n1', created_by: OWNER };
        expect(canMutateNote(note, { isAdmin: false, actorSub: OTHER })).toBe(false);
    });

    it('legacy note with no created_by → admin-only (non-admin denied)', () => {
        const note = { id: 'n1' }; // no created_by
        expect(canMutateNote(note, { isAdmin: false, actorSub: OWNER })).toBe(false);
        expect(canMutateNote(note, { isAdmin: true, actorSub: OWNER })).toBe(true);
    });

    it('zenbooker-sourced note → admin-only (non-admin denied even if owner)', () => {
        const bySource = { id: 'n1', created_by: OWNER, source: 'zenbooker' };
        const byZbId = { id: 'n1', created_by: OWNER, zb_note_id: '123x456' };
        expect(canMutateNote(bySource, { isAdmin: false, actorSub: OWNER })).toBe(false);
        expect(canMutateNote(byZbId, { isAdmin: false, actorSub: OWNER })).toBe(false);
        expect(canMutateNote(bySource, { isAdmin: true, actorSub: OWNER })).toBe(true);
        expect(canMutateNote(byZbId, { isAdmin: true, actorSub: OWNER })).toBe(true);
    });

    it('admin can mutate any note', () => {
        expect(canMutateNote({ id: 'n', created_by: OTHER }, { isAdmin: true, actorSub: OWNER })).toBe(true);
    });
});

describe('404 vs 403 ordering through the service', () => {
    function adapterWith(notes) {
        return {
            entityType: 'job',
            attachmentEntityId: 1,
            loadNotes: jest.fn(async () => notes),
            saveNotes: jest.fn(async () => {}),
        };
    }

    it('cross-company / missing note id → 404 (before the permission gate)', async () => {
        // Simulates a company-scoped entity that has no note with that id.
        const adapter = adapterWith([{ id: 'other-note', created_by: OWNER }]);
        await expect(
            notesMutationService.editNote(adapter, 'does-not-exist', {
                text: 'x', actor: { sub: OWNER, isAdmin: false }, companyId: 'c1',
            })
        ).rejects.toMatchObject({ status: 404 });
        expect(adapter.saveNotes).not.toHaveBeenCalled();
    });

    it('existing note the actor may not touch → 403', async () => {
        const adapter = adapterWith([{ id: 'n1', created_by: OWNER }]);
        await expect(
            notesMutationService.editNote(adapter, 'n1', {
                text: 'x', actor: { sub: OTHER, isAdmin: false }, companyId: 'c1',
            })
        ).rejects.toMatchObject({ status: 403 });
        expect(adapter.saveNotes).not.toHaveBeenCalled();
    });

    it('soft-deleted note is treated as not found (404)', async () => {
        const adapter = adapterWith([{ id: 'n1', created_by: OWNER, deleted_at: '2026-01-01T00:00:00Z' }]);
        await expect(
            notesMutationService.softDeleteNote(adapter, 'n1', {
                actor: { sub: OWNER, isAdmin: false }, companyId: 'c1',
            })
        ).rejects.toMatchObject({ status: 404 });
    });
});
