import { FileText, ExternalLink, Loader2 } from 'lucide-react';
import { useNoteGallery, type GalleryImage } from './NoteGallery';

interface Attachment {
    id: number | string;
    fileName: string;
    contentType: string;
    fileSize: number;
    // When present (e.g. imported links), use the URL directly and skip the
    // /api/note-attachments presigned-URL roundtrip.
    url?: string;
    source?: string;
}

interface NoteAttachmentDisplayProps {
    attachments: Attachment[];
    /** Identifies this note inside the feed gallery — images page across notes. */
    groupKey?: string;
}

function isImage(contentType: string): boolean {
    return contentType.startsWith('image/');
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function NoteAttachmentDisplay({ attachments, groupKey }: NoteAttachmentDisplayProps) {
    const images = (attachments || []).filter(a => isImage(a.contentType));
    const files = (attachments || []).filter(a => !isImage(a.contentType));

    const galleryImages: GalleryImage[] = images.map(a => ({
        id: a.id,
        fileName: a.fileName,
        url: a.url,
    }));
    const gallery = useNoteGallery(
        groupKey || `note-${images[0]?.id ?? 'none'}`,
        galleryImages
    );

    if (!attachments || attachments.length === 0) return null;

    const openOriginal = async (attachment: Attachment) => {
        if (gallery) { gallery.open(attachment.id); return; }
        // No feed gallery around us — fall back to the browser's own viewer.
        const direct = attachment.url;
        if (direct) window.open(direct, '_blank', 'noopener');
    };

    return (
        <div className="space-y-2">
            {images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {images.map(attachment => {
                        // The thumbnail is fetched with the rest of the feed's, up front:
                        // a preview you have to hover to see is no preview at all, and on a
                        // phone there is no hover, so nothing ever appeared.
                        const resolved = gallery?.urlsFor(attachment.id);
                        const thumb = resolved?.thumbUrl || resolved?.url || attachment.url || null;
                        return (
                            <button
                                key={attachment.id}
                                type="button"
                                onClick={() => openOriginal(attachment)}
                                className="relative group"
                                title={attachment.fileName}
                            >
                                {thumb ? (
                                    <img
                                        src={thumb}
                                        alt={attachment.fileName}
                                        loading="lazy"
                                        decoding="async"
                                        className="w-20 h-20 object-cover rounded-lg border transition-opacity group-hover:opacity-80"
                                        style={{ borderColor: 'var(--blanc-line)' }}
                                    />
                                ) : (
                                    <div
                                        className="w-20 h-20 rounded-lg border flex items-center justify-center"
                                        style={{ borderColor: 'var(--blanc-line)', background: 'rgba(25,25,25,0.03)' }}
                                    >
                                        <Loader2 className="size-4 animate-spin" style={{ color: 'var(--blanc-ink-3)' }} />
                                    </div>
                                )}
                                <div
                                    className="absolute bottom-0 left-0 right-0 rounded-b-lg px-1.5 py-0.5 text-[10px] truncate"
                                    style={{ background: 'rgba(0,0,0,0.5)', color: '#fff' }}
                                >
                                    {attachment.fileName}
                                </div>
                            </button>
                        );
                    })}
                </div>
            )}
            {files.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {files.map(attachment => {
                        const resolved = gallery?.urlsFor(attachment.id);
                        const href = resolved?.url || attachment.url || undefined;
                        return (
                            <a
                                key={attachment.id}
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors hover:bg-muted"
                                style={{ border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-2)' }}
                                title={`${attachment.fileName} (${formatSize(attachment.fileSize)})`}
                            >
                                <FileText className="size-3.5 shrink-0" />
                                <span className="max-w-[140px] truncate">{attachment.fileName}</span>
                                <ExternalLink className="size-3 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                            </a>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
