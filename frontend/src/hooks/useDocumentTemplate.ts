import { useEffect, useState } from 'react';
import { listTemplates, previewTemplate } from '../services/documentTemplatesApi';
import type { DocumentType, TemplateDescriptorV1 } from '../types/documentTemplates';

/**
 * Resolves the company's default document template descriptor for a document_type.
 * Caches the result process-wide to avoid refetching across dialogs.
 *
 * `null` used to mean BOTH "still loading" and "the fetch failed", so a template
 * error left the preview showing "Loading template…" forever — a spinner that
 * can never stop is worse than an error, because it invites you to keep waiting.
 * A failure is also no longer cached: one flaky response should not disable the
 * preview for the rest of the session.
 */

const cache = new Map<DocumentType, Promise<TemplateDescriptorV1 | null>>();

async function fetchDefault(documentType: DocumentType): Promise<TemplateDescriptorV1 | null> {
    const items = await listTemplates(documentType);
    const def = items.find(t => t.is_default) ?? items[0];
    return def ? await previewTemplate(def.id) : null;
}

export interface DocumentTemplateState {
    descriptor: TemplateDescriptorV1 | null;
    loading: boolean;
    failed: boolean;
}

export function useDocumentTemplateState(documentType: DocumentType, enabled = true): DocumentTemplateState {
    const [state, setState] = useState<DocumentTemplateState>({ descriptor: null, loading: enabled, failed: false });

    useEffect(() => {
        if (!enabled) { setState({ descriptor: null, loading: false, failed: false }); return; }
        let cancelled = false;
        setState({ descriptor: null, loading: true, failed: false });
        if (!cache.has(documentType)) {
            cache.set(documentType, fetchDefault(documentType));
        }
        cache.get(documentType)!
            .then(descriptor => { if (!cancelled) setState({ descriptor, loading: false, failed: false }); })
            .catch(() => {
                // Don't leave the rejection cached — the next open should retry.
                cache.delete(documentType);
                if (!cancelled) setState({ descriptor: null, loading: false, failed: true });
            });
        return () => { cancelled = true; };
    }, [documentType, enabled]);

    return state;
}

/** Descriptor-only view, for callers that genuinely have a sensible fallback. */
export function useDocumentTemplate(documentType: DocumentType, enabled = true) {
    return useDocumentTemplateState(documentType, enabled).descriptor;
}

export function invalidateDocumentTemplateCache(documentType?: DocumentType) {
    if (documentType) cache.delete(documentType);
    else cache.clear();
}

export function findSection(descriptor: TemplateDescriptorV1 | null, key: string) {
    return descriptor?.sections.find(s => s.key === key) ?? null;
}
