import { useEffect, useState } from 'react';
import { listTemplates } from '../services/documentTemplatesApi';
import type { DocumentType, TemplateDescriptorV1 } from '../types/documentTemplates';

/**
 * Resolves the company's default document template descriptor for a document_type.
 * Caches the result process-wide to avoid refetching across dialogs.
 *
 * Returns `null` while loading or if the fetch fails (callers should fall back
 * to a sensible default).
 */

const cache = new Map<DocumentType, Promise<TemplateDescriptorV1 | null>>();

async function fetchDefault(documentType: DocumentType): Promise<TemplateDescriptorV1 | null> {
    try {
        const items = await listTemplates(documentType);
        const def = items.find(t => t.is_default) ?? items[0];
        return def?.content ?? null;
    } catch {
        return null;
    }
}

export function useDocumentTemplate(documentType: DocumentType, enabled = true) {
    const [descriptor, setDescriptor] = useState<TemplateDescriptorV1 | null>(null);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        if (!cache.has(documentType)) {
            cache.set(documentType, fetchDefault(documentType));
        }
        cache.get(documentType)!.then(d => {
            if (!cancelled) setDescriptor(d);
        });
        return () => {
            cancelled = true;
        };
    }, [documentType, enabled]);

    return descriptor;
}

export function invalidateDocumentTemplateCache(documentType?: DocumentType) {
    if (documentType) cache.delete(documentType);
    else cache.clear();
}

export function findSection(descriptor: TemplateDescriptorV1 | null, key: string) {
    return descriptor?.sections.find(s => s.key === key) ?? null;
}
