/**
 * EmailListItem — email chat bubble (EMAIL-TIMELINE-001, mirrors SmsListItem).
 * Outgoing: right-aligned indigo bubble. Incoming: left-aligned warm surface bubble.
 * Shows a small mail glyph + "Email" channel hint, an emphasized subject, then the
 * body via the EMAIL-HTML-RENDER-001 render matrix (M1–M4):
 *   M1 inbound + body_html → sanitized HTML in a Shadow DOM (SafeEmailHtml),
 *      with a caller-owned "Show images" gate for remote images;
 *   M2 inbound + text only  → linkified plain text (URLs/emails/phones);
 *   M3 outbound (any)       → ALWAYS linkified text, never SafeEmailHtml;
 *   M4 no body              → nothing.
 */

import { useState } from 'react';
import { Mail } from 'lucide-react';
import type { EmailTimelineItem } from '../../types/pulse';
import { useAuth } from '../../auth/AuthProvider';
import SafeEmailHtml from '../email/SafeEmailHtml';
import { linkifyToHtml } from '../../lib/linkifyText';

// Cheap inline probe: does this HTML reference a *remote* (blockable) image?
// Matches an <img> whose src starts with http(s):, protocol-relative //, or cid:.
// If none, there's nothing to gate, so we skip the "Show images" affordance.
const REMOTE_IMG_RE = /<img[^>]+\bsrc\s*=\s*["']?\s*(https?:|\/\/|cid:)/i;

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
    // Caller owns the "Show images" gate; SafeEmailHtml is dumb/controlled.
    const [allowImages, setAllowImages] = useState(false);

    const hasText = !!email.body_text && email.body_text.trim().length > 0;
    // M1 is inbound-only: outbound always renders as linkified text (M3), even
    // if body_html is present. So HTML rendering is gated on !isOutgoing.
    const renderHtml = !isOutgoing && !!email.body_html && email.body_html.trim().length > 0;
    // Body exists (and the bubble should reserve padding for it) when we render
    // either the HTML (M1) or linkified text (M2/M3). This extends the old
    // text-only check so an inbound HTML-only email still shows a body.
    const hasBody = renderHtml || hasText;
    // Only offer the gate when there are actually blockable remote images left
    // to reveal AND they're still hidden.
    const showImagesButton = renderHtml && !allowImages && REMOTE_IMG_RE.test(email.body_html || '');
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

                {/* Body — EMAIL-HTML-RENDER-001 render matrix (M1–M4). */}
                {renderHtml ? (
                    /* M1 — inbound + body_html: sanitized HTML in a Shadow DOM.
                       SafeEmailHtml's host is its own overflow-x:auto cage, so a
                       wide email scrolls INSIDE the bubble instead of clipping /
                       widening it. The bubble keeps max-w-[75%] + overflow-hidden;
                       overflow-x:visible here lets the host's own scroll win. */
                    <div
                        className={`px-3 ${hasSubject ? 'pt-1 pb-1.5' : 'pt-1.5 pb-1.5'}`}
                        style={{ overflowX: 'visible' }}
                    >
                        <SafeEmailHtml
                            html={email.body_html || ''}
                            allowImages={allowImages}
                            messageId={email.id}
                            className="text-sm leading-relaxed"
                        />
                        {showImagesButton && (
                            <button
                                type="button"
                                onClick={() => setAllowImages(true)}
                                className="mt-1.5 text-[11px] rounded px-1.5 py-0.5 transition-colors"
                                style={{
                                    color: 'var(--blanc-ink-3)',
                                    background: 'var(--blanc-surface-muted)',
                                    border: '1px solid var(--blanc-line)',
                                }}
                            >
                                Show images
                            </button>
                        )}
                    </div>
                ) : hasText ? (
                    /* M2 (inbound text-only) / M3 (outbound, always text): linkify
                       the plain text. linkifyToHtml escapes first, so injecting via
                       dangerouslySetInnerHTML is safe; whitespace-pre-wrap keeps the
                       server-preserved line breaks. */
                    <p
                        className={`text-sm leading-relaxed px-3 whitespace-pre-wrap break-words ${hasSubject ? 'pt-1 pb-1.5' : 'pt-1.5 pb-1.5'}`}
                        dangerouslySetInnerHTML={{ __html: linkifyToHtml(email.body_text) }}
                    />
                ) : null /* M4 — no body: render nothing. */}

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
