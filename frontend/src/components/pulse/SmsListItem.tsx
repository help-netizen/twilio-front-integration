/**
 * SmsListItem — exact match to TIMELINE_TECHNICAL_SPECIFICATION.md
 * Adapted field names: sms.body (not sms.message), sms.from_number/to_number,
 * sms.delivery_status, sms.created_at, media items from our schema.
 */

import { MessageSquare, Check, CheckCheck, X, Download, FileText, FileIcon } from 'lucide-react';
import { Card } from '../ui/card';
import type { SmsMessage, SmsMediaItem } from '../../types/pulse';

// ── Formatters ───────────────────────────────────────────────────────────────

const formatTime = (dateStr: string): string => {
    const d = new Date(dateStr);
    return d.toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
    });
};

const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
};

const isImage = (contentType: string | null): boolean => !!contentType && contentType.startsWith('image/');

const handleDownload = (media: SmsMediaItem) => {
    const link = document.createElement('a');
    link.href = `/api/conversations/media/${media.id}/content`;
    link.download = media.filename || 'download';
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

// ── Component ────────────────────────────────────────────────────────────────

interface SmsListItemProps {
    sms: SmsMessage;
}

export function SmsListItem({ sms }: SmsListItemProps) {
    const isOutgoing = sms.direction === 'outbound';
    const hasMedia = sms.media && sms.media.length > 0;
    const hasMessage = sms.body && sms.body.trim().length > 0;

    return (
        <div className={`flex ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
            <Card
                className={`max-w-[80%] overflow-hidden border ${isOutgoing
                    ? 'bg-blue-600 text-white border-blue-700'
                    : 'bg-white text-gray-900 border-gray-200'
                    }`}
            >
                <div className={hasMedia && !hasMessage ? 'p-2' : 'p-4'}>
                    {/* Header - show if there's text or it's outgoing with media (for status) */}
                    {(hasMessage || (hasMedia && isOutgoing)) && (
                        <div className="flex items-center gap-2 mb-2">
                            <MessageSquare className={`w-4 h-4 ${isOutgoing ? 'text-blue-200' : 'text-gray-400'}`} />
                            <span className={`text-xs font-mono ${isOutgoing ? 'text-blue-100' : 'text-gray-500'}`}>
                                {isOutgoing ? sms.to_number : sms.from_number}
                            </span>
                            {isOutgoing && (
                                <span className={`ml-auto ${sms.delivery_status === 'delivered' ? 'text-blue-200' :
                                    sms.delivery_status === 'sent' ? 'text-blue-300' :
                                        'text-red-300'
                                    }`}>
                                    {sms.delivery_status === 'delivered' ? (
                                        <CheckCheck className="w-3.5 h-3.5" />
                                    ) : sms.delivery_status === 'sent' ? (
                                        <Check className="w-3.5 h-3.5" />
                                    ) : (
                                        <X className="w-3.5 h-3.5" />
                                    )}
                                </span>
                            )}
                        </div>
                    )}

                    {/* Media Attachments */}
                    {hasMedia && (
                        <div className={hasMessage ? 'mb-3 space-y-2' : 'space-y-2'}>
                            {sms.media!.map((media) => (
                                <div key={media.id}>
                                    {isImage(media.content_type || '') ? (
                                        /* Image preview with download button */
                                        <div className="relative group">
                                            <img
                                                src={`/api/conversations/media/${media.id}/content`}
                                                alt={media.filename || 'Image'}
                                                className="w-full rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                                                onClick={() => handleDownload(media)}
                                            />
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleDownload(media);
                                                }}
                                                className={`absolute top-2 right-2 p-2 rounded-full shadow-lg transition-opacity opacity-0 group-hover:opacity-100 ${isOutgoing ? 'bg-blue-700 hover:bg-blue-800' : 'bg-gray-800 hover:bg-gray-900'
                                                    }`}
                                                title="Download"
                                            >
                                                <Download className="w-4 h-4 text-white" />
                                            </button>
                                            {media.size_bytes && (
                                                <div className={`absolute bottom-2 left-2 px-2 py-1 rounded text-xs ${isOutgoing ? 'bg-blue-700/90' : 'bg-gray-800/90'
                                                    } text-white`}>
                                                    {formatFileSize(media.size_bytes)}
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        /* Non-image file with download */
                                        <button
                                            onClick={() => handleDownload(media)}
                                            className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors ${isOutgoing
                                                ? 'bg-blue-700 border-blue-800 hover:bg-blue-800'
                                                : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
                                                }`}
                                        >
                                            <div className={`p-2 rounded ${isOutgoing ? 'bg-blue-800' : 'bg-gray-200'
                                                }`}>
                                                {(media.content_type || '').includes('pdf') ? (
                                                    <FileText className={`w-5 h-5 ${isOutgoing ? 'text-blue-200' : 'text-red-600'}`} />
                                                ) : (
                                                    <FileIcon className={`w-5 h-5 ${isOutgoing ? 'text-blue-200' : 'text-gray-600'}`} />
                                                )}
                                            </div>
                                            <div className="flex-1 text-left">
                                                <div className={`text-sm font-medium truncate ${isOutgoing ? 'text-white' : 'text-gray-900'
                                                    }`}>
                                                    {media.filename || 'File'}
                                                </div>
                                                {media.size_bytes && (
                                                    <div className={`text-xs ${isOutgoing ? 'text-blue-200' : 'text-gray-500'
                                                        }`}>
                                                        {formatFileSize(media.size_bytes)}
                                                    </div>
                                                )}
                                            </div>
                                            <Download className={`w-4 h-4 flex-shrink-0 ${isOutgoing ? 'text-blue-200' : 'text-gray-400'
                                                }`} />
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Message */}
                    {hasMessage && (
                        <p className={`text-sm leading-relaxed mb-2 ${isOutgoing ? 'text-white' : 'text-gray-700'}`}>
                            {sms.body}
                        </p>
                    )}

                    {/* Timestamp */}
                    {hasMessage && (
                        <div className={`text-xs ${isOutgoing ? 'text-blue-200' : 'text-gray-500'} text-right`}>
                            {formatTime(sms.date_created_remote || sms.created_at)}
                        </div>
                    )}
                </div>
            </Card>
        </div>
    );
}
