import { describe, expect, it } from 'vitest';
import { prepareNotesForDisplay } from './notesDisplay';

describe('prepareNotesForDisplay', () => {
    it('gives duplicate note ids distinct stable composite render keys', () => {
        const displayed = prepareNotesForDisplay([
            { id: '1784577133566x501798706937856000', created: '2026-07-20T10:00:00.000Z' },
            { id: '1784577133566x501798706937856000', created: '2026-07-20T10:00:00.000Z' },
        ]);

        expect(displayed.map(item => item.renderKey)).toEqual([
            '1784577133566x501798706937856000:0',
            '1784577133566x501798706937856000:1',
        ]);
        expect(new Set(displayed.map(item => item.renderKey))).toHaveProperty('size', 2);
    });

    it('sorts newest first and keeps missing or invalid created values oldest in insertion order', () => {
        const displayed = prepareNotesForDisplay([
            { id: 'missing-first' },
            { id: 'newest', created: '2026-07-21T12:00:00.000Z' },
            { id: 'invalid-second', created: 'not-a-date' },
            { id: 'older', created: '2026-07-20T12:00:00.000Z' },
        ]);

        expect(displayed.map(item => item.note.id)).toEqual([
            'newest',
            'older',
            'missing-first',
            'invalid-second',
        ]);
    });
});
