import { Download, FileText } from 'lucide-react';
import type { SmsMessage, SmsMediaItem } from '../../types/pulse';

interface SmsListItemProps {
    message: SmsMessage;
}

function formatTime(dateStr: string | null): string {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatFileSize(bytes: number | null): string {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getDeliveryIcon(status: string | null): string {
    switch (status) {
        case 'sent': return '✓';
        case 'delivered': return '✓✓';
        case 'read': return '✓✓';
        case 'failed': case 'undelivered': return '✗';
        default: return '';
    }
}

function MediaPreview({ media }: { media: SmsMediaItem }) {
    const mediaUrl = `/api/messaging/media/${media.id}/temporary-url`;

    if (media.preview_kind === 'image') {
        return (
            <div style={{ marginTop: '8px', position: 'relative', borderRadius: '8px', overflow: 'hidden' }}>
                <a href={mediaUrl} target="_blank" rel="noopener noreferrer">
                    <img
                        src={mediaUrl}
                        alt={media.filename || 'Image'}
                        style={{ maxWidth: '240px', maxHeight: '200px', borderRadius: '8px', display: 'block' }}
                        loading="lazy"
                    />
                </a>
            </div>
        );
    }

    return (
        <div
            style={{
                marginTop: '8px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 12px',
                borderRadius: '8px',
                backgroundColor: 'rgba(0,0,0,0.05)',
            }}
        >
            <a
                href={mediaUrl}
                download={media.filename || 'attachment'}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    textDecoration: 'none',
                    color: 'inherit',
                }}
            >
                {media.preview_kind === 'pdf' ? <FileText size={18} /> : <Download size={18} />}
                <div>
                    <div style={{ fontSize: '13px', fontWeight: 500 }}>{media.filename || 'Attachment'}</div>
                    {media.size_bytes && <div style={{ fontSize: '11px', opacity: 0.7 }}>{formatFileSize(media.size_bytes)}</div>}
                </div>
            </a>
        </div>
    );
}

export function SmsListItem({ message }: SmsListItemProps) {
    const isOutbound = message.direction === 'outbound';
    const time = formatTime(message.date_created_remote || message.created_at);
    const deliveryIcon = isOutbound ? getDeliveryIcon(message.delivery_status) : '';

    return (
        <div
            style={{
                display: 'flex',
                justifyContent: isOutbound ? 'flex-end' : 'flex-start',
                padding: '2px 16px',
            }}
        >
            <div
                style={{
                    maxWidth: '75%',
                    padding: '10px 14px',
                    borderRadius: isOutbound ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                    backgroundColor: isOutbound ? '#2563eb' : '#f3f4f6',
                    color: isOutbound ? '#ffffff' : '#1f2937',
                    fontSize: '14px',
                    lineHeight: '1.5',
                    wordBreak: 'break-word',
                }}
            >
                {/* Message body */}
                {message.body && <div>{message.body}</div>}

                {/* Media attachments */}
                {message.media?.map(m => <MediaPreview key={m.id} media={m} />)}

                {/* Timestamp + delivery */}
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        gap: '6px',
                        marginTop: '4px',
                        fontSize: '11px',
                        opacity: 0.7,
                    }}
                >
                    <span>{time}</span>
                    {deliveryIcon && (
                        <span
                            style={{
                                color: message.delivery_status === 'failed' || message.delivery_status === 'undelivered'
                                    ? '#ef4444'
                                    : 'inherit',
                            }}
                        >
                            {deliveryIcon}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}
