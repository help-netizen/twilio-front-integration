import React from 'react';
import { ConversationList } from '../components/conversations/ConversationList';
import './HomePage.css';

export const HomePage: React.FC = () => {
    return (
        <div className="home-page">
            <div className="inbox-sidebar">
                <ConversationList />
            </div>

            <div className="conversation-area">
                <div className="empty-conversation">
                    <div className="empty-icon">📞</div>
                    <h3>Select a conversation</h3>
                    <p>Choose a conversation from the list to view call history</p>
                </div>
            </div>
        </div>
    );
};
