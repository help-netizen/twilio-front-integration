import React from 'react';
import { useParams } from 'react-router-dom';
import { useConversation, useConversationMessages } from '../hooks/useConversations';
import { ConversationList } from '../components/conversations/ConversationList';
import CallIcon from '../components/CallIcon';
import { createPhoneLink } from '../utils/formatters';
import './ConversationPage.css';

export const ConversationPage: React.FC = () => {
    const { id } = useParams<{ id: string }>();
    const { data: conversation, isLoading: conversationLoading } = useConversation(id!);
    const { data: messages, isLoading: messagesLoading } = useConversationMessages(id!);

    if (conversationLoading || messagesLoading) {
        return (
            <div className="home-page">
                <div className="inbox-sidebar">
                    <ConversationList />
                </div>
                <div className="conversation-area">
                    <div className="loading">Loading...</div>
                </div>
            </div>
        );
    }

    if (!conversation) {
        return (
            <div className="home-page">
                <div className="inbox-sidebar">
                    <ConversationList />
                </div>
                <div className="conversation-area">
                    <div className="error">Conversation not found</div>
                </div>
            </div>
        );
    }

    return (
        <div className="home-page">
            <div className="inbox-sidebar">
                <ConversationList />
            </div>

            <div className="conversation-area">
                <div className="conversation-header">
                    <div className="header-left">
                        <h2 dangerouslySetInnerHTML={{
                            __html: createPhoneLink(conversation.contact.name || conversation.contact.handle || conversation.external_id)
                        }} />
                        <div className="conversation-stats">
                            {conversation.metadata.total_calls} calls
                        </div>
                    </div>
                </div>

                <div className="messages-area">
                    {messages?.map((message) => (
                        <div key={message.id} className="message-card">
                            <div className="message-content">
                                <div className="message-box">
                                    <div className="message-header">
                                        <CallIcon
                                            direction={message.metadata.actual_direction || message.direction}
                                            status={message.call?.status || 'unknown'}
                                            metadata={message.metadata}
                                        />
                                        <div className="message-subject-text">
                                            {message.subject}
                                        </div>
                                    </div>

                                    <div
                                        className="message-body"
                                        dangerouslySetInnerHTML={{ __html: message.body.replace(/\n/g, '<br />') }}
                                    />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
