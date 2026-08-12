import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { authedFetch } from '../../services/apiClient';
import { useIsMobile } from '../../hooks/useIsMobile';
import { FullscreenImageViewer, type ViewerImage } from './FullscreenImageViewer';

/**
 * One gallery for a whole notes feed.
 *
 * Attachments used to be independent: each thumbnail asked for its own presigned
 * URL — and only on mouseenter, so on a phone (no hover) previews never appeared
 * at all and you had to open every image to find the one you wanted. Worse, the
 * viewer could only ever page within a single note.
 *
 * The feed now owns the gallery. Every note registers its images here in render
 * order, one request fetches all the URLs, and opening any image lets the arrow
 * keys walk the entire history rather than one note's worth.
 */

export interface GalleryImage {
    id: number | string;
    fileName: string;
    /** Present for imported attachments that already carry a direct link. */
    url?: string;
}

interface ResolvedUrls {
    url: string | null;
    thumbUrl: string | null;
}

interface GalleryContextValue {
    register: (groupKey: string, images: GalleryImage[]) => void;
    unregister: (groupKey: string) => void;
    urlsFor: (id: number | string) => ResolvedUrls;
    open: (id: number | string) => void;
}

const GalleryContext = createContext<GalleryContextValue | null>(null);

function keyOf(id: number | string): string {
    return String(id);
}

export function NoteGalleryProvider({ children }: { children: ReactNode }) {
    const isMobile = useIsMobile();
    // Insertion order is feed order, which is the order the arrows should follow.
    const groupsRef = useRef<Map<string, GalleryImage[]>>(new Map());
    const [flat, setFlat] = useState<GalleryImage[]>([]);
    const [urls, setUrls] = useState<Record<string, ResolvedUrls>>({});
    const [openIndex, setOpenIndex] = useState<number | null>(null);

    const reflow = useCallback(() => {
        const next: GalleryImage[] = [];
        for (const images of groupsRef.current.values()) next.push(...images);
        setFlat(next);
    }, []);

    const register = useCallback((groupKey: string, images: GalleryImage[]) => {
        groupsRef.current.set(groupKey, images);
        reflow();
    }, [reflow]);

    const unregister = useCallback((groupKey: string) => {
        groupsRef.current.delete(groupKey);
        reflow();
    }, [reflow]);

    // One batched request for everything the feed shows — not one per thumbnail.
    useEffect(() => {
        const missing = flat
            .filter(image => !image.url && !urls[keyOf(image.id)])
            .map(image => image.id);
        if (missing.length === 0) return;
        let cancelled = false;
        (async () => {
            try {
                const response = await authedFetch('/api/note-attachments/urls', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: missing }),
                });
                const payload = await response.json();
                if (cancelled || !payload?.ok) return;
                setUrls(previous => {
                    const next = { ...previous };
                    for (const [id, value] of Object.entries(payload.urls || {})) {
                        const entry = value as { url?: string; thumb_url?: string };
                        next[id] = { url: entry.url ?? null, thumbUrl: entry.thumb_url ?? null };
                    }
                    return next;
                });
            } catch (error) {
                console.error('[NoteGallery] could not resolve attachment urls:', error);
            }
        })();
        return () => { cancelled = true; };
    }, [flat, urls]);

    const urlsFor = useCallback((id: number | string): ResolvedUrls => {
        const image = flat.find(candidate => keyOf(candidate.id) === keyOf(id));
        if (image?.url) return { url: image.url, thumbUrl: image.url };
        return urls[keyOf(id)] || { url: null, thumbUrl: null };
    }, [flat, urls]);

    const open = useCallback((id: number | string) => {
        const index = flat.findIndex(candidate => keyOf(candidate.id) === keyOf(id));
        if (index < 0) return;
        // A phone gets the browser's own image view: panning and pinch-zoom are
        // better there than anything an overlay can offer.
        if (isMobile) {
            const resolved = urlsFor(id);
            if (resolved.url) window.open(resolved.url, '_blank', 'noopener');
            return;
        }
        setOpenIndex(index);
    }, [flat, isMobile, urlsFor]);

    const viewerImages: ViewerImage[] = useMemo(() => flat
        .map(image => ({ url: urlsFor(image.id).url || '', filename: image.fileName }))
        .filter(image => image.url), [flat, urlsFor]);

    const value = useMemo(
        () => ({ register, unregister, urlsFor, open }),
        [register, unregister, urlsFor, open]
    );

    return (
        <GalleryContext.Provider value={value}>
            {children}
            {openIndex !== null && viewerImages.length > 0 && (
                <FullscreenImageViewer
                    images={viewerImages}
                    initialIndex={Math.min(openIndex, viewerImages.length - 1)}
                    onClose={() => setOpenIndex(null)}
                />
            )}
        </GalleryContext.Provider>
    );
}

/**
 * Registers a note's images with the feed gallery. Outside a provider it degrades
 * to opening the original in a new tab, so an attachment list dropped anywhere
 * still works.
 */
export function useNoteGallery(groupKey: string, images: GalleryImage[]) {
    const context = useContext(GalleryContext);
    const signature = images.map(image => `${image.id}`).join(',');

    useEffect(() => {
        if (!context) return;
        context.register(groupKey, images);
        return () => context.unregister(groupKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [groupKey, signature, context?.register, context?.unregister]);

    return context;
}
