import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Mail, RefreshCw, Unplug, ExternalLink, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../components/ui/dialog';
import { getMailboxSettings, startGoogleConnect, disconnectMailbox, triggerManualSync, type EmailMailbox } from '../services/emailApi';

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
    connected: { label: 'Connected', color: 'var(--blanc-success)', icon: <CheckCircle2 className="size-4" style={{ color: 'var(--blanc-success)' }} /> },
    reconnect_required: { label: 'Reconnect required', color: 'var(--blanc-warning)', icon: <AlertTriangle className="size-4" style={{ color: 'var(--blanc-warning)' }} /> },
    sync_error: { label: 'Sync error', color: 'var(--blanc-warning)', icon: <AlertTriangle className="size-4" style={{ color: 'var(--blanc-warning)' }} /> },
    disconnected: { label: 'Disconnected', color: 'var(--blanc-ink-3)', icon: <XCircle className="size-4" style={{ color: 'var(--blanc-ink-3)' }} /> },
};

function formatSyncTime(iso: string | null): string {
    if (!iso) return 'Never';
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function EmailSettingsPage() {
    const queryClient = useQueryClient();
    const [searchParams, setSearchParams] = useSearchParams();
    const [confirmDisconnect, setConfirmDisconnect] = useState(false);

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
                <div className="blanc-eyebrow">Settings</div>
                <h1 className="text-2xl font-semibold mt-1" style={{ fontFamily: 'var(--blanc-font-heading)' }}>Email</h1>
                <div className="mt-6 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>Loading...</div>
            </div>
        );
    }

    const status = mailbox ? STATUS_CONFIG[mailbox.status] || STATUS_CONFIG.disconnected : null;

    return (
        <div className="p-6 max-w-2xl mx-auto">
            <div className="blanc-eyebrow">Settings</div>
            <h1 className="text-2xl font-semibold mt-1" style={{ fontFamily: 'var(--blanc-font-heading)' }}>Email</h1>
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
                                Albusto supports one shared Gmail / Google Workspace mailbox per company.
                            </p>
                        </div>
                        <Button
                            onClick={() => connectMutation.mutate()}
                            disabled={connectMutation.isPending}
                        >
                            <ExternalLink className="size-4" />
                            {connectMutation.isPending ? 'Redirecting...' : 'Connect Gmail'}
                        </Button>
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
                                        <span className="text-xs font-medium" style={{ color: status?.color }}>{status?.label}</span>
                                        <span className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}> Gmail</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                            <span>Last sync: {formatSyncTime(mailbox.last_synced_at)}</span>
                            {mailbox.last_sync_error && (
                                <span style={{ color: 'var(--blanc-warning)' }}> {mailbox.last_sync_error}</span>
                            )}
                        </div>

                        <div className="flex items-center gap-2 pt-2">
                            {mailbox.status === 'reconnect_required' || mailbox.status === 'disconnected' ? (
                                <Button
                                    size="sm"
                                    onClick={() => connectMutation.mutate()}
                                    disabled={connectMutation.isPending}
                                >
                                    <ExternalLink className="size-3.5" />
                                    {connectMutation.isPending ? 'Redirecting...' : 'Reconnect Gmail'}
                                </Button>
                            ) : (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => syncMutation.mutate()}
                                    disabled={syncMutation.isPending}
                                >
                                    <RefreshCw className={`size-3.5 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
                                    {syncMutation.isPending ? 'Syncing...' : 'Sync now'}
                                </Button>
                            )}

                            {mailbox.status !== 'disconnected' && (
                                <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={() => setConfirmDisconnect(true)}
                                    disabled={disconnectMutation.isPending}
                                >
                                    <Unplug className="size-3.5" />
                                    Disconnect
                                </Button>
                            )}
                        </div>
                    </div>
                )}
            </div>

            <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Disconnect mailbox?</DialogTitle>
                        <DialogDescription>
                            Synced email history will be preserved. You can reconnect later.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>Cancel</Button>
                        <Button
                            variant="destructive"
                            onClick={() => { setConfirmDisconnect(false); disconnectMutation.mutate(); }}
                        >
                            Disconnect
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
