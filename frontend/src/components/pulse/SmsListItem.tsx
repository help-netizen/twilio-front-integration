import { MessageSquare, Check, CheckCheck, X, Download, FileText, FileIcon } from 'lucide-react';
import { Card } from '../ui/card';
import type { SmsMessage, SmsMediaItem } from '../../types/pulse';

interface SmsListItemProps {
    message: SmsMessage;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(dateStr: string | null): string {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
    });
}

function formatFileSize(bytes: number | null): string {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(contentType: string | null): boolean {
    return !!contentType && contentType.startsWith('image/');
}

function handleDownload(media: SmsMediaItem) {
    const url = `/api/messaging/media/${media.id}/temporary-url`;
    const a = document.createElement('a');
    a.href = url;
    a.download = media.filename || 'attachment';
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// ── Status icon ─────────────────────────────────────────────────────────────

function StatusIndicator({ status, isOutgoing }: { status: string | null; isOutgoing: boolean }) {
    if (!isOutgoing) return null;
    const cls = 'w-4 h-4';
    switch (status) {
        case 'delivered':
        case 'read':
            return <CheckCheck className={cls} style={{ color: isOutgoing ? '#bfdbfe' : '#6b7280' }} />;
        case 'sent':
            return <Check className={cls} style={{ color: isOutgoing ? '#93c5fd' : '#6b7280' }} />;
        case 'failed':
        case 'undelivered':
            return <X className={cls} style={{ color: '#fca5a5' }} />;
        default:
            return null;
    }
}

// ── Media preview (image) ───────────────────────────────────────────────────

function ImagePreview({ media, isOutgoing }: { media: SmsMediaItem; isOutgoing: boolean }) {
    const url = `/api/messaging/media/${media.id}/temporary-url`;
    return (
        <div className="relative group" style={{ marginBottom: '8px' }}>
            <img
                src={url}
                alt={media.filename || 'Image'}
                className="w-full rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                style={{ maxHeight: '300px', objectFit: 'contain' }}
                onClick={() => handleDownload(media)}
                loading="lazy"
            />
            {/* Download overlay */}
            <button
                onClick={(e) => { e.stopPropagation(); handleDownload(media); }}
                className="absolute top-2 right-2 p-2 rounded-full shadow-lg transition-opacity opacity-0 group-hover:opacity-100"
                style={{
                    backgroundColor: isOutgoing ? '#1d4ed8' : '#1f2937',
                }}
            >
                <Download className="w-4 h-4 text-white" />
            </button>
            {/* Size badge */}
            {media.size_bytes && (
                <span
                    className="absolute bottom-2 left-2 px-2 py-1 rounded text-xs text-white"
                    style={{ backgroundColor: isOutgoing ? 'rgba(29,78,216,0.9)' : 'rgba(31,41,55,0.9)' }}
                >
                    {formatFileSize(media.size_bytes)}
                </span>
            )}
        </div>
    );
}

// ── Media preview (document) ────────────────────────────────────────────────

function DocumentPreview({ media, isOutgoing }: { media: SmsMediaItem; isOutgoing: boolean }) {
    const isPdf = media.content_type?.includes('pdf');
    return (
        <button
            onClick={() => handleDownload(media)}
            className="w-full flex items-center gap-3 p-3 rounded-lg border transition-colors"
            style={{
                marginBottom: '8px',
                backgroundColor: isOutgoing ? '#1d4ed8' : '#f9fafb',
                borderColor: isOutgoing ? '#1e40af' : '#e5e7eb',
            }}
        >
            <div className="p-2 rounded" style={{ backgroundColor: isOutgoing ? '#1e40af' : '#e5e7eb' }}>
                {isPdf
                    ? <FileText className="w-5 h-5" style={{ color: isOutgoing ? '#bfdbfe' : '#dc2626' }} />
                    : <FileIcon className="w-5 h-5" style={{ color: isOutgoing ? '#bfdbfe' : '#4b5563' }} />
                }
            </div>
            <div className="flex-1 text-left">
                <div className="text-sm font-medium truncate" style={{ color: isOutgoing ? '#ffffff' : '#111827' }}>
                    {media.filename || 'Attachment'}
                </div>
                {media.size_bytes && (
                    <div className="text-xs" style={{ color: isOutgoing ? '#bfdbfe' : '#6b7280' }}>
                        {formatFileSize(media.size_bytes)}
                    </div>
                )}
            </div>
            <Download
                className="w-4 h-4 shrink-0"
                style={{ color: isOutgoing ? '#bfdbfe' : '#9ca3af' }}
            />
        </button>
    );
}

// ── Main component ──────────────────────────────────────────────────────────

export function SmsListItem({ message }: SmsListItemProps) {
    const isOutgoing = message.direction === 'outbound';
    const hasMedia = !!message.media?.length;
    const hasMessage = !!message.body?.trim();

    return (
        <div className="flex" style={{
            justifyContent: isOutgoing ? 'flex-end' : 'flex-start',
            padding: '4px 16px',
        }}>
            <Card
                className="border shadow-sm"
                style={{
                    maxWidth: '80%',
                    padding: hasMessage ? '16px' : '8px',
                    backgroundColor: isOutgoing ? '#2563eb' : '#ffffff',
                    color: isOutgoing ? '#ffffff' : '#111827',
                    borderColor: isOutgoing ? '#1d4ed8' : '#e5e7eb',
                }}
            >
                {/* Header with phone + status */}
                {(hasMessage || (hasMedia && isOutgoing)) && (
                    <div className="flex items-center gap-2 mb-2">
                        <MessageSquare
                            className="w-4 h-4"
                            style={{ color: isOutgoing ? '#bfdbfe' : '#9ca3af' }}
                        />
                        <span
                            className="text-xs font-mono"
                            style={{ color: isOutgoing ? '#dbeafe' : '#6b7280' }}
                        >
                            {isOutgoing ? message.to_number : message.from_number}
                        </span>
                        <div className="ml-auto">
                            <StatusIndicator status={message.delivery_status} isOutgoing={isOutgoing} />
                        </div>
                    </div>
                )}

                {/* Media attachments */}
                {hasMedia && (
                    <div className="space-y-2" style={{ marginBottom: hasMessage ? '12px' : 0 }}>
                        {message.media!.map(m =>
                            isImage(m.content_type)
                                ? <ImagePreview key={m.id} media={m} isOutgoing={isOutgoing} />
                                : <DocumentPreview key={m.id} media={m} isOutgoing={isOutgoing} />
                        )}
                    </div>
                )}

                {/* Message text */}
                {hasMessage && (
                    <div
                        className="text-sm leading-relaxed mb-2"
                        style={{ color: isOutgoing ? '#ffffff' : '#374151' }}
                    >
                        {message.body}
                    </div>
                )}

                {/* Timestamp */}
                {hasMessage && (
                    <div className="text-right" style={{
                        fontSize: '11px',
                        color: isOutgoing ? '#bfdbfe' : '#6b7280',
                    }}>
                        {formatTime(message.date_created_remote || message.created_at)}
                    </div>
                )}
            </Card>
        </div>
    );
}
