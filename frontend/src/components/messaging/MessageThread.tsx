import { useState, useRef, useEffect } from 'react';
import { Send, FileText, Download } from 'lucide-react';
import type { Message, MessageMedia } from '../../types/messaging';

interface MessageThreadProps {
    messages: Message[];
    loading: boolean;
    onSend: (body: string) => Promise<void>;
}

function formatMessageTime(dateStr: string | null): string {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateSeparator(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function shouldShowDateSeparator(messages: Message[], index: number): boolean {
    if (index === 0) return true;
    const curr = messages[index].date_created_remote || messages[index].created_at;
    const prev = messages[index - 1].date_created_remote || messages[index - 1].created_at;
    return new Date(curr).toDateString() !== new Date(prev).toDateString();
}

function getDeliveryIcon(status: string | null): string {
    switch (status) {
        case 'sent': return '✓';
        case 'delivered': return '✓✓';
        case 'read': return '✓✓';
        case 'failed': case 'undelivered': return '✗';
        default: return '';
    }
}

function formatFileSize(bytes: number | null): string {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function MediaPreviewInline({ media }: { media: MessageMedia }) {
    const mediaUrl = `/api/messaging/media/${media.id}/temporary-url`;

    if (media.preview_kind === 'image') {
        return (
            <div className="msg-media msg-media--image">
                <a href={mediaUrl} target="_blank" rel="noopener noreferrer" title={media.filename || 'Open image'}>
                    <img src={mediaUrl} alt={media.filename || 'Image'} className="msg-media__image" loading="lazy" />
                </a>
                <a href={mediaUrl} download={media.filename || 'image'} target="_blank" rel="noopener noreferrer" className="msg-media__download-overlay" title="Download">
                    <Download size={20} />
                </a>
            </div>
        );
    }
    return (
        <div className="msg-media msg-media--file">
            <a href={mediaUrl} download={media.filename || 'attachment'} target="_blank" rel="noopener noreferrer" className="msg-media__file">
                <span className="msg-media__file-icon">{media.preview_kind === 'pdf' ? <FileText size={20} /> : <Download size={20} />}</span>
                <div className="msg-media__file-info">
                    <span className="msg-media__file-name">{media.filename || 'Attachment'}</span>
                    {media.size_bytes && <span className="msg-media__file-size">{formatFileSize(media.size_bytes)}</span>}
                </div>
            </a>
        </div>
    );
}

export function MessageThread({ messages, loading, onSend }: MessageThreadProps) {
    const [inputValue, setInputValue] = useState('');
    const [sending, setSending] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInputValue(e.target.value);
        const ta = textareaRef.current;
        if (ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`; }
    };

    const handleSend = async () => {
        const body = inputValue.trim();
        if (!body || sending) return;
        setSending(true);
        try {
            await onSend(body);
            setInputValue('');
            if (textareaRef.current) textareaRef.current.style.height = 'auto';
        } catch { /* logged in parent */ } finally { setSending(false); }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    };

    if (loading) {
        return <div className="msg-thread"><div className="msg-thread__loading"><div className="messages-loading-spinner" />Loading messages...</div></div>;
    }

    return (
        <div className="msg-thread">
            <div className="msg-thread__messages">
                {messages.length === 0 ? (
                    <div className="msg-thread__empty">No messages in this conversation</div>
                ) : (
                    messages.map((msg, idx) => (
                        <div key={msg.id}>
                            {shouldShowDateSeparator(messages, idx) && (
                                <div className="msg-date-sep"><span className="msg-date-sep__label">{formatDateSeparator(msg.date_created_remote || msg.created_at)}</span></div>
                            )}
                            <div className={`msg-bubble msg-bubble--${msg.direction}`}>
                                <div className="msg-bubble__content">
                                    {msg.body}
                                    {msg.media?.map(m => <MediaPreviewInline key={m.id} media={m} />)}
                                </div>
                                <div className="msg-bubble__meta">
                                    <span>{formatMessageTime(msg.date_created_remote || msg.created_at)}</span>
                                    {msg.direction === 'outbound' && msg.delivery_status && (
                                        <span className={`msg-bubble__status msg-bubble__status--${msg.delivery_status}`}>{getDeliveryIcon(msg.delivery_status)}</span>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))
                )}
                <div ref={messagesEndRef} />
            </div>
            <div className="msg-sendbox">
                <textarea ref={textareaRef} className="msg-sendbox__input" placeholder="Type a message..." value={inputValue} onChange={handleInput} onKeyDown={handleKeyDown} rows={1} disabled={sending} />
                <button className="msg-sendbox__send" onClick={handleSend} disabled={!inputValue.trim() || sending} title="Send message"><Send size={18} /></button>
            </div>
        </div>
    );
}
