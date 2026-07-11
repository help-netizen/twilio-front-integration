/**
 * PulseContactItem — a single contact row in the Pulse sidebar.
 * Layout: avatar/initials + interaction badge | name + time | phone | status badges
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { callsApi } from '../../services/api';
import { formatPhoneDisplay as formatPhoneNumber, isAnonymousPhone } from '../../utils/phoneUtils';
import { useLeadByPhone } from '../../hooks/useLeadByPhone';
import { useAuth } from '../../auth/AuthProvider';
import type { Lead } from '../../types/lead';
import {
    PhoneIncoming, PhoneOutgoing, ArrowLeftRight,
    MessageSquare, MessageSquareReply, Mail, MailCheck, MoreVertical,
    EyeOff, Clock, CheckCircle2, AlertTriangle, Bot,
} from 'lucide-react';
import type { Call } from '../../types/models';
import { tomorrowAtInTZ } from '../../utils/companyTime';
import { isAiAnsweredBy } from './pulseHelpers';

// ── Constants ────────────────────────────────────────────────────────────────

const STATUS_ICON_COLORS: Record<string, string> = {
    'completed': '#16a34a', 'no-answer': '#dc2626', 'busy': '#ea580c',
    'failed': '#dc2626', 'canceled': '#6b7280', 'ringing': '#2563eb',
    'in-progress': '#7c3aed', 'queued': '#2563eb', 'initiated': '#2563eb',
    'voicemail_recording': '#ea580c', 'voicemail_left': '#dc2626',
};

export const SNOOZE_OPTIONS = [
    { label: '30 min', ms: 30 * 60 * 1000 },
    { label: '2 hours', ms: 2 * 60 * 60 * 1000 },
    { label: 'Tomorrow 9 AM', ms: null as number | null },
];

export function getSnoozeUntil(option: typeof SNOOZE_OPTIONS[number], companyTz: string = 'America/New_York'): string {
    if (option.ms) return new Date(Date.now() + option.ms).toISOString();
    return tomorrowAtInTZ(9, 0, companyTz).toISOString();
}

export const REASON_LABELS: Record<string, string> = {
    new_message: 'New message', new_call: 'New call', manual: 'Manual',
    estimate_approved: 'Estimate approved', time_confirmed: 'Time confirmed',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatExactTime(date: Date, tz: string): string {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
}

/** YYYY-MM-DD key in given timezone. */
function tzDateKey(date: Date, tz: string): string {
    return date.toLocaleDateString('en-CA', { timeZone: tz });
}

/** If same calendar day in company tz → relative ("just now" / "15m ago" / "3h ago");
 *  otherwise → "Mon, Apr 22" rendered in company tz. */
function formatRelativeOrDate(date: Date, tz: string): string {
    const now = new Date();
    if (tzDateKey(date, tz) === tzDateKey(now, tz)) {
        const diff = now.getTime() - date.getTime();
        const mins = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        if (mins < 2) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        return `${hours}h ago`;
    }
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });
}

/** Get initials from a name or phone */


// ── Component ────────────────────────────────────────────────────────────────

export function PulseContactItem({ call, isActive, onMarkUnread, onMarkHandled, onSnooze, onSetActionRequired, onRead, prefetchedLead }: {
    call: Call; isActive: boolean;
    onMarkUnread?: (timelineId: number) => void;
    onMarkHandled?: (timelineId: number) => void;
    onSnooze?: (timelineId: number, until: string) => void;
    onSetActionRequired?: (timelineId: number) => void;
    onRead?: () => void;
    prefetchedLead?: Lead | null;
}) {
    const navigate = useNavigate();
    const { company: authCompany } = useAuth();
    const companyTz = authCompany?.timezone || 'America/New_York';
    const tlId = (call as any).timeline_id;
    const contactId = call.contact?.id || call.id;
    const targetPath = tlId ? `/pulse/timeline/${tlId}` : (contactId ? `/pulse/contact/${contactId}` : null);

    const hasUnread = (call as any).tl_has_unread || (call as any).sms_has_unread || call.has_unread;
    const rawPhone = (call as any).tl_phone || call.contact?.phone_e164 || call.from_number || call.to_number || call.call_sid;
    const displayPhone = (call as any).last_interaction_phone || rawPhone;

    // Anonymous timeline: no contact / lead lookup, render fixed "Anonymous" label.
    const isAnon = isAnonymousPhone((call as any).tl_phone)
        || isAnonymousPhone(call.from_number)
        || isAnonymousPhone(displayPhone);

    // Use prefetched lead if available, otherwise fall back to per-item hook.
    // Skip lead lookup entirely for anonymous (sentinel isn't a real number).
    const { lead: hookLead } = useLeadByPhone(
        isAnon ? undefined : (prefetchedLead !== undefined ? undefined : rawPhone)
    );
    const lead = isAnon ? null : (prefetchedLead !== undefined ? prefetchedLead : hookLead);
    const leadName = lead ? [lead.FirstName, lead.LastName].filter(Boolean).join(' ') : null;
    const company = lead?.Company || null;
    const contactName = !isAnon && call.contact?.full_name && call.contact.full_name !== call.contact.phone_e164
        ? call.contact.full_name : null;
    const primaryText = isAnon
        ? 'Anonymous'
        // YELP-TIMELINE-DEDUP-001: a contactless conv-id timeline has no company/
        // lead/contact — fall back to its denormalized display_name before the phone.
        : (company || leadName || contactName || (call as any).display_name || formatPhoneNumber(displayPhone));
    const showSecondaryPhone = !isAnon && !!(company || leadName || contactName);

    const displayDate = new Date(call.last_interaction_at || call.started_at || call.created_at);
    const interactionType = call.last_interaction_type || 'call';

    const openTask = (call as any).open_task || null;
    const openTaskCount = (call as any).open_task_count || 0;
    // AR-TASK-UNIFY-001: "Action Required" = the thread has an open task.
    const isActionRequired = (call as any).has_open_task ?? !!openTask;
    const arReason = (call as any).action_required_reason || null;
    const snoozedUntil = (call as any).snoozed_until;
    const isSnoozed = snoozedUntil && new Date(snoozedUntil) > new Date();
    const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);

    const callDirection = call.direction === 'inbound' ? 'inbound'
        : call.direction?.startsWith('outbound') ? 'outbound'
            : call.direction === 'internal' ? 'internal' : 'outbound';
    const callColor = STATUS_ICON_COLORS[call.status?.toLowerCase() || ''] || '#16a34a';
    const isAiAnsweredLatestCall = interactionType === 'call' && isAiAnsweredBy(call.answered_by);

    // Missed incoming call — last interaction is a call, direction is inbound, status is not answered
    const isMissedIncoming = interactionType === 'call'
        && callDirection === 'inbound'
        && ['no-answer', 'busy', 'failed', 'canceled', 'voicemail_left', 'voicemail_recording'].includes((call.status || '').toLowerCase());

    // Neutral icon container — same for all contacts, no visual noise

    return (
        <button
            onClick={() => {
                if (!targetPath) return;
                navigate(targetPath);
                if (tlId && hasUnread) {
                    callsApi.markTimelineRead(tlId)
                        .then(() => { onRead?.(); })
                        .catch((err) => { console.error('[Pulse] Failed to mark timeline read:', tlId, err); });
                }
            }}
            className={`pulse-tile w-full text-left relative group${isActive ? ' pulse-contact-item-active' : ''}`}
            style={{
                outline: 'none',
                ...(isMissedIncoming && !isActive ? { background: 'rgba(244, 63, 94, 0.08)' } : {}),
            }}
        >
            {/* Unread indicator */}
            {hasUnread && (
                <div className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full" style={{ backgroundColor: 'var(--blanc-info)' }} />
            )}

            <div className="flex items-start gap-2.5">
                {/* Event type icon */}
                <div className="relative shrink-0 mt-1" title={isAiAnsweredLatestCall ? 'AI bot answered this call' : undefined}>
                    {(() => {
                        if (interactionType === 'sms_inbound') return <MessageSquareReply className="size-[18px]" style={{ color: 'var(--blanc-info)' }} />;
                        if (interactionType === 'sms_outbound') return <MessageSquare className="size-[18px]" style={{ color: 'var(--blanc-ink-2)' }} />;
                        // EMAIL-UNREAD-001: emails get their own channel icons — the backend
                        // has emitted email_inbound/email_outbound since LIST-PAGINATION-001,
                        // but the list fell through to call icons for them.
                        if (interactionType === 'email_inbound') return <Mail className="size-[18px]" style={{ color: 'var(--blanc-info)' }} />;
                        if (interactionType === 'email_outbound') return <MailCheck className="size-[18px]" style={{ color: 'var(--blanc-ink-2)' }} />;
                        if (isAiAnsweredLatestCall) return <Bot className="size-[18px]" style={{ color: '#dc2626' }} aria-label="AI bot answered this call" />;
                        if (callDirection === 'internal') return <ArrowLeftRight className="size-[18px]" style={{ color: 'var(--blanc-ink-2)' }} />;
                        if (callDirection === 'inbound') return <PhoneIncoming className="size-[18px]" style={{ color: callColor }} />;
                        return <PhoneOutgoing className="size-[18px]" style={{ color: callColor }} />;
                    })()}
                </div>

                {/* Main content */}
                <div className="min-w-0 flex-1">
                    {/* Name + time */}
                    <div className="flex items-start justify-between gap-1 mb-0.5">
                        <span
                            className={`text-sm truncate leading-tight ${hasUnread ? 'font-semibold' : 'font-medium'}`}
                            style={{ color: 'var(--blanc-ink-1)' }}
                        >
                            {primaryText}
                        </span>
                        <div className="flex flex-col items-end shrink-0 leading-tight">
                            <span className="text-[11px] tabular-nums" style={{ color: 'var(--blanc-ink-2)' }}>
                                {formatExactTime(displayDate, companyTz)}
                            </span>
                            <span className="text-[10px]" style={{ color: 'var(--blanc-ink-3)' }}>
                                {formatRelativeOrDate(displayDate, companyTz)}
                            </span>
                        </div>
                    </div>

                    {/* Phone (secondary) */}
                    {showSecondaryPhone && (
                        <div className="text-xs font-mono truncate" style={{ color: 'var(--blanc-ink-3)' }}>
                            {formatPhoneNumber(displayPhone)}
                        </div>
                    )}

                    {/* Status badges */}
                    {isActionRequired && !isSnoozed && (
                        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-orange-100 text-orange-800">
                                <AlertTriangle className="size-2.5" /> Task
                            </span>
                            {(openTask?.title || arReason) && (
                                <span className="text-[10px] truncate max-w-[150px]" style={{ color: 'var(--blanc-ink-3)' }}>
                                    {openTask?.title || REASON_LABELS[arReason] || arReason}
                                </span>
                            )}
                            {openTaskCount > 1 && (
                                <span className="text-[10px] font-medium" style={{ color: 'var(--blanc-ink-3)' }}>
                                    +{openTaskCount - 1}
                                </span>
                            )}
                            {openTask?.due_at && (
                                <span className="text-[10px]" style={{ color: 'var(--blanc-danger)' }}>
                                    Due {new Date(openTask.due_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: companyTz })}
                                </span>
                            )}
                        </div>
                    )}
                    {isSnoozed && (
                        <div className="flex items-center gap-1 mt-1">
                            <span
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-medium"
                                style={{ background: 'rgba(118,106,89,0.1)', color: 'var(--blanc-ink-2)' }}
                            >
                                <Clock className="size-2.5" />
                                Snoozed {new Date(snoozedUntil).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: companyTz })}
                            </span>
                        </div>
                    )}
                </div>

                {/* ⋮ menu — visible on hover or when active. Канонный DropdownMenu: тир z-150,
                    dismiss из коробки (самодельный absolute z-50 + click-outside снесены,
                    W3-аудит); на мобиле — канонный BottomSheet из враппера. Toggle открытия —
                    у Radix-триггера; stopPropagation остаётся, чтобы тайл не навигировал. */}
                <div className="shrink-0">
                    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                        <DropdownMenuTrigger asChild>
                            <div
                                role="button"
                                tabIndex={0}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => { if (e.key === 'Enter') e.stopPropagation(); }}
                                className={`p-1.5 rounded-lg transition-colors cursor-pointer min-w-[32px] min-h-[32px] flex items-center justify-center ${menuOpen ? 'bg-muted/80' : 'max-md:opacity-70 md:opacity-0 md:group-hover:opacity-100'} ${isActive ? '!opacity-100' : ''}`}
                                title="More options"
                            >
                                <MoreVertical className="size-3.5" style={{ color: 'var(--blanc-ink-3)' }} />
                            </div>
                        </DropdownMenuTrigger>
                        {/* overflow-visible: вложенное snooze-подменю (md:right-full) выходит за рамку контента */}
                        <DropdownMenuContent align="end" sideOffset={4} className="min-w-[180px] overflow-visible p-0 py-1 rounded-xl">
                            <div role="button" tabIndex={0}
                                onClick={(e) => { e.stopPropagation(); setMenuOpen(false); if (tlId && onMarkUnread) onMarkUnread(tlId); }}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setMenuOpen(false); if (tlId && onMarkUnread) onMarkUnread(tlId); } }}
                                className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted/60 cursor-pointer w-full">
                                <EyeOff className="size-3.5" /> Mark as Unread
                            </div>
                            {!isActionRequired && (
                                <div role="button" tabIndex={0}
                                    onClick={(e) => { e.stopPropagation(); setMenuOpen(false); if (tlId && onSetActionRequired) onSetActionRequired(tlId); }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setMenuOpen(false); if (tlId && onSetActionRequired) onSetActionRequired(tlId); } }}
                                    className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-orange-50 cursor-pointer w-full" style={{ color: 'var(--blanc-warning)' }}>
                                    <AlertTriangle className="size-3.5" /> Action Required
                                </div>
                            )}
                            {isActionRequired && (
                                <div role="button" tabIndex={0}
                                    onClick={(e) => { e.stopPropagation(); setMenuOpen(false); if (tlId && onMarkHandled) onMarkHandled(tlId); }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setMenuOpen(false); if (tlId && onMarkHandled) onMarkHandled(tlId); } }}
                                    className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-green-50 cursor-pointer w-full" style={{ color: 'var(--blanc-success)' }}>
                                    <CheckCircle2 className="size-3.5" /> Mark done
                                </div>
                            )}
                            {isActionRequired && (
                                <div className="relative">
                                    <div role="button" tabIndex={0}
                                        onClick={(e) => { e.stopPropagation(); setSnoozeMenuOpen(prev => !prev); }}
                                        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setSnoozeMenuOpen(prev => !prev); } }}
                                        className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted/60 cursor-pointer w-full">
                                        <Clock className="size-3.5" /> Snooze…
                                    </div>
                                    {snoozeMenuOpen && (
                                        <div className="absolute max-md:left-0 max-md:top-full max-md:mt-1 md:right-full md:top-0 md:mr-1 z-[100] bg-card rounded-xl shadow-lg border border-border py-1 min-w-[140px]">
                                            {SNOOZE_OPTIONS.map(opt => (
                                                <div key={opt.label} role="button" tabIndex={0}
                                                    onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setSnoozeMenuOpen(false); if (tlId && onSnooze) onSnooze(tlId, getSnoozeUntil(opt, companyTz)); }}
                                                    className="px-3 py-2 text-sm text-foreground hover:bg-muted/60 cursor-pointer">
                                                    {opt.label}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
        </button>
    );
}
