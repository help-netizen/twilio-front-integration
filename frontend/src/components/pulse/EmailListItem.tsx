/**
 * EmailListItem — email chat bubble (EMAIL-TIMELINE-001, mirrors SmsListItem).
 * Outgoing: right-aligned indigo bubble. Incoming: left-aligned warm surface bubble.
 * Shows a small mail glyph + "Email" channel hint, an emphasized subject, then the
 * plain-text body (already quote-stripped server-side; line breaks preserved).
 * Text-only — no HTML render, no attachments (v1).
 */

import { Mail } from 'lucide-react';
import type { EmailTimelineItem } from '../../types/pulse';
import { useAuth } from '../../auth/AuthProvider';

const formatTime = (dateStr: string, tz: string): string => {
    const d = new Date(dateStr);
    return d.toLocaleString('en-US', {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZone: tz,
    });
};

interface EmailListItemProps {
    email: EmailTimelineItem;
}

export function EmailListItem({ email }: EmailListItemProps) {
    const { company } = useAuth();
    const companyTz = company?.timezone || 'America/New_York';
    const isOutgoing = email.is_outbound || email.direction === 'outbound';
    const hasSubject = !!email.subject && email.subject.trim().length > 0;
    const hasBody = !!email.body_text && email.body_text.trim().length > 0;
    // Inbound sender: name preferred for the eyebrow; the raw address is shown
    // next to it (many senders — e.g. Google Local Services relays — carry a
    // generic display name, so the address is the identifying part).
    const senderName = !isOutgoing ? (email.from_name?.trim() || '') : '';
    const senderEmail = !isOutgoing ? (email.from_email?.trim() || '') : '';
    const senderLabel = senderName || senderEmail;
    // Only append the address when a distinct display name is what the eyebrow shows.
    const showSenderEmail = !isOutgoing && !!senderEmail && senderName.toLowerCase() !== senderEmail.toLowerCase();

    return (
        <div className={`flex ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
            <div
                className={`relative max-w-[75%] overflow-hidden ${isOutgoing ? 'rounded-br-sm' : 'rounded-bl-sm'}`}
                style={isOutgoing
                    ? { background: 'var(--blanc-info)', color: '#fff', borderRadius: 14 }
                    : { background: 'var(--blanc-field)', color: 'var(--blanc-ink-1)', border: '1px solid var(--blanc-line)', borderRadius: 14 }
                }
            >
                {/* Channel hint + inbound sender */}
                <div className={`flex items-center gap-1.5 px-3 pt-2 ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
                    <Mail className="w-3 h-3 shrink-0" style={{ opacity: isOutgoing ? 0.7 : 0.55 }} />
                    <span
                        className="text-[10px] uppercase tracking-wider truncate shrink-0"
                        style={isOutgoing ? { color: 'rgba(255,255,255,0.65)' } : { color: 'var(--blanc-ink-3)' }}
                    >
                        {senderLabel ? `Email · ${senderLabel}` : 'Email'}
                    </span>
                    {showSenderEmail && (
                        <span
                            className="text-[10px] normal-case truncate min-w-0"
                            style={{ color: 'var(--blanc-ink-3)' }}
                            title={senderEmail}
                        >
                            {senderEmail}
                        </span>
                    )}
                </div>

                {/* Subject — emphasized, one line */}
                {hasSubject && (
                    <p
                        className="text-sm font-semibold px-3 pt-1 truncate"
                        style={isOutgoing ? { color: '#fff' } : { color: 'var(--blanc-ink-1)' }}
                        title={email.subject || undefined}
                    >
                        {email.subject}
                    </p>
                )}

                {/* Body — plain text, preserve line breaks, no HTML render */}
                {hasBody && (
                    <p
                        className={`text-sm leading-relaxed px-3 whitespace-pre-wrap break-words ${hasSubject ? 'pt-1 pb-1.5' : 'pt-1.5 pb-1.5'}`}
                    >
                        {email.body_text}
                    </p>
                )}

                {/* Timestamp */}
                <div className={`flex items-center gap-1 px-3 pb-2 ${hasBody || hasSubject ? '' : 'pt-1'} ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
                    <span className="text-[10px]" style={isOutgoing ? { color: 'rgba(255,255,255,0.55)' } : { color: 'var(--blanc-ink-3)' }}>
                        {email.sent_at ? formatTime(email.sent_at, companyTz) : ''}
                    </span>
                </div>
            </div>
        </div>
    );
}
