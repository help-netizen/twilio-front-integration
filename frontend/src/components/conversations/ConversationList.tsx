import React, { useState } from 'react';
import { useConversations } from '../../hooks/useConversations';
import { ConversationListItem } from './ConversationListItem';
import { normalizePhoneNumber } from '../../utils/formatters';
import './ConversationList.css';

export const ConversationList: React.FC = () => {
    const { data: conversations, isLoading, error } = useConversations();
    const [searchQuery, setSearchQuery] = useState('');

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
