/**
 * Regression guard: jobsService.mergeNotes — note-id stability (NOTES-ID-STABLE-001)
 *
 * Prod bug: on a ZB-linked job, adding a note then immediately editing/deleting it
 * failed ("Note not found" / 404) until a page refresh. Cause: when Zenbooker
 * echoed the note back via `job.note_added`, mergeNotes could not correlate the
 * echo to the freshly-created local note (the text-match fallback was gated on
 * `!ln.id`, and a just-created note has a local id but no zb_note_id yet), so it
 * re-id'd the note to the ZB id and the client's stored id went stale.
 *
 * The fix: text-match ANY not-yet-correlated local note (preserving its local id),
 * and carry forward Albusto-authored notes ZB hasn't echoed yet (never drop/re-id
 * a fresh note) — while still honouring genuine ZB-side deletes of correlated notes.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const { mergeNotes } = require('../backend/src/services/jobsService');

const freshLocal = (over = {}) => ({
    id: 'uuid-A', text: 'call the customer', created: '2026-06-30T10:00:00Z',
    created_by: 'user-1', author: 'Rus', ...over,
});

describe('mergeNotes — note-id stability (NOTES-ID-STABLE-001)', () => {
    test('existing duplicate id collapses to its richest locally-edited survivor', () => {
        const duplicateId = '1784577133566x501798706937856000';
        const bare = { id: duplicateId, text: 'original ZB text' };
        const rich = freshLocal({
            id: duplicateId,
            zb_note_id: duplicateId,
            text: 'EDITED locally',
            attachments: [{ id: 12, fileName: 'photo.jpg' }],
            edited_at: '2026-07-21T12:00:00Z',
        });

        const out = mergeNotes([bare, rich], [{ id: duplicateId, text: 'original ZB text' }]);

        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            id: duplicateId,
            zb_note_id: duplicateId,
            text: 'EDITED locally',
            edited_at: '2026-07-21T12:00:00Z',
        });
        expect(out[0].attachments).toEqual(rich.attachments);
    });

    test('echo with a DIFFERENT id, same text → local id preserved (the bug)', () => {
        const local = [freshLocal()];                       // id=uuid-A, no zb_note_id
        const zb = [{ id: 9001, text: 'call the customer' }]; // ZB echoes with its own id
        const out = mergeNotes(local, zb);

        expect(out).toHaveLength(1);                          // no duplicate
        expect(out[0].id).toBe('uuid-A');                    // <-- local id kept (was the bug)
        expect(String(out[0].zb_note_id)).toBe('9001');      // now correlated for next sync
        expect(out[0].text).toBe('call the customer');
    });

    test('fresh note not yet echoed → carried forward, not dropped or re-id\'d', () => {
        const local = [freshLocal()];
        const zb = [{ id: 5, text: 'a pre-existing ZB note' }]; // echo not here yet
        const out = mergeNotes(local, zb);

        const kept = out.find(n => n.id === 'uuid-A');
        expect(kept).toBeTruthy();                            // preserved
        expect(kept.zb_note_id).toBeUndefined();             // still un-correlated
        expect(out).toHaveLength(2);
    });

    test('correlated note ZB no longer returns → honoured as a ZB-side delete', () => {
        const local = [freshLocal({ id: 'uuid-B', zb_note_id: '7', text: 'was echoed once' })];
        const zb = [];                                        // ZB dropped it
        const out = mergeNotes(local, zb);
        expect(out).toHaveLength(0);                          // not resurrected
    });

    test('soft-deleted fresh note is not resurrected', () => {
        const local = [freshLocal({ deleted_at: '2026-06-30T11:00:00Z', deleted_by: 'user-1' })];
        const out = mergeNotes(local, []);
        expect(out).toHaveLength(0);
    });

    test('local edit still wins on re-sync (does not silently revert)', () => {
        const local = [freshLocal({ zb_note_id: '42', text: 'EDITED locally', edited_at: '2026-06-30T12:00:00Z' })];
        const zb = [{ id: 42, text: 'original ZB text' }];
        const out = mergeNotes(local, zb);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('uuid-A');
        expect(out[0].text).toBe('EDITED locally');
    });

    test('two fresh notes with identical text keep both local ids on echo', () => {
        const local = [freshLocal({ id: 'uuid-A' }), freshLocal({ id: 'uuid-B' })];
        const zb = [{ id: 1, text: 'call the customer' }, { id: 2, text: 'call the customer' }];
        const out = mergeNotes(local, zb);
        expect(out).toHaveLength(2);
        expect(new Set(out.map(n => n.id))).toEqual(new Set(['uuid-A', 'uuid-B']));
    });

    // Review-caught seam: the text-match gate and the `unechoed` filter must agree,
    // else an author-less (legacy) local note is appended AND left un-matched → dup.
    test('author-less local note (legacy) merges on echo without a duplicate', () => {
        const local = [freshLocal({ author: undefined })]; // has id + created_by, no author
        const zb = [{ id: 9002, text: 'call the customer' }];
        const out = mergeNotes(local, zb);
        expect(out).toHaveLength(1);                        // no duplicate
        expect(out[0].id).toBe('uuid-A');                  // local id preserved
        expect(String(out[0].zb_note_id)).toBe('9002');
    });
});
