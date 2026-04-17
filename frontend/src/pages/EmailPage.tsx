import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Mail, Settings } from 'lucide-react';
import { MailboxRail } from '../components/email/MailboxRail';
import { EmailThreadList } from '../components/email/EmailThreadList';
import { EmailThreadPane } from '../components/email/EmailThreadPane';
import { getWorkspaceMailbox, getThreads, triggerManualSync, type EmailMailbox } from '../services/emailApi';
import { useAuth } from '../auth/AuthProvider';

export function EmailPage() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { hasPermission } = useAuth();

    const [activeView, setActiveView] = useState('inbox');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
    const [cursor, setCursor] = useState<string | null>(null);

    // Mailbox status
    const { data: mailbox, isLoading: mailboxLoading } = useQuery<EmailMailbox | null>({
        queryKey: ['email-mailbox'],
        queryFn: getWorkspaceMailbox,
    });

    // Thread list
    const { data: threadData, isLoading: threadsLoading } = useQuery({
        queryKey: ['email-threads', activeView, searchQuery, cursor],
        queryFn: () => getThreads({ view: activeView, q: searchQuery || undefined, cursor: cursor || undefined }),
        enabled: !!mailbox && mailbox.status !== 'disconnected',
    });

    // Sync mutation
    const syncMutation = useMutation({
        mutationFn: triggerManualSync,
        onSuccess: () => {
            toast.success('Sync started');
            setTimeout(() => {
                queryClient.invalidateQueries({ queryKey: ['email-threads'] });
                queryClient.invalidateQueries({ queryKey: ['email-mailbox'] });
            }, 3000);
        },
        onError: () => toast.error('Sync failed'),
    });

    const handleViewChange = useCallback((view: string) => {
        setActiveView(view);
        setCursor(null);
        setSelectedThreadId(null);
    }, []);

    const handleSearch = useCallback((q: string) => {
        setSearchQuery(q);
        setCursor(null);
        setSelectedThreadId(null);
    }, []);

    const handleLoadMore = useCallback(() => {
        if (threadData?.nextCursor) {
            setCursor(threadData.nextCursor);
        }
    }, [threadData]);

    const handleThreadSelect = useCallback((threadId: number) => {
        setSelectedThreadId(threadId);
    }, []);

    const handleThreadUpdated = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['email-threads'] });
    }, [queryClient]);

    if (mailboxLoading) {
        return (
            <div className="flex items-center justify-center h-full">
                <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>Loading...</p>
            </div>
        );
    }

    // No mailbox — empty state
    if (!mailbox || mailbox.status === 'disconnected') {
        const canManage = hasPermission?.('tenant.integrations.manage');
        return (
            <div className="flex flex-col items-center justify-center h-full gap-4">
                <Mail className="size-12" style={{ color: 'var(--blanc-ink-3)' }} />
                <div className="text-center">
                    <p className="text-lg font-medium" style={{ color: 'var(--blanc-ink-1)' }}>No email mailbox connected</p>
                    <p className="text-sm mt-1" style={{ color: 'var(--blanc-ink-2)' }}>
                        {canManage
                            ? 'Connect a Gmail mailbox in Settings to start using email.'
                            : 'Ask an admin to connect a Gmail mailbox in Settings.'}
                    </p>
                </div>
                {canManage && (
                    <button
                        className="flex items-center gap-2 text-sm font-medium"
                        onClick={() => navigate('/settings/email')}
                        style={{
                            background: 'var(--blanc-ink-1)', color: '#fff',
                            padding: '8px 20px', borderRadius: '10px', border: 'none', cursor: 'pointer',
                        }}
                    >
                        <Settings className="size-4" />
                        Go to Settings
                    </button>
                )}
            </div>
        );
    }

    const threads = threadData?.threads || [];

    return (
        <div className="flex h-full" style={{ background: 'var(--blanc-bg)' }}>
            <MailboxRail
                mailbox={mailbox}
                activeView={activeView}
                onViewChange={handleViewChange}
                onSync={() => syncMutation.mutate()}
                isSyncing={syncMutation.isPending}
            />
            <EmailThreadList
                threads={threads}
                selectedThreadId={selectedThreadId}
                onSelectThread={handleThreadSelect}
                hasMore={threadData?.hasMore || false}
                onLoadMore={handleLoadMore}
                isLoading={threadsLoading}
                searchQuery={searchQuery}
                onSearchChange={handleSearch}
            />
            <EmailThreadPane
                threadId={selectedThreadId}
                onThreadUpdated={handleThreadUpdated}
            />
        </div>
    );
}
