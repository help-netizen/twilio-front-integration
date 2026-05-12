import { authedFetch } from './apiClient';
import type { DocumentTemplate, DocumentType, TemplateDescriptorV1 } from '../types/documentTemplates';

const API_BASE = '/api/document-templates';

async function ok<T>(res: Response): Promise<T> {
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Request failed: ${res.status} ${text}`);
        (err as Error & { status: number }).status = res.status;
        throw err;
    }
    return res.json() as Promise<T>;
}

export async function listTemplates(documentType?: DocumentType): Promise<DocumentTemplate[]> {
    const url = documentType ? `${API_BASE}?document_type=${encodeURIComponent(documentType)}` : API_BASE;
    const res = await authedFetch(url);
    const json = await ok<{ items: DocumentTemplate[] }>(res);
    return json.items;
}

export async function getTemplate(id: number): Promise<DocumentTemplate> {
    const res = await authedFetch(`${API_BASE}/${id}`);
    return ok<DocumentTemplate>(res);
}

export async function updateTemplate(
    id: number,
    payload: { name?: string; content?: TemplateDescriptorV1 },
): Promise<DocumentTemplate> {
    const res = await authedFetch(`${API_BASE}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    return ok<DocumentTemplate>(res);
}

export async function resetTemplate(id: number): Promise<DocumentTemplate> {
    const res = await authedFetch(`${API_BASE}/${id}/reset`, { method: 'POST' });
    return ok<DocumentTemplate>(res);
}

export async function getFactoryDescriptor(documentType: DocumentType): Promise<{
    document_type: DocumentType;
    schema_version: number;
    content: TemplateDescriptorV1;
}> {
    const res = await authedFetch(`${API_BASE}/factory/${encodeURIComponent(documentType)}`);
    return ok(res);
}
