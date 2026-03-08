import { useState, useEffect, useCallback } from 'react';
import { Search, MessageSquare, Plus, ArrowLeft } from 'lucide-react';
import { messagingApi } from '../services/messagingApi';
import { ConversationList } from '../components/messaging/ConversationList';
import { MessageThread } from '../components/messaging/MessageThread';
import { NewConversationDialog } from '../components/messaging/NewConversationDialog';
import { useMessagesRealtime } from './useMessagesRealtime';
import type { Conversation, Message } from '../types/messaging';
import './MessagesPage.css';

export function MessagesPage() {
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState(true);
    const [messagesLoading, setMessagesLoading] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [showNewDialog, setShowNewDialog] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadConversations = useCallback(async () => { try { const result = await messagingApi.getConversations(); setConversations(result.conversations); setError(null); } catch (err: any) { console.error('Failed to load conversations:', err); setError('Failed to load conversations'); } finally { setLoading(false); } }, []);
    useEffect(() => { loadConversations(); }, [loadConversations]);

    const loadMessages = useCallback(async (conversationId: string) => { setMessagesLoading(true); try { const result = await messagingApi.getMessages(conversationId); setMessages(result.messages); } catch (err: any) { console.error('Failed to load messages:', err); } finally { setMessagesLoading(false); } }, []);
    useEffect(() => { if (selectedConversation) loadMessages(selectedConversation.id); else setMessages([]); }, [selectedConversation, loadMessages]);

    useMessagesRealtime(selectedConversation, setMessages, setConversations, setSelectedConversation);

    const handleSelectConversation = (conv: Conversation) => {
        setSelectedConversation(conv);
        if (conv.has_unread) { setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, has_unread: false } : c)); setSelectedConversation({ ...conv, has_unread: false }); messagingApi.markRead(conv.id).catch(() => { setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, has_unread: true } : c)); }); }
    };

    const handleSendMessage = async (body: string, file?: File) => { if (!selectedConversation) return; try { const message = await messagingApi.sendMessage(selectedConversation.id, { body }, file); setMessages(prev => [...prev, message]); } catch (err: any) { console.error('Failed to send message:', err); throw err; } };
    const handleNewConversation = async (customerE164: string, proxyE164: string, initialMessage?: string) => { try { const result = await messagingApi.startConversation({ customerE164, proxyE164, initialMessage }); setShowNewDialog(false); await loadConversations(); setSelectedConversation(result.conversation); } catch (err: any) { console.error('Failed to start conversation:', err); throw err; } };

    const filteredConversations = conversations.filter(conv => { if (!searchQuery) return true; const q = searchQuery.toLowerCase(); return conv.customer_e164?.toLowerCase().includes(q) || conv.friendly_name?.toLowerCase().includes(q) || conv.last_message_preview?.toLowerCase().includes(q); });

    return (
        <div className="messages-page">
            <div className={`messages-sidebar ${selectedConversation ? 'messages-sidebar--hidden-mobile' : ''}`}>
                <div className="messages-sidebar__header"><h2 className="messages-sidebar__title">Messages</h2><button className="messages-sidebar__new-btn" onClick={() => setShowNewDialog(true)} title="New conversation"><Plus size={18} /></button></div>
                <div className="messages-sidebar__search"><Search size={16} className="messages-sidebar__search-icon" /><input type="text" placeholder="Search conversations..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="messages-sidebar__search-input" /></div>
                {loading ? <div className="messages-sidebar__empty"><div className="messages-loading-spinner" /><span>Loading conversations...</span></div> : error ? <div className="messages-sidebar__empty messages-sidebar__empty--error"><span>{error}</span><button onClick={loadConversations} className="messages-retry-btn">Retry</button></div> : filteredConversations.length === 0 ? <div className="messages-sidebar__empty"><MessageSquare size={40} strokeWidth={1.5} /><span>{searchQuery ? 'No matches found' : 'No conversations yet'}</span>{!searchQuery && <button onClick={() => setShowNewDialog(true)} className="messages-start-btn">Start a conversation</button>}</div> : <ConversationList conversations={filteredConversations} selectedId={selectedConversation?.id || null} onSelect={handleSelectConversation} />}
            </div>
            <div className={`messages-main ${selectedConversation ? '' : 'messages-main--hidden-mobile'}`}>
                {selectedConversation ? <>
                    <div className="messages-main__header"><button className="messages-main__back-btn" onClick={() => setSelectedConversation(null)}><ArrowLeft size={18} /></button><div className="messages-main__header-info"><span className="messages-main__header-name">{selectedConversation.friendly_name || selectedConversation.customer_e164 || 'Unknown'}</span><span className="messages-main__header-phone">{selectedConversation.customer_e164 || ''}</span></div><span className={`messages-main__header-state messages-main__header-state--${selectedConversation.state}`}>{selectedConversation.state}</span></div>
                    <MessageThread messages={messages} loading={messagesLoading} onSend={handleSendMessage} />
                </> : <div className="messages-main__empty"><MessageSquare size={56} strokeWidth={1.2} /><h3>Select a conversation</h3><p>Choose a conversation from the list or start a new one.</p></div>}
            </div>
            {showNewDialog && <NewConversationDialog onSubmit={handleNewConversation} onClose={() => setShowNewDialog(false)} />}
        </div>
    );
}
