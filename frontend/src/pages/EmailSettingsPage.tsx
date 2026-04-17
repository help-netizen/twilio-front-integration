import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Mail, RefreshCw, Unplug, ExternalLink, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { getMailboxSettings, startGoogleConnect, disconnectMailbox, triggerManualSync, type EmailMailbox } from '../services/emailApi';

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
    connected: { label: 'Connected', color: 'text-green-600', icon: <CheckCircle2 className="size-4 text-green-600" /> },
    reconnect_required: { label: 'Reconnect required', color: 'text-amber-600', icon: <AlertTriangle className="size-4 text-amber-600" /> },
    sync_error: { label: 'Sync error', color: 'text-amber-600', icon: <AlertTriangle className="size-4 text-amber-600" /> },
    disconnected: { label: 'Disconnected', color: 'text-gray-400', icon: <XCircle className="size-4 text-gray-400" /> },
};

function formatSyncTime(iso: string | null): string {
    if (!iso) return 'Never';
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function EmailSettingsPage() {
    const queryClient = useQueryClient();
    const [searchParams, setSearchParams] = useSearchParams();

    const { data: mailbox, isLoading } = useQuery<EmailMailbox | null>({
        queryKey: ['email-settings'],
        queryFn: getMailboxSettings,
    });

    // Handle OAuth redirect params
    useEffect(() => {
        if (searchParams.get('connected') === '1') {
            toast.success('Gmail mailbox connected');
            setSearchParams({}, { replace: true });
            queryClient.invalidateQueries({ queryKey: ['email-settings'] });
        }
        const error = searchParams.get('error');
        if (error) {
            toast.error(`Failed to connect: ${error}`);
            setSearchParams({}, { replace: true });
        }
    }, [searchParams, setSearchParams, queryClient]);

    const connectMutation = useMutation({
        mutationFn: startGoogleConnect,
        onSuccess: (authUrl) => { window.location.href = authUrl; },
        onError: () => toast.error('Failed to start Gmail connection'),
    });

    const disconnectMutation = useMutation({
        mutationFn: disconnectMailbox,
        onSuccess: () => {
            toast.success('Mailbox disconnected');
            queryClient.invalidateQueries({ queryKey: ['email-settings'] });
        },
        onError: () => toast.error('Failed to disconnect'),
    });

    const syncMutation = useMutation({
        mutationFn: triggerManualSync,
        onSuccess: () => {
            toast.success('Sync started');
            setTimeout(() => queryClient.invalidateQueries({ queryKey: ['email-settings'] }), 3000);
        },
        onError: () => toast.error('Failed to trigger sync'),
    });

    if (isLoading) {
        return (
            <div className="p-6 max-w-2xl mx-auto">
                <h2 className="text-2xl font-semibold" style={{ fontFamily: 'var(--blanc-font-heading)' }}>Email</h2>
                <div className="mt-6 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>Loading...</div>
            </div>
        );
    }

    const status = mailbox ? STATUS_CONFIG[mailbox.status] || STATUS_CONFIG.disconnected : null;

    return (
        <div className="p-6 max-w-2xl mx-auto">
            <h2 className="text-2xl font-semibold" style={{ fontFamily: 'var(--blanc-font-heading)' }}>Email</h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                Connect one shared Gmail mailbox per company for the email workspace.
            </p>

            <div className="mt-6" style={{ background: 'rgba(117, 106, 89, 0.04)', borderRadius: '16px', padding: '20px' }}>
                {!mailbox ? (
                    /* ─── Not connected ─── */
                    <div className="flex flex-col items-center gap-4 py-6">
                        <Mail className="size-10" style={{ color: 'var(--blanc-ink-3)' }} />
                        <div className="text-center">
                            <p className="font-medium" style={{ color: 'var(--blanc-ink-1)' }}>Not connected</p>
                            <p className="text-sm mt-1" style={{ color: 'var(--blanc-ink-2)' }}>
                                Blanc supports one shared Gmail / Google Workspace mailbox per company.
                            </p>
                        </div>
                        <button
                            className="blanc-btn-primary flex items-center gap-2"
                            onClick={() => connectMutation.mutate()}
                            disabled={connectMutation.isPending}
                            style={{
                                background: 'var(--blanc-ink-1)', color: '#fff',
                                padding: '8px 20px', borderRadius: '10px', fontWeight: 500, fontSize: '14px',
                                border: 'none', cursor: 'pointer',
                            }}
                        >
                            <ExternalLink className="size-4" />
                            {connectMutation.isPending ? 'Redirecting...' : 'Connect Gmail'}
                        </button>
                    </div>
                ) : (
                    /* ─── Connected mailbox ─── */
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <Mail className="size-5" style={{ color: 'var(--blanc-ink-2)' }} />
                                <div>
                                    <p className="font-medium" style={{ color: 'var(--blanc-ink-1)' }}>{mailbox.email_address}</p>
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                        {status?.icon}
                                        <span className={`text-xs font-medium ${status?.color}`}>{status?.label}</span>
                                        <span className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}> Gmail</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                            <span>Last sync: {formatSyncTime(mailbox.last_synced_at)}</span>
                            {mailbox.last_sync_error && (
                                <span className="text-amber-600"> {mailbox.last_sync_error}</span>
                            )}
                        </div>

                        <div className="flex items-center gap-2 pt-2">
                            {mailbox.status === 'reconnect_required' || mailbox.status === 'disconnected' ? (
                                <button
                                    className="flex items-center gap-1.5 text-sm font-medium"
                                    onClick={() => connectMutation.mutate()}
                                    disabled={connectMutation.isPending}
                                    style={{
                                        background: 'var(--blanc-ink-1)', color: '#fff',
                                        padding: '6px 14px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                                    }}
                                >
                                    <ExternalLink className="size-3.5" />
                                    {connectMutation.isPending ? 'Redirecting...' : 'Reconnect Gmail'}
                                </button>
                            ) : (
                                <button
                                    className="flex items-center gap-1.5 text-sm"
                                    onClick={() => syncMutation.mutate()}
                                    disabled={syncMutation.isPending}
                                    style={{
                                        background: 'transparent', color: 'var(--blanc-ink-2)',
                                        padding: '6px 14px', borderRadius: '8px',
                                        border: '1px solid var(--blanc-line)', cursor: 'pointer',
                                    }}
                                >
                                    <RefreshCw className={`size-3.5 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
                                    {syncMutation.isPending ? 'Syncing...' : 'Sync now'}
                                </button>
                            )}

                            {mailbox.status !== 'disconnected' && (
                                <button
                                    className="flex items-center gap-1.5 text-sm text-red-500"
                                    onClick={() => {
                                        if (confirm('Disconnect this mailbox? Synced email history will be preserved.')) {
                                            disconnectMutation.mutate();
                                        }
                                    }}
                                    disabled={disconnectMutation.isPending}
                                    style={{
                                        background: 'transparent', padding: '6px 14px',
                                        borderRadius: '8px', border: '1px solid var(--blanc-line)', cursor: 'pointer',
                                    }}
                                >
                                    <Unplug className="size-3.5" />
                                    Disconnect
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
