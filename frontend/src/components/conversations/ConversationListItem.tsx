import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import type { Call } from '../../types/models';
import { PhoneIncoming, PhoneOutgoing, ArrowLeftRight } from 'lucide-react';
import { formatPhoneNumber, formatRelativeTime, formatAbsoluteTime } from '../../utils/formatters';
import { cn } from '../../lib/utils';

interface ConversationListItemProps {
    call: Call;
}

function DirectionIcon({ direction, status }: { direction: string; status: string }) {
    const isMissed = ['no-answer', 'busy', 'canceled', 'failed'].includes(status?.toLowerCase() || '');
    const isInbound = direction === 'inbound';
    const isInternal = direction === 'internal';

    const colorClass = isMissed
        ? 'text-destructive'
        : 'text-muted-foreground';

    if (isInternal) return <ArrowLeftRight className={cn('size-4', colorClass)} />;
    if (isInbound) return <PhoneIncoming className={cn('size-4', colorClass)} />;
    return <PhoneOutgoing className={cn('size-4', colorClass)} />;
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
    const displayPhone = call.contact?.full_name
        || call.contact?.phone_e164
        || call.from_number
        || call.to_number
        || call.call_sid;

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
                    <span
                        className="text-sm font-medium truncate"
                        dangerouslySetInnerHTML={{
                            __html: formatPhoneNumber(displayPhone)
                        }}
                    />
                    {call.call_count && call.call_count > 1 && (
                        <span className="text-xs text-muted-foreground">({call.call_count})</span>
                    )}
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
