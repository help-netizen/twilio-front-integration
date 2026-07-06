import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { EmailMessage } from '../../services/emailApi';
import { getAttachmentDownloadUrl } from '../../services/emailApi';
import { AttachmentsSection, type AttachmentItem } from '../shared/AttachmentsSection';
import SafeEmailHtml from './SafeEmailHtml';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml'];

interface EmailMessageItemProps {
    message: EmailMessage;
    isLast: boolean;
}

function formatDateTime(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatRecipients(recipients: { name?: string; email: string }[]): string {
    return recipients.map(r => r.name || r.email).join(', ');
}

export function EmailMessageItem({ message, isLast }: EmailMessageItemProps) {
    const [expanded, setExpanded] = useState(isLast);
    const [allowImages, setAllowImages] = useState(false);
    const isOutbound = message.direction === 'outbound';

    // Only offer "Show images" when the HTML actually carries blockable remote
    // images (http(s)/protocol-relative/cid), and they're still blocked.
    const hasBlockableImages =
        !!message.body_html &&
        /<img[^>]+\bsrc\s*=\s*["']?\s*(https?:|\/\/|cid:)/i.test(message.body_html);

    // Map email attachments to universal AttachmentItem
    const visibleAttachments: AttachmentItem[] = (message.attachments || [])
        .filter(a => !a.is_inline)
        .map(a => ({
            url: getAttachmentDownloadUrl(a.id),
            filename: a.file_name || 'attachment',
            kind: (a.content_type && IMAGE_TYPES.includes(a.content_type.toLowerCase()) ? 'image' : 'file') as 'image' | 'file',
        }));

    return (
        <div style={{ borderBottom: '1px solid var(--blanc-line)' }}>
            {/* Header — always visible */}
            <div
                className="flex items-center justify-between px-4 py-3 cursor-pointer"
                onClick={() => setExpanded(!expanded)}
                style={{ background: expanded ? 'transparent' : 'rgba(25, 25, 25, 0.02)' }}
            >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div
                        className="size-7 rounded-full flex items-center justify-center shrink-0 text-xs font-medium"
                        style={{
                            background: isOutbound ? 'rgba(25, 25, 25, 0.08)' : 'rgba(92, 106, 196, 0.12)',
                            color: isOutbound ? 'var(--blanc-ink-2)' : '#5C6AC4',
                        }}
                    >
                        {(message.from_name || message.from_email || '?')[0].toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate" style={{ color: 'var(--blanc-ink-1)' }}>
                            {message.from_name || message.from_email}
                        </p>
                        {!expanded && (
                            <p className="text-xs truncate" style={{ color: 'var(--blanc-ink-3)' }}>
                                {message.snippet}
                            </p>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                        {formatDateTime(message.gmail_internal_at)}
                    </span>
                    {expanded ? <ChevronUp className="size-3.5" style={{ color: 'var(--blanc-ink-3)' }} /> : <ChevronDown className="size-3.5" style={{ color: 'var(--blanc-ink-3)' }} />}
                </div>
            </div>

            {/* Body — expanded */}
            {expanded && (
                <div className="px-4 pb-4">
                    {/* Recipients */}
                    <div className="text-xs mb-3" style={{ color: 'var(--blanc-ink-3)' }}>
                        <p>To: {formatRecipients(message.to_recipients_json)}</p>
                        {message.cc_recipients_json.length > 0 && (
                            <p>Cc: {formatRecipients(message.cc_recipients_json)}</p>
                        )}
                    </div>

                    {/* Body */}
                    {message.body_html ? (
                        <div className="text-sm" style={{ color: 'var(--blanc-ink-1)' }}>
                            {hasBlockableImages && !allowImages && (
                                <button
                                    type="button"
                                    onClick={() => setAllowImages(true)}
                                    className="mb-2 rounded-md px-2.5 py-1 text-xs font-medium"
                                    style={{
                                        border: '1px solid var(--blanc-line)',
                                        background: 'rgba(25, 25, 25, 0.03)',
                                        color: 'var(--blanc-ink-2)',
                                    }}
                                >
                                    Show images
                                </button>
                            )}
                            <SafeEmailHtml
                                html={message.body_html}
                                allowImages={allowImages}
                                messageId={message.id}
                            />
                        </div>
                    ) : (
                        <pre className="text-sm whitespace-pre-wrap" style={{ color: 'var(--blanc-ink-1)', fontFamily: 'inherit' }}>
                            {message.body_text || '(no content)'}
                        </pre>
                    )}

                    {/* Attachments — universal gallery */}
                    {visibleAttachments.length > 0 && (
                        <div className="mt-3">
                            <AttachmentsSection attachments={visibleAttachments} />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
