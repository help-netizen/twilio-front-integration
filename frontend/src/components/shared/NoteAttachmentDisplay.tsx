import { useState, useCallback } from 'react';
import { FileText, ExternalLink } from 'lucide-react';
import { authedFetch } from '../../services/apiClient';

interface Attachment {
    id: number | string;
    fileName: string;
    contentType: string;
    fileSize: number;
    // When present (e.g. Zenbooker CDN links), use the URL directly and skip the
    // /api/note-attachments/:id/url presigned-URL roundtrip.
    url?: string;
    source?: string;
}

interface NoteAttachmentDisplayProps {
    attachments: Attachment[];
}

function isImage(contentType: string): boolean {
    return contentType.startsWith('image/');
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentItem({ attachment }: { attachment: Attachment }) {
    const [loading, setLoading] = useState(false);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);

    const fetchUrl = useCallback(async () => {
        // Direct URL (e.g. Zenbooker CDN) — no presign roundtrip needed.
        if (attachment.url) return attachment.url;
        setLoading(true);
        try {
            const res = await authedFetch(`/api/note-attachments/${attachment.id}/url`);
            const data = await res.json();
            if (data.ok && data.url) return data.url;
        } catch (err) {
            console.error('[Attachment] Failed to get URL:', err);
        } finally {
            setLoading(false);
        }
        return null;
    }, [attachment.id, attachment.url]);

    const handleClick = async () => {
        const url = await fetchUrl();
        if (url) window.open(url, '_blank');
    };

    const handleImageLoad = async () => {
        if (!previewUrl) {
            const url = await fetchUrl();
            if (url) setPreviewUrl(url);
        }
    };

    if (isImage(attachment.contentType)) {
        return (
            <button
                onClick={handleClick}
                onMouseEnter={handleImageLoad}
                className="relative group"
                title={attachment.fileName}
            >
                {previewUrl ? (
                    <img
                        src={previewUrl}
                        alt={attachment.fileName}
                        className="w-20 h-20 object-cover rounded-lg border transition-opacity group-hover:opacity-80"
                        style={{ borderColor: 'var(--blanc-line)' }}
                    />
                ) : (
                    <div
                        className="w-20 h-20 rounded-lg border flex items-center justify-center"
                        style={{ borderColor: 'var(--blanc-line)', background: 'rgba(117,106,89,0.04)' }}
                    >
                        <FileText className="size-5" style={{ color: 'var(--blanc-ink-3)' }} />
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
    }

    return (
        <button
            onClick={handleClick}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors hover:bg-muted"
            style={{
                border: '1px solid var(--blanc-line)',
                color: 'var(--blanc-ink-2)',
            }}
            title={`${attachment.fileName} (${formatSize(attachment.fileSize)})`}
        >
            <FileText className="size-3.5 shrink-0" />
            <span className="max-w-[140px] truncate">{attachment.fileName}</span>
            <ExternalLink className="size-3 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
        </button>
    );
}

export function NoteAttachmentDisplay({ attachments }: NoteAttachmentDisplayProps) {
    if (!attachments || attachments.length === 0) return null;

    const images = attachments.filter(a => isImage(a.contentType));
    const files = attachments.filter(a => !isImage(a.contentType));

    return (
        <div className="space-y-2">
            {images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {images.map(a => <AttachmentItem key={a.id} attachment={a} />)}
                </div>
            )}
            {files.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {files.map(a => <AttachmentItem key={a.id} attachment={a} />)}
                </div>
            )}
        </div>
    );
}
