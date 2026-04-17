import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Mail, Reply, PenSquare, AlertTriangle } from 'lucide-react';
import { getThreadDetail, markThreadRead } from '../../services/emailApi';
import { EmailMessageItem } from './EmailMessageItem';
import { EmailComposer } from './EmailComposer';
import { FullscreenImageViewer, type ViewerImage } from '../shared/FullscreenImageViewer';

interface EmailThreadPaneProps {
    threadId: number | null;
    mailboxStatus?: string | null;
    onThreadUpdated?: () => void;
}

export function EmailThreadPane({ threadId, mailboxStatus, onThreadUpdated }: EmailThreadPaneProps) {
    const navigate = useNavigate();
    const [replyMode, setReplyMode] = useState(false);
    const [composeMode, setComposeMode] = useState(false);
    const [viewerImages, setViewerImages] = useState<ViewerImage[] | null>(null);
    const [viewerIndex, setViewerIndex] = useState(0);

    const canSend = mailboxStatus === 'connected';

    const handleImagePreview = useCallback((images: ViewerImage[], index: number) => {
        setViewerImages(images);
        setViewerIndex(index);
    }, []);

    // Reset modes when thread changes
    useEffect(() => {
        setReplyMode(false);
        setComposeMode(false);
    }, [threadId]);

    const { data, isLoading } = useQuery({
        queryKey: ['email-thread', threadId],
        queryFn: () => getThreadDetail(threadId!),
        enabled: !!threadId,
    });

    // Mark read on open
    const markReadMutation = useMutation({ mutationFn: markThreadRead });

    useEffect(() => {
        if (data?.thread && data.thread.unread_count > 0 && threadId) {
            markReadMutation.mutate(threadId, { onSuccess: () => onThreadUpdated?.() });
        }
    }, [data?.thread?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    // No thread selected
    if (!threadId) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
                <Mail className="size-10" style={{ color: 'var(--blanc-ink-3)' }} />
                <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>Select a thread to read</p>
                {canSend && (
                    <button
                        className="flex items-center gap-1.5 text-sm font-medium mt-2"
                        onClick={() => setComposeMode(true)}
                        style={{
                            background: 'var(--blanc-ink-1)', color: '#fff',
                            padding: '7px 16px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                        }}
                    >
                        <PenSquare className="size-3.5" />
                        New email
                    </button>
                )}
                {!canSend && mailboxStatus === 'reconnect_required' && (
                    <ReconnectBanner onNavigate={() => navigate('/settings/email')} />
                )}
                {composeMode && (
                    <div className="w-full max-w-xl mt-4">
                        <EmailComposer
                            mode="compose"
                            onSent={() => { setComposeMode(false); onThreadUpdated?.(); }}
                            onCancel={() => setComposeMode(false)}
                        />
                    </div>
                )}
            </div>
        );
    }

    if (isLoading) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>Loading thread...</p>
            </div>
        );
    }

    if (!data) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>Thread not found</p>
            </div>
        );
    }

    const { thread, messages } = data;
    const lastMessage = messages[messages.length - 1];

    // Derive default reply-to from last inbound message or last message
    const replyTo = lastMessage?.from_email || '';

    return (
        <div className="flex-1 flex flex-col h-full overflow-hidden">
            {/* Reconnect banner */}
            {mailboxStatus === 'reconnect_required' && (
                <ReconnectBanner onNavigate={() => navigate('/settings/email')} />
            )}

            {/* Thread header */}
            <div className="px-4 py-3 flex items-center justify-between shrink-0" style={{ borderBottom: '1px solid var(--blanc-line)' }}>
                <div className="min-w-0 flex-1">
                    <h3 className="text-base font-semibold truncate" style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}>
                        {thread.subject || '(no subject)'}
                    </h3>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--blanc-ink-3)' }}>
                        {thread.message_count} message{thread.message_count !== 1 ? 's' : ''}
                    </p>
                </div>
                {canSend && (
                    <div className="flex items-center gap-2 shrink-0">
                        <button
                            className="flex items-center gap-1.5 text-sm"
                            onClick={() => { setReplyMode(!replyMode); setComposeMode(false); }}
                            style={{
                                background: replyMode ? 'rgba(117, 106, 89, 0.08)' : 'transparent',
                                color: 'var(--blanc-ink-2)', padding: '5px 12px',
                                borderRadius: '8px', border: '1px solid var(--blanc-line)', cursor: 'pointer',
                            }}
                        >
                            <Reply className="size-3.5" />
                            Reply
                        </button>
                        <button
                            className="flex items-center gap-1.5 text-sm"
                            onClick={() => { setComposeMode(!composeMode); setReplyMode(false); }}
                            style={{
                                background: composeMode ? 'rgba(117, 106, 89, 0.08)' : 'transparent',
                                color: 'var(--blanc-ink-2)', padding: '5px 12px',
                                borderRadius: '8px', border: '1px solid var(--blanc-line)', cursor: 'pointer',
                            }}
                        >
                            <PenSquare className="size-3.5" />
                            New
                        </button>
                    </div>
                )}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto">
                {messages.map((msg, i) => (
                    <EmailMessageItem key={msg.id} message={msg} isLast={i === messages.length - 1} onImagePreview={handleImagePreview} />
                ))}
            </div>

            {/* Reply composer */}
            {replyMode && canSend && (
                <EmailComposer
                    mode="reply"
                    threadId={threadId}
                    defaultTo={replyTo}
                    defaultSubject={`Re: ${thread.subject || ''}`}
                    onSent={() => { setReplyMode(false); onThreadUpdated?.(); }}
                    onCancel={() => setReplyMode(false)}
                />
            )}

            {/* Compose new (from thread pane) */}
            {composeMode && canSend && (
                <EmailComposer
                    mode="compose"
                    onSent={() => { setComposeMode(false); onThreadUpdated?.(); }}
                    onCancel={() => setComposeMode(false)}
                />
            )}

            {/* Fullscreen image viewer */}
            {viewerImages && (
                <FullscreenImageViewer
                    images={viewerImages}
                    initialIndex={viewerIndex}
                    onClose={() => setViewerImages(null)}
                />
            )}
        </div>
    );
}

function ReconnectBanner({ onNavigate }: { onNavigate: () => void }) {
    return (
        <div
            className="flex items-center gap-2 px-4 py-2 text-sm"
            style={{ background: 'rgba(245, 158, 11, 0.08)', color: '#b45309' }}
        >
            <AlertTriangle className="size-4 shrink-0" />
            <span className="flex-1">Gmail connection expired. Reconnect to send or reply.</span>
            <button
                onClick={onNavigate}
                className="text-xs font-medium px-3 py-1"
                style={{ background: '#b45309', color: '#fff', borderRadius: '6px', border: 'none', cursor: 'pointer' }}
            >
                Reconnect
            </button>
        </div>
    );
}
