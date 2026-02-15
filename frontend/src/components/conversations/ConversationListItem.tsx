import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import type { Call } from '../../types/models';
import { PhoneIncoming, PhoneOutgoing, ArrowLeftRight } from 'lucide-react';
import { formatPhoneNumber, formatRelativeTime, formatAbsoluteTime } from '../../utils/formatters';
import { useLeadByPhone } from '../../hooks/useLeadByPhone';
import { cn } from '../../lib/utils';

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
};

function DirectionIcon({ direction, status }: { direction: string; status: string }) {
    const isInbound = direction === 'inbound';
    const isInternal = direction === 'internal';
    const color = STATUS_ICON_COLORS[status?.toLowerCase() || ''] || '#16a34a';

    if (isInternal) return <ArrowLeftRight className="size-4" style={{ color }} />;
    if (isInbound) return <PhoneIncoming className="size-4" style={{ color }} />;
    return <PhoneOutgoing className="size-4" style={{ color }} />;
}

export const ConversationListItem: React.FC<ConversationListItemProps> = ({ call }) => {
    const navigate = useNavigate();
    const location = useLocation();

    // Navigate to contact page (if contact exists) or call detail
    const targetPath = call.contact
        ? `/contact/${call.contact.id}`
        : `/calls/${call.call_sid}`;

    const isActive = location.pathname === targetPath;

    const handleClick = () => {
        navigate(targetPath);
    };

    // Determine display phone number
    const rawPhone = call.contact?.phone_e164
        || call.from_number
        || call.to_number
        || call.call_sid;

    // Fetch lead by phone for name
    const { lead } = useLeadByPhone(rawPhone);
    const leadName = lead
        ? [lead.FirstName, lead.LastName].filter(Boolean).join(' ')
        : null;

    // Determine time for display
    const displayTime = call.started_at || call.created_at;

    // Determine direction for icon
    const iconDirection = call.direction === 'inbound' ? 'inbound'
        : call.direction?.startsWith('outbound') ? 'outbound'
            : call.direction === 'internal' ? 'internal'
                : 'outbound';

    return (
        <div
            className={cn(
                'border-b cursor-pointer transition-colors px-3 py-2.5',
                'hover:bg-muted/50',
                isActive && 'bg-muted border-l-4 border-l-primary'
            )}
            onClick={handleClick}
        >
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <DirectionIcon direction={iconDirection} status={call.status} />
                    <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                            <span className="text-sm font-medium truncate">
                                {leadName || formatPhoneNumber(rawPhone)}
                            </span>
                            {call.call_count && call.call_count > 1 && (
                                <span className="text-xs text-muted-foreground">({call.call_count})</span>
                            )}
                        </div>
                        {leadName && (
                            <span
                                className="text-xs text-muted-foreground/70 truncate block"
                                dangerouslySetInnerHTML={{
                                    __html: formatPhoneNumber(rawPhone)
                                }}
                            />
                        )}
                    </div>
                </div>
                <div className="flex flex-col items-end shrink-0">
                    <div className="text-xs text-muted-foreground font-medium">
                        {formatRelativeTime(new Date(displayTime).getTime())}
                    </div>
                    <div className="text-[10px] text-muted-foreground/60">
                        {formatAbsoluteTime(new Date(displayTime).getTime())}
                    </div>
                </div>
            </div>
        </div>
    );
};
