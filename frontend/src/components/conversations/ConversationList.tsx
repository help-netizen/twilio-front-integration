import React, { useState } from 'react';
import { useConversations } from '../../hooks/useConversations';
import { useRealtimeEvents } from '../../hooks/useRealtimeEvents';
import { ConversationListItem } from './ConversationListItem';
import { normalizePhoneNumber } from '../../utils/formatters';
import './ConversationList.css';

export const ConversationList: React.FC = () => {
    const { data: conversations, isLoading, error, refetch } = useConversations();
    const [searchQuery, setSearchQuery] = useState('');

    // Subscribe to real-time events
    const { connected } = useRealtimeEvents({
        onCallUpdate: (event) => {
            console.log('[ConversationList] Call updated:', event.call_sid, event.status);
            // Refetch conversations to get latest data
            refetch();
        },
        onCallCreated: (event) => {
            console.log('[ConversationList] Call created:', event.call_sid);
            // Refetch conversations to include new call
            refetch();
        }
    });

    const handleSearch = () => {
        // Search is handled by filtering below, this just ensures UI updates
        console.log('Searching for:', searchQuery);
    };

    const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            handleSearch();
        }
    };

    // Filter conversations based on normalized phone number search
    const filteredConversations = React.useMemo(() => {
        if (!conversations || !searchQuery.trim()) {
            return conversations || [];
        }

        const normalizedQuery = normalizePhoneNumber(searchQuery);

        return conversations.filter(conv => {
            const phoneNumber = conv.contact.handle || conv.external_id;
            const normalizedPhone = normalizePhoneNumber(phoneNumber);
            return normalizedPhone.includes(normalizedQuery);
        });
    }, [conversations, searchQuery]);

    if (isLoading) {
        return (
            <div className="conversation-list-container">
                <div className="inbox-header">
                    <h2>Inbox</h2>
                </div>
                <div className="conversation-list-loading">
                    <p>Loading conversations...</p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="conversation-list-container">
                <div className="inbox-header">
                    <h2>Inbox</h2>
                </div>
                <div className="conversation-list-error">
                    <p>Error loading conversations</p>
                </div>
            </div>
        );
    }

    return (
        <div className="conversation-list-container">
            <div className="inbox-header">
                <h2>Inbox</h2>
                {/* Real-time connection indicator */}
                <div
                    className="connection-indicator"
                    title={connected ? 'Real-time updates active' : 'Connecting...'}
                    style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        backgroundColor: connected ? '#10b981' : '#6b7280',
                        display: 'inline-block',
                        marginLeft: '8px',
                        verticalAlign: 'middle'
                    }}
                />
                <div className="search-container">
                    <input
                        type="text"
                        className="search-input"
                        placeholder="Search phone..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyPress={handleKeyPress}
                    />
                    <button
                        className="search-button"
                        onClick={handleSearch}
                        title="Search"
                    >
                        🔍
                    </button>
                </div>
            </div>
            <div className="conversation-list">
                {filteredConversations.length === 0 ? (
                    <div className="no-results">No conversations found</div>
                ) : (
                    filteredConversations.map((conversation) => (
                        <ConversationListItem
                            key={conversation.id}
                            conversation={conversation}
                        />
                    ))
                )}
            </div>
        </div>
    );
};
