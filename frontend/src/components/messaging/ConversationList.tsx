import type { Conversation } from '../../types/messaging';

interface ConversationListProps {
    conversations: Conversation[];
    selectedId: string | null;
    onSelect: (conv: Conversation) => void;
}

function formatTime(dateStr: string | null): string {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
        return 'Yesterday';
    } else if (diffDays < 7) {
        return date.toLocaleDateString([], { weekday: 'short' });
    } else {
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
}

function getInitials(conv: Conversation): string {
    if (conv.friendly_name) {
        return conv.friendly_name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
    }
    if (conv.customer_e164) return conv.customer_e164.slice(-2);
    return '??';
}

function formatPhoneDisplay(e164: string | null): string {
    if (!e164) return 'Unknown';
    const match = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
    if (match) return `+1 (${match[1]}) ${match[2]}-${match[3]}`;
    return e164;
}

export function ConversationList({ conversations, selectedId, onSelect }: ConversationListProps) {
    return (
        <div className="conv-list">
            {conversations.map(conv => {
                const isUnread = conv.has_unread;
                const classes = [
                    'conv-item',
                    conv.id === selectedId ? 'conv-item--selected' : '',
                    isUnread ? 'conv-item--unread' : '',
                ].filter(Boolean).join(' ');

                return (
                    <div
                        key={conv.id}
                        className={classes}
                        onClick={() => onSelect(conv)}
                        aria-label={isUnread
                            ? `Contact ${conv.friendly_name || conv.customer_e164 || 'Unknown'}, has unread messages`
                            : undefined
                        }
                    >
                        <div className="conv-item__avatar">{getInitials(conv)}</div>
                        <div className="conv-item__content">
                            <div className="conv-item__top">
                                <span className="conv-item__name">
                                    {isUnread && <span className="conv-item__dot" />}
                                    {conv.friendly_name || formatPhoneDisplay(conv.customer_e164)}
                                </span>
                                <span className="conv-item__time">{formatTime(conv.last_message_at)}</span>
                            </div>
                            <div className="conv-item__preview">
                                {conv.last_message_direction === 'outbound' && (
                                    <span className="conv-item__direction">You: </span>
                                )}
                                {conv.last_message_preview || 'No messages yet'}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
