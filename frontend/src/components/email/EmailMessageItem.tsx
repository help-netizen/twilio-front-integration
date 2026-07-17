import { useState } from 'react';
import DOMPurify from 'dompurify';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { EmailMessage } from '../../services/emailApi';
import { getAttachmentDownloadUrl } from '../../services/emailApi';
import { AttachmentsSection, type AttachmentItem } from '../shared/AttachmentsSection';

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
    const isOutbound = message.direction === 'outbound';

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
                style={{ background: expanded ? 'transparent' : 'rgba(117, 106, 89, 0.02)' }}
            >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div
                        className="size-7 rounded-full flex items-center justify-center shrink-0 text-xs font-medium"
                        style={{
                            background: isOutbound ? 'rgba(117, 106, 89, 0.1)' : 'rgba(92, 106, 196, 0.12)',
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
                        <div
                            className="text-sm prose prose-sm max-w-none"
                            style={{ color: 'var(--blanc-ink-1)' }}
                            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(message.body_html) }}
                        />
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
