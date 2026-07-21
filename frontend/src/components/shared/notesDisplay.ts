export interface NoteDisplayInput {
    id?: string | null;
    created?: string | null;
}

export interface DisplayNote<T> {
    note: T;
    originalIndex: number;
    renderKey: string;
}

function noteTime(created?: string | null): number {
    if (!created) return Number.NEGATIVE_INFINITY;
    const time = Date.parse(created);
    return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

/** Newest first; missing/invalid timestamps are oldest and retain insertion order. */
export function prepareNotesForDisplay<T extends NoteDisplayInput>(notes: T[]): DisplayNote<T>[] {
    return notes
        .map((note, originalIndex) => ({
            note,
            originalIndex,
            renderKey: `${note.id ?? 'note-without-id'}:${originalIndex}`,
        }))
        .sort((a, b) => {
            const byTime = noteTime(b.note.created) - noteTime(a.note.created);
            return byTime || a.originalIndex - b.originalIndex;
        });
}
