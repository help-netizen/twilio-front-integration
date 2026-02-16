import { useState, useRef } from 'react';
import { Send, Paperclip, X, FileText, ChevronDown } from 'lucide-react';

interface SmsFormProps {
    onSend: (message: string, file?: File) => Promise<void>;
    disabled?: boolean;
}

const MESSAGE_PRESETS = [
    { id: 'follow-up', label: 'Follow-up', text: 'Hi! Just following up on our previous conversation. Let me know if you have any questions.' },
    { id: 'thank-you', label: 'Thank You', text: 'Thank you for your time today! Looking forward to speaking with you again soon.' },
    { id: 'meeting', label: 'Schedule Meeting', text: 'Would you be available for a quick call this week? Let me know what time works best for you.' },
    { id: 'info', label: 'Send Info', text: 'As promised, here\'s the information we discussed. Feel free to reach out if you need anything else.' },
];

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SmsForm({ onSend, disabled = false }: SmsFormProps) {
    const [message, setMessage] = useState('');
    const [isPresetsOpen, setIsPresetsOpen] = useState(false);
    const [sending, setSending] = useState(false);
    const [attachedFile, setAttachedFile] = useState<File | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setMessage(e.target.value);
        const ta = textareaRef.current;
        if (ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`; }
    };

    const handleSend = async () => {
        const body = message.trim();
        if ((!body && !attachedFile) || sending || disabled) return;
        setSending(true);
        try {
            await onSend(body, attachedFile || undefined);
            setMessage('');
            setAttachedFile(null);
            if (textareaRef.current) textareaRef.current.style.height = 'auto';
        } catch { /* logged in parent */ } finally {
            setSending(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    };

    const handlePresetSelect = (text: string) => {
        setMessage(text);
        setIsPresetsOpen(false);
        textareaRef.current?.focus();
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            if (file.size > 10 * 1024 * 1024) {
                alert('File too large. Maximum size is 10 MB.');
                return;
            }
            setAttachedFile(file);
        }
        e.target.value = '';
    };

    return (
        <div style={{ borderTop: '1px solid #e5e7eb', padding: '12px 16px', backgroundColor: '#ffffff' }}>
            {/* Attachment preview */}
            {attachedFile && (
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '8px 12px',
                        marginBottom: '8px',
                        backgroundColor: '#f3f4f6',
                        borderRadius: '8px',
                        fontSize: '13px',
                    }}
                >
                    <FileText size={16} style={{ color: '#6b7280' }} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {attachedFile.name}
                    </span>
                    <span style={{ color: '#9ca3af', fontSize: '12px' }}>{formatFileSize(attachedFile.size)}</span>
                    <button
                        onClick={() => setAttachedFile(null)}
                        style={{
                            border: 'none',
                            background: 'none',
                            padding: '2px',
                            cursor: 'pointer',
                            color: '#6b7280',
                            display: 'flex',
                        }}
                    >
                        <X size={14} />
                    </button>
                </div>
            )}

            {/* Input row */}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px' }}>
                {/* Presets dropdown */}
                <div style={{ position: 'relative' }}>
                    <button
                        onClick={() => setIsPresetsOpen(!isPresetsOpen)}
                        disabled={disabled || sending}
                        style={{
                            border: '1px solid #e5e7eb',
                            borderRadius: '8px',
                            padding: '8px',
                            backgroundColor: '#ffffff',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '2px',
                            color: '#6b7280',
                        }}
                        title="Quick messages"
                    >
                        <ChevronDown size={16} />
                    </button>
                    {isPresetsOpen && (
                        <div
                            style={{
                                position: 'absolute',
                                bottom: '100%',
                                left: 0,
                                marginBottom: '4px',
                                backgroundColor: '#ffffff',
                                border: '1px solid #e5e7eb',
                                borderRadius: '8px',
                                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                                width: '280px',
                                zIndex: 10,
                                overflow: 'hidden',
                            }}
                        >
                            {MESSAGE_PRESETS.map(p => (
                                <button
                                    key={p.id}
                                    onClick={() => handlePresetSelect(p.text)}
                                    style={{
                                        display: 'block',
                                        width: '100%',
                                        textAlign: 'left',
                                        padding: '10px 14px',
                                        border: 'none',
                                        backgroundColor: 'transparent',
                                        cursor: 'pointer',
                                        fontSize: '13px',
                                    }}
                                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#f3f4f6')}
                                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                                >
                                    <div style={{ fontWeight: 600, marginBottom: '2px' }}>{p.label}</div>
                                    <div style={{ color: '#6b7280', fontSize: '12px', lineHeight: '1.3' }}>{p.text}</div>
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Attach button */}
                <input
                    ref={fileInputRef}
                    type="file"
                    onChange={handleFileChange}
                    accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip"
                    style={{ display: 'none' }}
                />
                <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={disabled || sending}
                    style={{
                        border: '1px solid #e5e7eb',
                        borderRadius: '8px',
                        padding: '8px',
                        backgroundColor: '#ffffff',
                        cursor: 'pointer',
                        display: 'flex',
                        color: '#6b7280',
                    }}
                    title="Attach file"
                >
                    <Paperclip size={16} />
                </button>

                {/* Textarea */}
                <textarea
                    ref={textareaRef}
                    value={message}
                    onChange={handleInput}
                    onKeyDown={handleKeyDown}
                    placeholder="Type a message..."
                    disabled={disabled || sending}
                    rows={1}
                    style={{
                        flex: 1,
                        resize: 'none',
                        border: '1px solid #e5e7eb',
                        borderRadius: '8px',
                        padding: '8px 12px',
                        fontSize: '14px',
                        lineHeight: '1.5',
                        outline: 'none',
                        fontFamily: 'inherit',
                        maxHeight: '120px',
                    }}
                />

                {/* Character counter */}
                {message.length > 0 && (
                    <span style={{ fontSize: '11px', color: message.length > 1600 ? '#ef4444' : '#9ca3af', whiteSpace: 'nowrap' }}>
                        {message.length}
                    </span>
                )}

                {/* Send button */}
                <button
                    onClick={handleSend}
                    disabled={(!message.trim() && !attachedFile) || sending || disabled}
                    style={{
                        border: 'none',
                        borderRadius: '8px',
                        padding: '8px 12px',
                        backgroundColor: (!message.trim() && !attachedFile) || sending || disabled ? '#d1d5db' : '#2563eb',
                        color: '#ffffff',
                        cursor: (!message.trim() && !attachedFile) || sending || disabled ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                    }}
                    title="Send message"
                >
                    {sending ? (
                        <div style={{ width: '16px', height: '16px', border: '2px solid #ffffff', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                    ) : (
                        <Send size={16} />
                    )}
                </button>
            </div>
        </div>
    );
}
