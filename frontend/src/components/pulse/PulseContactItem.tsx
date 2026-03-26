/**
 * PulseContactItem — a single contact row in the Pulse sidebar.
 */
import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { callsApi } from '../../services/api';
import { formatPhoneDisplay as formatPhoneNumber } from '../../utils/phoneUtils';
import { useLeadByPhone } from '../../hooks/useLeadByPhone';
import {
    PhoneIncoming, PhoneOutgoing, ArrowLeftRight,
    MessageSquare, MessageSquareReply, MoreVertical,
    EyeOff, Clock, CheckCircle2, AlertTriangle,
} from 'lucide-react';
import type { Call } from '../../types/models';

// ── Constants ────────────────────────────────────────────────────────────────

const STATUS_ICON_COLORS: Record<string, string> = {
    'completed': '#16a34a', 'no-answer': '#dc2626', 'busy': '#ea580c',
    'failed': '#dc2626', 'canceled': '#dc2626', 'ringing': '#2563eb',
    'in-progress': '#7c3aed', 'queued': '#2563eb', 'initiated': '#2563eb',
    'voicemail_recording': '#ea580c', 'voicemail_left': '#dc2626',
};

export const SNOOZE_OPTIONS = [
    { label: '30 min', ms: 30 * 60 * 1000 },
    { label: '2 hours', ms: 2 * 60 * 60 * 1000 },
    { label: 'Tomorrow 9 AM', ms: null as number | null },
];

export function getSnoozeUntil(option: typeof SNOOZE_OPTIONS[number]): string {
    if (option.ms) return new Date(Date.now() + option.ms).toISOString();
    const d = new Date();
    d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    return d.toISOString();
}

export const REASON_LABELS: Record<string, string> = {
    new_message: 'New message', new_call: 'New call', manual: 'Manual',
    estimate_approved: 'Estimate approved', time_confirmed: 'Time confirmed',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function getTimeAgo(date: Date): string {
    const diff = Date.now() - date.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (hours < 1) return 'now';
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getFullDateTime(date: Date): string {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
        date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// ── Component ────────────────────────────────────────────────────────────────

export function PulseContactItem({ call, isActive, onMarkUnread, onMarkHandled, onSnooze, onSetActionRequired, onRead }: {
    call: Call; isActive: boolean;
    onMarkUnread?: (timelineId: number) => void;
    onMarkHandled?: (timelineId: number) => void;
    onSnooze?: (timelineId: number, until: string) => void;
    onSetActionRequired?: (timelineId: number) => void;
    onRead?: () => void;
}) {
    const navigate = useNavigate();
    const tlId = (call as any).timeline_id;
    const contactId = call.contact?.id || call.id;
    const targetPath = tlId ? `/pulse/timeline/${tlId}` : (contactId ? `/pulse/contact/${contactId}` : null);

    const hasUnread = (call as any).tl_has_unread || (call as any).sms_has_unread || call.has_unread;
    const rawPhone = (call as any).tl_phone || call.contact?.phone_e164 || call.from_number || call.to_number || call.call_sid;
    const displayPhone = (call as any).last_interaction_phone || rawPhone;

    const { lead } = useLeadByPhone(rawPhone);
    const leadName = lead ? [lead.FirstName, lead.LastName].filter(Boolean).join(' ') : null;
    const company = lead?.Company || null;
    const contactName = call.contact?.full_name && call.contact.full_name !== call.contact.phone_e164
        ? call.contact.full_name : null;
    const primaryText = company || leadName || contactName || formatPhoneNumber(displayPhone);
    const showSecondaryPhone = !!(company || leadName || contactName);

    const displayDate = new Date(call.last_interaction_at || call.started_at || call.created_at);
    const interactionType = call.last_interaction_type || 'call';

    const isActionRequired = (call as any).is_action_required || false;
    const arReason = (call as any).action_required_reason || null;
    const snoozedUntil = (call as any).snoozed_until;
    const isSnoozed = snoozedUntil && new Date(snoozedUntil) > new Date();
    const openTask = (call as any).open_task || null;
    const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);

    const callDirection = call.direction === 'inbound' ? 'inbound'
        : call.direction?.startsWith('outbound') ? 'outbound'
            : call.direction === 'internal' ? 'internal' : 'outbound';
    const callColor = STATUS_ICON_COLORS[call.status?.toLowerCase() || ''] || '#16a34a';

    const renderIcon = () => {
        if (interactionType === 'sms_inbound') return <MessageSquareReply className="size-4" style={{ color: '#2563eb' }} />;
        if (interactionType === 'sms_outbound') return <MessageSquare className="size-4" style={{ color: '#7c3aed' }} />;
        if (callDirection === 'internal') return <ArrowLeftRight className="size-4" style={{ color: callColor }} />;
        if (callDirection === 'inbound') return <PhoneIncoming className="size-4" style={{ color: callColor }} />;
        return <PhoneOutgoing className="size-4" style={{ color: callColor }} />;
    };

    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!menuOpen) return;
        const handler = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [menuOpen]);

    return (
        <button
            onClick={() => {
                if (!targetPath) return;
                navigate(targetPath);
                if (tlId) {
                    callsApi.markTimelineRead(tlId)
                        .then(() => { console.log('[Pulse] Marked timeline+SMS read:', tlId); onRead?.(); })
                        .catch((err) => { console.error('[Pulse] Failed to mark timeline read:', tlId, err); });
                }
            }}
            className={`w-full text-left px-4 py-3 transition-colors border-b border-gray-100 relative ${isActive ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
            style={{ outline: 'none' }}
        >
            {hasUnread && (<div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-r" style={{ backgroundColor: '#2563eb' }} />)}
            <div className="flex items-start gap-2.5">
                <div className="shrink-0 pt-0.5">{renderIcon()}</div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between mb-1">
                        <span className={`text-sm truncate ${hasUnread ? 'font-semibold text-gray-900' : 'font-medium text-gray-900'}`}>{primaryText}</span>
                    </div>
                    {showSecondaryPhone && (<div className="text-xs text-gray-600 mb-1 font-mono">{formatPhoneNumber(displayPhone)}</div>)}
                    <div className="flex items-center gap-1 text-xs text-gray-500">
                        <span>{getTimeAgo(displayDate)}</span><span className="text-gray-400">•</span><span>{getFullDateTime(displayDate)}</span>
                    </div>
                    {isActionRequired && !isSnoozed && (
                        <div className="flex items-center gap-1.5 mt-1">
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-100 text-orange-800">
                                <AlertTriangle className="size-3" /> Action Required
                            </span>
                            {arReason && <span className="text-[10px] text-gray-500">{REASON_LABELS[arReason] || arReason}</span>}
                            {openTask?.due_at && (<span className="text-[10px] text-red-500">Due {new Date(openTask.due_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>)}
                        </div>
                    )}
                    {isSnoozed && (
                        <div className="flex items-center gap-1 mt-1">
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600">
                                <Clock className="size-3" /> Snoozed until {new Date(snoozedUntil).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                            </span>
                        </div>
                    )}
                </div>
                {isActive && (
                    <div className="shrink-0 relative" ref={menuRef}>
                        <div role="button" tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); setMenuOpen(prev => !prev); }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setMenuOpen(prev => !prev); } }}
                            className="p-1 rounded hover:bg-blue-100 transition-colors cursor-pointer" title="More options">
                            <MoreVertical className="size-4 text-gray-500" />
                        </div>
                        {menuOpen && (
                            <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-md shadow-lg border border-gray-200 py-1 min-w-[180px]">
                                <div role="button" tabIndex={0}
                                    onClick={(e) => { e.stopPropagation(); setMenuOpen(false); if (tlId && onMarkUnread) onMarkUnread(tlId); }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setMenuOpen(false); if (tlId && onMarkUnread) onMarkUnread(tlId); } }}
                                    className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 cursor-pointer w-full">
                                    <EyeOff className="size-3.5" /> Mark as Unread
                                </div>
                                {!isActionRequired && (
                                    <div role="button" tabIndex={0}
                                        onClick={(e) => { e.stopPropagation(); setMenuOpen(false); if (tlId && onSetActionRequired) onSetActionRequired(tlId); }}
                                        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setMenuOpen(false); if (tlId && onSetActionRequired) onSetActionRequired(tlId); } }}
                                        className="flex items-center gap-2 px-3 py-2 text-sm text-orange-700 hover:bg-orange-50 cursor-pointer w-full">
                                        <AlertTriangle className="size-3.5" /> Action Required
                                    </div>
                                )}
                                {isActionRequired && (
                                    <div role="button" tabIndex={0}
                                        onClick={(e) => { e.stopPropagation(); setMenuOpen(false); if (tlId && onMarkHandled) onMarkHandled(tlId); }}
                                        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setMenuOpen(false); if (tlId && onMarkHandled) onMarkHandled(tlId); } }}
                                        className="flex items-center gap-2 px-3 py-2 text-sm text-green-700 hover:bg-green-50 cursor-pointer w-full">
                                        <CheckCircle2 className="size-3.5" /> Mark Handled
                                    </div>
                                )}
                                {isActionRequired && (
                                    <div className="relative">
                                        <div role="button" tabIndex={0}
                                            onClick={(e) => { e.stopPropagation(); setSnoozeMenuOpen(prev => !prev); }}
                                            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setSnoozeMenuOpen(prev => !prev); } }}
                                            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 cursor-pointer w-full">
                                            <Clock className="size-3.5" /> Snooze…
                                        </div>
                                        {snoozeMenuOpen && (
                                            <div className="absolute right-full top-0 mr-1 z-[100] bg-white rounded-md shadow-lg border border-gray-200 py-1 min-w-[140px]">
                                                {SNOOZE_OPTIONS.map(opt => (
                                                    <div key={opt.label} role="button" tabIndex={0}
                                                        onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setSnoozeMenuOpen(false); if (tlId && onSnooze) onSnooze(tlId, getSnoozeUntil(opt)); }}
                                                        className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 cursor-pointer">
                                                        {opt.label}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </button>
    );
}
