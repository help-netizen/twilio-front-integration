/**
 * SmsListItem — chat bubble style.
 * Outgoing: right-aligned indigo bubble, no phone header (direction is obvious from side).
 * Incoming: left-aligned warm surface bubble.
 * Delivery status: ✓✓ on outgoing only (bottom-right of text).
 */

import { Check, CheckCheck, X, Download, FileText, FileIcon } from 'lucide-react';
import type { SmsMessage, SmsMediaItem } from '../../types/pulse';
import { useAuth } from '../../auth/AuthProvider';

// ── Formatters ───────────────────────────────────────────────────────────────

const formatTime = (dateStr: string, tz: string): string => {
    const d = new Date(dateStr);
    return d.toLocaleString('en-US', {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZone: tz,
    });
};

const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
};

const isImage = (contentType: string | null): boolean => !!contentType && contentType.startsWith('image/');

const mediaUrl = (media: SmsMediaItem) => `/api/messaging/media/${media.id}/temporary-url`;

const handleDownload = (media: SmsMediaItem) => {
    const link = document.createElement('a');
    link.href = mediaUrl(media);
    link.download = media.filename || 'download';
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

// ── Delivery icon ─────────────────────────────────────────────────────────────

function DeliveryIcon({ status }: { status: string | null | undefined }) {
    if (status === 'delivered') return <CheckCheck className="w-3 h-3 opacity-70" />;
    if (status === 'sent') return <Check className="w-3 h-3 opacity-60" />;
    if (status === 'failed' || status === 'undelivered') return <X className="w-3 h-3 text-red-300" />;
    return null;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface SmsListItemProps {
    sms: SmsMessage;
}

export function SmsListItem({ sms }: SmsListItemProps) {
    const { company } = useAuth();
    const companyTz = company?.timezone || 'America/New_York';
    const isOutgoing = sms.direction === 'outbound';
    const hasMedia = sms.media && sms.media.length > 0;
    const hasMessage = sms.body && sms.body.trim().length > 0;
    const timestamp = sms.date_created_remote || sms.created_at;

    return (
        <div className={`flex ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
            <div
                className={`relative max-w-[75%] rounded-2xl overflow-hidden ${
                    isOutgoing
                        ? 'rounded-br-sm'
                        : 'rounded-bl-sm'
                }`}
                style={isOutgoing
                    ? { background: 'var(--blanc-info)', color: '#fff' }
                    : { background: '#ece7de', color: 'var(--blanc-ink-1)', border: '1px solid rgba(117, 106, 89, 0.14)' }
                }
            >
                {/* Media Attachments */}
                {hasMedia && (
                    <div className={`${hasMessage ? 'pb-0' : ''} p-1.5 space-y-1.5`}>
                        {sms.media!.map((media) => (
                            <div key={media.id}>
                                {isImage(media.content_type || '') ? (
                                    <div className="relative group">
                                        <img
                                            src={mediaUrl(media)}
                                            alt={media.filename || 'Image'}
                                            className="w-full rounded-xl cursor-pointer hover:opacity-90 transition-opacity"
                                            onClick={() => handleDownload(media)}
                                        />
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleDownload(media); }}
                                            className={`absolute top-2 right-2 p-1.5 rounded-full shadow-lg transition-opacity max-md:opacity-70 md:opacity-0 md:group-hover:opacity-100 ${isOutgoing ? 'bg-blue-700/80' : 'bg-black/40'}`}
                                            title="Download"
                                        >
                                            <Download className="w-3.5 h-3.5 text-white" />
                                        </button>
                                        {media.size_bytes && (
                                            <div className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded text-[10px] bg-black/40 text-white">
                                                {formatFileSize(media.size_bytes)}
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <button
                                        onClick={() => handleDownload(media)}
                                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border transition-colors ${
                                            isOutgoing
                                                ? 'bg-blue-700/40 border-white/10 hover:bg-blue-700/60'
                                                : 'border-border/50 hover:bg-muted/40'
                                        }`}
                                        style={isOutgoing ? {} : { background: 'var(--blanc-surface-muted)' }}
                                    >
                                        <div className={`p-1.5 rounded-lg ${isOutgoing ? 'bg-white/15' : 'bg-muted/60'}`}>
                                            {(media.content_type || '').includes('pdf') ? (
                                                <FileText className={`w-4 h-4 ${isOutgoing ? 'text-white' : 'text-red-500'}`} />
                                            ) : (
                                                <FileIcon className={`w-4 h-4 ${isOutgoing ? 'text-white/80' : ''}`} style={isOutgoing ? {} : { color: 'var(--blanc-ink-2)' }} />
                                            )}
                                        </div>
                                        <div className="flex-1 text-left min-w-0">
                                            <div className={`text-sm font-medium truncate ${isOutgoing ? 'text-white' : ''}`} style={isOutgoing ? {} : { color: 'var(--blanc-ink-1)' }}>
                                                {media.filename || 'File'}
                                            </div>
                                            {media.size_bytes && (
                                                <div className={`text-xs ${isOutgoing ? 'text-white/60' : ''}`} style={isOutgoing ? {} : { color: 'var(--blanc-ink-3)' }}>
                                                    {formatFileSize(media.size_bytes)}
                                                </div>
                                            )}
                                        </div>
                                        <Download className={`w-4 h-4 shrink-0 ${isOutgoing ? 'text-white/60' : ''}`} style={isOutgoing ? {} : { color: 'var(--blanc-ink-3)' }} />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {/* Message text */}
                {hasMessage && (
                    <p className={`text-sm leading-relaxed px-3 ${hasMedia ? 'pt-1 pb-2' : 'pt-2.5 pb-1.5'}`}>
                        {sms.body}
                    </p>
                )}

                {/* Timestamp + delivery */}
                <div className={`flex items-center gap-1 px-3 pb-2 ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
                    <span className={`text-[10px] ${isOutgoing ? 'text-white/55' : ''}`} style={isOutgoing ? {} : { color: 'var(--blanc-ink-3)' }}>
                        {timestamp ? formatTime(timestamp, companyTz) : ''}
                    </span>
                    {isOutgoing && (
                        <span className="text-white/70">
                            <DeliveryIcon status={sms.delivery_status} />
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}
