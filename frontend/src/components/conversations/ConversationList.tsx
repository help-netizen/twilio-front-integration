import React, { useState } from 'react';
import { useCallsByContact } from '../../hooks/useConversations';
import { useRealtimeEvents } from '../../hooks/useRealtimeEvents';
import { ConversationListItem } from './ConversationListItem';
import { normalizePhoneNumber } from '../../utils/formatters';
import './ConversationList.css';

export const ConversationList: React.FC = () => {
    const { data, isLoading, error, refetch } = useCallsByContact();
    const [searchQuery, setSearchQuery] = useState('');

    // Subscribe to real-time events
    const { connected } = useRealtimeEvents({
        onCallUpdate: (event) => {
            console.log('[CallList] Call updated:', event.call_sid, event.status);
            refetch();
        },
        onCallCreated: (event) => {
            console.log('[CallList] Call created:', event.call_sid);
            refetch();
        }
    });

    const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            console.log('Searching for:', searchQuery);
        }
    };

    // Filter by phone number search
    const calls = data?.conversations || [];
    const filteredCalls = React.useMemo(() => {
        if (!searchQuery.trim()) return calls;

        const normalizedQuery = normalizePhoneNumber(searchQuery);
        return calls.filter(call => {
            const phone = call.from_number || call.to_number || '';
            return normalizePhoneNumber(phone).includes(normalizedQuery);
        });
    }, [calls, searchQuery]);

    if (isLoading) {
        return (
            <div className="conversation-list-container">
                <div className="inbox-header"><h2>Inbox</h2></div>
                <div className="conversation-list-loading"><p>Loading calls...</p></div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="conversation-list-container">
                <div className="inbox-header"><h2>Inbox</h2></div>
                <div className="conversation-list-error"><p>Error loading calls</p></div>
            </div>
        );
    }

    return (
        <div className="conversation-list-container">
            <div className="inbox-header">
                <h2>Inbox</h2>
                <div
                    className="connection-indicator"
                    title={connected ? 'Real-time updates active' : 'Connecting...'}
                    style={{ backgroundColor: connected ? '#10b981' : '#6b7280' }}
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
                    <button className="search-button" title="Search">🔍</button>
                </div>
            </div>
            <div className="conversation-list">
                {filteredCalls.length === 0 ? (
                    <div className="no-results">No calls found</div>
                ) : (
                    filteredCalls.map((call) => (
                        <ConversationListItem key={call.id} call={call} />
                    ))
                )}
            </div>
        </div>
    );
};
