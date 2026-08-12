import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NoteGalleryProvider } from './NoteGallery';
import { NoteAttachmentDisplay } from './NoteAttachmentDisplay';
import galleryRaw from './NoteGallery.tsx?raw';
import displayRaw from './NoteAttachmentDisplay.tsx?raw';

vi.mock('../../services/apiClient', () => ({ authedFetch: vi.fn(async () => ({ json: async () => ({ ok: true, urls: {} }) })) }));

const image = (id: number, fileName: string) => ({
    id, fileName, contentType: 'image/jpeg', fileSize: 900_000,
});

describe('note attachment previews', () => {
    it('renders a thumbnail slot for every image without waiting for a hover', () => {
        // The old component only asked for a URL in onMouseEnter, so a phone —
        // which has no hover — never showed a single preview.
        expect(displayRaw).not.toContain('onMouseEnter');
        expect(galleryRaw).toContain("'/api/note-attachments/urls'");

        const markup = renderToStaticMarkup(
            <NoteGalleryProvider>
                <NoteAttachmentDisplay attachments={[image(1, 'a.jpg'), image(2, 'b.jpg')]} groupKey="note-1" />
            </NoteGalleryProvider>
        );
        expect(markup.match(/a\.jpg/g)?.length).toBeTruthy();
        expect(markup).toContain('b.jpg');
    });

    it('asks for every attachment’s url in ONE request, not one per thumbnail', () => {
        // A feed with twenty photos used to fire twenty presign roundtrips.
        expect(galleryRaw).toContain('body: JSON.stringify({ ids: missing })');
    });

    it('keeps the phone on the browser’s own image view', () => {
        expect(galleryRaw).toContain('if (isMobile)');
        expect(galleryRaw).toContain("window.open(resolved.url, '_blank', 'noopener')");
    });

    it('pages across the whole feed, not a single note', () => {
        // Groups are flattened in registration order, which is feed order.
        expect(galleryRaw).toContain('for (const images of groupsRef.current.values()) next.push(...images);');
        expect(galleryRaw).toContain('<FullscreenImageViewer');
    });

    it('still shows a file row for non-images', () => {
        const markup = renderToStaticMarkup(
            <NoteGalleryProvider>
                <NoteAttachmentDisplay
                    attachments={[{ id: 9, fileName: 'report.pdf', contentType: 'application/pdf', fileSize: 12_000 }]}
                    groupKey="note-9"
                />
            </NoteGalleryProvider>
        );
        expect(markup).toContain('report.pdf');
    });
});
