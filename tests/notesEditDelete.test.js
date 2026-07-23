/**
 * NOTES-001 — edit / soft-delete behaviour.
 *
 * Covers the shared service (notesMutationService) and the read paths
 * (eventService.getEntityHistory) that the three entity routes delegate to:
 *   - soft-delete stamps deleted_at/deleted_by and keeps the array length
 *   - getEntityHistory drops soft-deleted notes but keeps their audit events
 *   - edit returns oldText/new text + added/removed file names
 *   - edit (add + remove) calls createAttachments with note_id and
 *     deleteAttachment per removed id
 *   - jobsService.addNote stamps a stable id + created_by
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    createAttachments: jest.fn(),
    deleteAttachment: jest.fn(async () => true),
    MAX_FILES_PER_NOTE: 5,
}));
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/fsmService', () => ({}));

const noteAttachmentsService = require('../backend/src/services/noteAttachmentsService');
const notesMutationService = require('../backend/src/services/notesMutationService');
const eventService = require('../backend/src/services/eventService');
const db = require('../backend/src/db/connection');

const OWNER = 'kc-sub-owner';

function jobAdapter(notes) {
    const saved = { notes: null };
    return {
        adapter: {
            entityType: 'job',
            attachmentEntityId: 42,
            loadNotes: jest.fn(async () => notes),
            saveNotes: jest.fn(async (n) => { saved.notes = n; }),
        },
        saved,
    };
}

describe('softDeleteNote', () => {
    it('stamps deleted_at/deleted_by and keeps the array length', async () => {
        const notes = [
            { id: 'n1', text: 'keep', created_by: OWNER },
            { id: 'n2', text: 'gone', created_by: OWNER },
        ];
        const { adapter, saved } = jobAdapter(notes);

        const { note } = await notesMutationService.softDeleteNote(adapter, 'n2', {
            actor: { sub: OWNER, isAdmin: false }, companyId: 'c1',
        });

        expect(note.deleted_at).toBeTruthy();
        expect(note.deleted_by).toBe(OWNER);
        expect(saved.notes).toHaveLength(2); // soft: nothing removed from array
        expect(saved.notes.find(n => n.id === 'n2').deleted_at).toBeTruthy();
        expect(saved.notes.find(n => n.id === 'n1').deleted_at).toBeUndefined();
    });
});

describe('getEntityHistory excludes soft-deleted notes', () => {
    beforeEach(() => db.query.mockReset());

    it('drops the deleted note from the thread but keeps note_deleted/note_edited events', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                {
                    id: 1, event_type: 'note_deleted',
                    event_data: { note_id: 'n2', deleted_text: 'gone', actor_name: 'Alex' },
                    actor_type: 'user', actor_id: OWNER, created_at: new Date('2026-02-02T00:00:00Z'),
                },
                {
                    id: 2, event_type: 'note_edited',
                    event_data: { note_id: 'n1', old_text: 'a', new_text: 'b', added: ['x.png'], removed: [], actor_name: 'Alex' },
                    actor_type: 'user', actor_id: OWNER, created_at: new Date('2026-02-03T00:00:00Z'),
                },
                {
                    id: 3, event_type: 'note_added',
                    event_data: {}, actor_type: 'user', actor_id: OWNER, created_at: new Date('2026-02-01T00:00:00Z'),
                },
            ],
        });

        const entityNotes = [
            { id: 'n1', text: 'b', created: '2026-02-03T00:00:00Z' },
            { id: 'n2', text: 'gone', created: '2026-02-01T00:00:00Z', deleted_at: '2026-02-02T00:00:00Z' },
        ];

        const history = await eventService.getEntityHistory('c1', 'job', 42, entityNotes);

        const notesInThread = history.filter(h => h.type === 'note');
        expect(notesInThread.map(n => n.text)).toEqual(['b']); // n2 gone
        expect(notesInThread.find(n => n.text === 'gone')).toBeUndefined();

        // Audit events survive (note_added stays suppressed).
        const eventTypes = history.filter(h => h.type === 'event').map(h => h.event_type);
        expect(eventTypes).toContain('note_deleted');
        expect(eventTypes).toContain('note_edited');
        expect(eventTypes).not.toContain('note_added');

        // describeEvent renders the file-count suffix for the edit.
        const edited = history.find(h => h.event_type === 'note_edited');
        expect(edited.description).toMatch(/Note edited/);
        expect(edited.description).toMatch(/\+1 file/);
        const deleted = history.find(h => h.event_type === 'note_deleted');
        expect(deleted.description).toBe('Note deleted');
    });
});

describe('editNote', () => {
    beforeEach(() => {
        noteAttachmentsService.createAttachments.mockReset();
        noteAttachmentsService.deleteAttachment.mockReset();
        noteAttachmentsService.deleteAttachment.mockResolvedValue(true);
    });

    it('returns oldText + new text and added/removed file names; persists edited_at/edited_by', async () => {
        noteAttachmentsService.createAttachments.mockResolvedValue([
            { id: 99, file_name: 'new.pdf', content_type: 'application/pdf', file_size: 10 },
        ]);
        const notes = [{
            id: 'n1', text: 'old text', created_by: OWNER,
            attachments: [{ id: 7, fileName: 'old.png' }],
        }];
        const { adapter } = jobAdapter(notes);

        const result = await notesMutationService.editNote(adapter, 'n1', {
            text: '  new text  ',
            removeAttachmentIds: [7],
            files: [{ originalname: 'new.pdf' }],
            actor: { sub: OWNER, isAdmin: false, crmUserId: OWNER },
            companyId: 'c1',
        });

        expect(result.oldText).toBe('old text');
        expect(result.note.text).toBe('new text'); // trimmed
        expect(result.note.edited_at).toBeTruthy();
        expect(result.note.edited_by).toBe(OWNER);
        expect(result.removedNames).toEqual(['old.png']);
        expect(result.addedNames).toEqual(['new.pdf']);

        // Removed attachment dropped, added one appended.
        const ids = result.note.attachments.map(a => a.id);
        expect(ids).toContain(99);
        expect(ids).not.toContain(7);
    });

    it('on add+remove: deleteAttachment per removed id (company-scoped) and createAttachments with note_id', async () => {
        noteAttachmentsService.createAttachments.mockResolvedValue([
            { id: 100, file_name: 'a.pdf', content_type: 'application/pdf', file_size: 1 },
        ]);
        const notes = [{
            id: 'note-xyz', text: 't', created_by: OWNER,
            attachments: [{ id: 11, fileName: 'one.png' }, { id: 12, fileName: 'two.png' }],
        }];
        const { adapter } = jobAdapter(notes);

        await notesMutationService.editNote(adapter, 'note-xyz', {
            text: 't2',
            removeAttachmentIds: [11, 12],
            files: [{ originalname: 'a.pdf' }],
            actor: { sub: OWNER, isAdmin: false, crmUserId: 'crm-1' },
            companyId: 'company-99',
        });

        // deleteAttachment called once per removed id, company-scoped.
        expect(noteAttachmentsService.deleteAttachment).toHaveBeenCalledTimes(2);
        expect(noteAttachmentsService.deleteAttachment).toHaveBeenCalledWith('company-99', 11);
        expect(noteAttachmentsService.deleteAttachment).toHaveBeenCalledWith('company-99', 12);

        // createAttachments stamped with the note id.
        expect(noteAttachmentsService.createAttachments).toHaveBeenCalledTimes(1);
        const callArgs = noteAttachmentsService.createAttachments.mock.calls[0];
        // (companyId, entityType, entityId, noteIndex, files, crmUserId, opts)
        expect(callArgs[0]).toBe('company-99');
        expect(callArgs[1]).toBe('job');
        expect(callArgs[2]).toBe(42); // attachmentEntityId
        expect(callArgs[5]).toBe('crm-1'); // crmUserId
        expect(callArgs[6]).toMatchObject({ noteId: 'note-xyz' });
    });
});

describe('jobsService.addNote stamps id + created_by', () => {
    beforeEach(() => db.query.mockReset());

    it('writes a note with a stable id and the actor created_by', async () => {
        const jobsService = require('../backend/src/services/jobsService');
        // getJobById: first query returns the job row, second (lead serial join) returns none.
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 5, notes: [], company_id: 'c1' }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValue({ rows: [] }); // the UPDATE

        const result = await jobsService.addNote(
            5,
            'hi',
            [],
            'Alex',
            'crm-user-123',
            null,
            'c1'
        );

        const note = result.notes[result.notes.length - 1];
        expect(note.id).toBeTruthy();
        expect(typeof note.id).toBe('string');
        expect(note.created_by).toBe('crm-user-123');
        expect(note.text).toBe('hi');
    });

    it('fails closed before an ID-only note write when companyId is missing', async () => {
        const jobsService = require('../backend/src/services/jobsService');
        await expect(jobsService.addNote(5, 'hi', [], 'Alex', 'crm-user-123'))
            .rejects.toMatchObject({
                code: 'TENANT_CONTEXT_REQUIRED',
                httpStatus: 403,
            });
        expect(db.query).not.toHaveBeenCalled();
    });
});
