import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import type { Conversation } from '../../types/models';
import CallIcon from '../CallIcon';
import { formatPhoneNumber, formatRelativeTime, formatAbsoluteTime } from '../../utils/formatters';

interface ConversationListItemProps {
    conversation: Conversation;
}

export const ConversationListItem: React.FC<ConversationListItemProps> = ({ conversation }) => {
    const navigate = useNavigate();
    const location = useLocation();

    const isActive = location.pathname === `/conversations/${conversation.id}`;

    const handleClick = () => {
        navigate(`/conversations/${conversation.id}`);
    };

    const { contact, last_message, last_message_at } = conversation;

    return (
        <div
            className={`conversation-list-item ${isActive ? 'active' : ''}`}
            onClick={handleClick}
        >
            <div className="conversation-header">
                <div className="conversation-contact">
                    {last_message && (
                        <CallIcon
                            direction={last_message.metadata?.actual_direction || last_message.direction}
                            status={last_message.metadata.status}
                            metadata={last_message.metadata}
                        />
                    )}
                    <span
                        className="contact-name"
                        dangerouslySetInnerHTML={{
                            __html: contact.name || contact.metadata?.formatted_number || formatPhoneNumber(contact.handle)
                        }}
                    />
                </div>
                <div className="conversation-time">
                    <div className="time-relative">{formatRelativeTime(last_message_at)}</div>
                    <div className="time-absolute">{formatAbsoluteTime(last_message_at)}</div>
                </div>
            </div>
        </div>
    );
};
