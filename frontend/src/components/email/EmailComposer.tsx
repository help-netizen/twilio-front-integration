import { useState, useRef } from 'react';
import { Send, Paperclip, X } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { composeEmail, replyToThread } from '../../services/emailApi';

interface EmailComposerProps {
    mode: 'compose' | 'reply';
    threadId?: number;
    defaultTo?: string;
    defaultSubject?: string;
    onSent?: () => void;
    onCancel?: () => void;
}

export function EmailComposer({ mode, threadId, defaultTo, defaultSubject, onSent, onCancel }: EmailComposerProps) {
    const queryClient = useQueryClient();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [to, setTo] = useState(defaultTo || '');
    const [cc, setCc] = useState('');
    const [subject, setSubject] = useState(defaultSubject || '');
    const [body, setBody] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const [showCc, setShowCc] = useState(false);

    const sendMutation = useMutation({
        mutationFn: async () => {
            const formData = new FormData();
            to.split(',').map(s => s.trim()).filter(Boolean).forEach(addr => formData.append('to[]', addr));
            if (cc) cc.split(',').map(s => s.trim()).filter(Boolean).forEach(addr => formData.append('cc[]', addr));
            if (mode === 'compose') formData.append('subject', subject);
            formData.append('body', body);
            files.forEach(f => formData.append('files', f));

            if (mode === 'reply' && threadId) {
                return replyToThread(threadId, formData);
            }
            return composeEmail(formData);
        },
        onSuccess: () => {
            toast.success(mode === 'reply' ? 'Reply sent' : 'Email sent');
            setTo(''); setCc(''); setSubject(''); setBody(''); setFiles([]);
            queryClient.invalidateQueries({ queryKey: ['email-threads'] });
            if (threadId) queryClient.invalidateQueries({ queryKey: ['email-thread', threadId] });
            onSent?.();
        },
        onError: (err: Error) => toast.error(err.message || 'Failed to send'),
    });

    const handleFileAdd = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) setFiles(prev => [...prev, ...Array.from(e.target.files!)]);
        e.target.value = '';
    };

    const removeFile = (index: number) => setFiles(prev => prev.filter((_, i) => i !== index));

    const canSend = to.trim().length > 0 && (mode === 'reply' || subject.trim().length > 0) && (body.trim().length > 0 || files.length > 0);

    return (
        <div style={{ borderTop: '1px solid var(--blanc-line)', background: 'rgba(117, 106, 89, 0.02)' }}>
            <div className="px-4 py-3 space-y-2">
                {/* To */}
                <div className="flex items-center gap-2">
                    <label className="text-xs shrink-0" style={{ color: 'var(--blanc-ink-3)', width: '32px' }}>To</label>
                    <input
                        type="text"
                        value={to}
                        onChange={e => setTo(e.target.value)}
                        placeholder="recipient@example.com"
                        className="flex-1 text-sm py-1 px-2"
                        style={{
                            background: 'transparent', border: 'none', outline: 'none',
                            color: 'var(--blanc-ink-1)',
                        }}
                    />
                    {!showCc && (
                        <button
                            className="text-xs"
                            onClick={() => setShowCc(true)}
                            style={{ color: 'var(--blanc-ink-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                        >
                            Cc
                        </button>
                    )}
                </div>

                {/* Cc */}
                {showCc && (
                    <div className="flex items-center gap-2">
                        <label className="text-xs shrink-0" style={{ color: 'var(--blanc-ink-3)', width: '32px' }}>Cc</label>
                        <input
                            type="text"
                            value={cc}
                            onChange={e => setCc(e.target.value)}
                            placeholder="cc@example.com"
                            className="flex-1 text-sm py-1 px-2"
                            style={{ background: 'transparent', border: 'none', outline: 'none', color: 'var(--blanc-ink-1)' }}
                        />
                    </div>
                )}

                {/* Subject (compose only) */}
                {mode === 'compose' && (
                    <div className="flex items-center gap-2">
                        <label className="text-xs shrink-0" style={{ color: 'var(--blanc-ink-3)', width: '32px' }}>Subj</label>
                        <input
                            type="text"
                            value={subject}
                            onChange={e => setSubject(e.target.value)}
                            placeholder="Subject"
                            className="flex-1 text-sm py-1 px-2"
                            style={{ background: 'transparent', border: 'none', outline: 'none', color: 'var(--blanc-ink-1)' }}
                        />
                    </div>
                )}

                {/* Body */}
                <textarea
                    value={body}
                    onChange={e => setBody(e.target.value)}
                    placeholder={mode === 'reply' ? 'Write your reply...' : 'Write your message...'}
                    rows={4}
                    className="w-full text-sm p-2 resize-none"
                    style={{
                        background: 'var(--blanc-bg)', border: '1px solid var(--blanc-line)',
                        borderRadius: '8px', color: 'var(--blanc-ink-1)', outline: 'none',
                    }}
                />

                {/* Attachments preview */}
                {files.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {files.map((f, i) => (
                            <span
                                key={i}
                                className="flex items-center gap-1 text-xs px-2 py-1"
                                style={{ background: 'rgba(117, 106, 89, 0.06)', borderRadius: '6px', color: 'var(--blanc-ink-2)' }}
                            >
                                <Paperclip className="size-3" />
                                {f.name}
                                <button onClick={() => removeFile(i)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>
                                    <X className="size-3" style={{ color: 'var(--blanc-ink-3)' }} />
                                </button>
                            </span>
                        ))}
                    </div>
                )}

                {/* Actions */}
                <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-2">
                        <input ref={fileInputRef} type="file" multiple onChange={handleFileAdd} className="hidden" />
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px' }}
                        >
                            <Paperclip className="size-4" style={{ color: 'var(--blanc-ink-3)' }} />
                        </button>
                    </div>
                    <div className="flex items-center gap-2">
                        {onCancel && (
                            <button
                                onClick={onCancel}
                                className="text-sm px-3 py-1.5"
                                style={{
                                    background: 'transparent', border: '1px solid var(--blanc-line)',
                                    borderRadius: '8px', color: 'var(--blanc-ink-2)', cursor: 'pointer',
                                }}
                            >
                                Cancel
                            </button>
                        )}
                        <button
                            onClick={() => sendMutation.mutate()}
                            disabled={!canSend || sendMutation.isPending}
                            className="flex items-center gap-1.5 text-sm px-4 py-1.5"
                            style={{
                                background: canSend ? 'var(--blanc-ink-1)' : 'var(--blanc-ink-3)',
                                color: '#fff', borderRadius: '8px', border: 'none',
                                cursor: canSend ? 'pointer' : 'not-allowed', opacity: sendMutation.isPending ? 0.7 : 1,
                            }}
                        >
                            <Send className="size-3.5" />
                            {sendMutation.isPending ? 'Sending...' : 'Send'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
