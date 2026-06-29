import { authedFetch } from './apiClient';

export type NoteEntityType = 'job' | 'lead' | 'contact';

export interface StagedAttachment {
    id: number;
    fileName: string;
    contentType: string;
    fileSize: number;
}

async function unwrap<T>(res: Response): Promise<T> {
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.ok === false) {
        throw new Error(json?.error || json?.message || `Request failed: ${res.status}`);
    }
    return json.data as T;
}

/**
 * NOTE-ATTACH-UPLOAD-001 — stage one file immediately on attach (before the note is
 * saved). Returns the attachment id the note-create/edit later associates.
 */
export async function uploadStagedAttachment(entityType: NoteEntityType, entityId: number | string, file: File): Promise<StagedAttachment> {
    const fd = new FormData();
    fd.append('entity_type', entityType);
    fd.append('entity_id', String(entityId));
    fd.append('attachments', file);
    const res = await authedFetch('/api/note-attachments/upload', { method: 'POST', body: fd });
    const data = await unwrap<{ attachments: Array<{ id: number; file_name: string; content_type: string; file_size: number }> }>(res);
    const a = data.attachments[0];
    return { id: a.id, fileName: a.file_name, contentType: a.content_type, fileSize: a.file_size };
}

/** Roll back a staged (or any) attachment the user removed. Best-effort. */
export async function deleteStagedAttachment(id: number): Promise<void> {
    await authedFetch(`/api/note-attachments/${id}`, { method: 'DELETE' });
}
