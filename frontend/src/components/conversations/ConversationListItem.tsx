import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import type { Call } from '../../types/models';
import { PhoneIncoming, PhoneOutgoing, ArrowLeftRight } from 'lucide-react';
import { formatPhoneNumber } from '../../utils/formatters';
import { useLeadByPhone } from '../../hooks/useLeadByPhone';

interface ConversationListItemProps {
    call: Call;
}

const STATUS_ICON_COLORS: Record<string, string> = {
    'completed': '#16a34a',
    'no-answer': '#dc2626',
    'busy': '#ea580c',
    'failed': '#dc2626',
    'canceled': '#dc2626',
    'ringing': '#2563eb',
    'in-progress': '#7c3aed',
    'queued': '#2563eb',
    'initiated': '#2563eb',
    'voicemail_recording': '#ea580c',
    'voicemail_left': '#dc2626',
};

function DirectionIcon({ direction, status }: { direction: string; status: string }) {
    const isInbound = direction === 'inbound';
    const isInternal = direction === 'internal';
    const color = STATUS_ICON_COLORS[status?.toLowerCase() || ''] || '#16a34a';

    if (isInternal) return <ArrowLeftRight className="size-4" style={{ color }} />;
    if (isInbound) return <PhoneIncoming className="size-4" style={{ color }} />;
    return <PhoneOutgoing className="size-4" style={{ color }} />;
}

function getTimeAgo(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (hours < 1) return 'now';
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getFullDateTime(date: Date): string {
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
    }) + ', ' + date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
}

export const ConversationListItem: React.FC<ConversationListItemProps> = ({ call }) => {
    const navigate = useNavigate();
    const location = useLocation();

    const tlId = (call as any).timeline_id;
    const targetPath = call.contact
        ? `/contact/${call.contact.id}`
        : tlId
            ? `/pulse/timeline/${tlId}`
            : `/calls/${call.call_sid}`;

    const isActive = location.pathname === targetPath;

    const handleClick = () => {
        navigate(targetPath);
    };

    // Determine display phone number — prefer timeline phone (external party)
    const rawPhone = (call as any).tl_phone
        || (call as any).last_interaction_phone
        || call.contact?.phone_e164
        || call.from_number
        || call.to_number
        || call.call_sid;

    // Fetch lead by phone for name / company
    const { lead } = useLeadByPhone(rawPhone);
    const leadName = lead
        ? [lead.FirstName, lead.LastName].filter(Boolean).join(' ')
        : null;
    const company = lead?.Company || null;

    // Primary display text: company > name > phone
    const primaryText = company || leadName || formatPhoneNumber(rawPhone);
    // Show secondary phone line only when we have a name/company above
    const showSecondaryPhone = !!(company || leadName);

    // Time for display
    const displayDate = new Date(call.started_at || call.created_at);

    // Direction for icon
    const iconDirection = call.direction === 'inbound' ? 'inbound'
        : call.direction?.startsWith('outbound') ? 'outbound'
            : call.direction === 'internal' ? 'internal'
                : 'outbound';

    return (
        <button
            onClick={handleClick}
            className={`w-full text-left px-4 py-3 transition-colors border-b border-gray-100 ${isActive ? 'bg-blue-50' : 'hover:bg-gray-50'
                }`}
            style={{ outline: 'none' }}
        >
            <div className="flex items-start gap-2.5">
                {/* Direction icon — left side */}
                <div className="shrink-0 pt-0.5">
                    <DirectionIcon direction={iconDirection} status={call.status} />
                </div>

                {/* Text content */}
                <div className="min-w-0 flex-1">
                    {/* Row 1: Primary line */}
                    <div className="flex items-baseline justify-between mb-1">
                        <span className="text-sm font-medium text-gray-900 truncate">
                            {primaryText}
                        </span>
                        {call.call_count !== undefined && call.call_count !== null && (
                            <span className="text-xs text-gray-500 ml-2 shrink-0">
                                ({call.call_count})
                            </span>
                        )}
                    </div>

                    {/* Row 2: Secondary phone (conditional) */}
                    {showSecondaryPhone && (
                        <div className="text-xs text-gray-600 mb-1 font-mono">
                            {formatPhoneNumber(rawPhone)}
                        </div>
                    )}

                    {/* Row 3: Metadata */}
                    <div className="flex items-center gap-1 text-xs text-gray-500">
                        <span>{getTimeAgo(displayDate)}</span>
                        <span className="text-gray-400">•</span>
                        <span>{getFullDateTime(displayDate)}</span>
                    </div>
                </div>
            </div>
        </button>
    );
};
