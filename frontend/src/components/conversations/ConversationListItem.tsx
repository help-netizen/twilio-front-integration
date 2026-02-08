import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import type { Call } from '../../types/models';
import CallIcon from '../CallIcon';
import { formatPhoneNumber, formatRelativeTime, formatAbsoluteTime } from '../../utils/formatters';

interface ConversationListItemProps {
    call: Call;
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

    return (
        <div
            className={`conversation-list-item ${isActive ? 'active' : ''}`}
            onClick={handleClick}
        >
            <div className="conversation-header">
                <div className="conversation-contact">
                    <CallIcon
                        direction={
                            call.direction === 'inbound' ? 'inbound'
                                : call.direction.startsWith('outbound') ? 'outbound'
                                    : call.direction === 'internal' ? 'internal'
                                        : 'external'
                        }
                        status={call.status}
                        metadata={{}}
                    />
                    <span
                        className="contact-name"
                        dangerouslySetInnerHTML={{
                            __html: formatPhoneNumber(displayPhone)
                        }}
                    />
                    {call.call_count && call.call_count > 1 && (
                        <span className="call-count">({call.call_count})</span>
                    )}
                </div>
                <div className="conversation-time">
                    <div className="time-relative">{formatRelativeTime(new Date(displayTime).getTime())}</div>
                    <div className="time-absolute">{formatAbsoluteTime(new Date(displayTime).getTime())}</div>
                </div>
            </div>
        </div>
    );
};
