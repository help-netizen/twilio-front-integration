import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Mail, RefreshCw, Unplug, ExternalLink, CheckCircle2, AlertTriangle, XCircle, Send, Sparkles } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../components/ui/dialog';
import { CloudBanner } from '../components/ui/CloudBanner';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { SettingsSection } from '../components/settings/SettingsSection';
import { getMailboxSettings, startGoogleConnect, disconnectMailbox, triggerManualSync, type EmailMailbox } from '../services/emailApi';

/**
 * Google Email marketplace app setup surface (SEND-DOC-001, app_key `google-email`).
 * Connect / disconnect / status for the single shared Gmail mailbox. Replaces the
 * retired /settings/email page; reachable from the Integrations marketplace card and
 * the OAuth callback redirect (`/settings/integrations/google-email?connected=1`).
 */

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

export default function GoogleEmailSettingsPage() {
    const queryClient = useQueryClient();
    const [searchParams, setSearchParams] = useSearchParams();
    const [confirmDisconnect, setConfirmDisconnect] = useState(false);

    const { data: mailbox, isLoading } = useQuery<EmailMailbox | null>({
        queryKey: ['email-settings'],
        queryFn: getMailboxSettings,
    });

    // Handle OAuth callback redirect params (success + error flags from email-oauth.js)
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
        const emailError = searchParams.get('email_error');
        if (emailError) {
            toast.error(emailError === 'already_connected'
                ? 'That Google account is already connected to another company.'
                : 'Failed to connect Gmail. Please try again.');
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

    const status = mailbox ? STATUS_CONFIG[mailbox.status] || STATUS_CONFIG.disconnected : null;

    return (
        <SettingsPageShell
            backTo="/settings/apps-integrations"
            backLabel="Apps & integrations"
            title="Google Email"
            description="Connect one shared Gmail / Google Workspace mailbox per company to send estimates & invoices and sync mail."
        >
            {isLoading ? (
                <div className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>Loading...</div>
            ) : !mailbox ? (
                /* ─── Not connected ─── */
                <CloudBanner variant="hero">
                    <p className="blanc-eyebrow">EMAIL</p>
                    <h3
                        className="mt-2 text-2xl sm:text-[28px]"
                        style={{ fontFamily: 'var(--blanc-font-heading)', fontWeight: 800, color: 'var(--blanc-ink-1)' }}
                    >
                        Every customer email, one timeline
                    </h3>
                    <p className="mt-2 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                        Connect your shared Gmail or Google Workspace mailbox and keep every conversation close to the customer and the job.
                    </p>
                    <div className="mt-4 space-y-2.5">
                        <div className="flex items-start gap-2.5">
                            <Mail className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                            <p className="text-sm">
                                <span className="font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>See the full story</span>
                                <span style={{ color: 'var(--blanc-ink-2)' }}> — Customer emails land in their Pulse timeline</span>
                            </p>
                        </div>
                        <div className="flex items-start gap-2.5">
                            <Send className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                            <p className="text-sm">
                                <span className="font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>Send with confidence</span>
                                <span style={{ color: 'var(--blanc-ink-2)' }}> — Email estimates and invoices from the address customers know</span>
                            </p>
                        </div>
                        <div className="flex items-start gap-2.5">
                            <Sparkles className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                            <p className="text-sm">
                                <span className="font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>Put Mail Secretary to work</span>
                                <span style={{ color: 'var(--blanc-ink-2)' }}> — Give it the context to help with customer email</span>
                            </p>
                        </div>
                    </div>
                    <Button
                        className="mt-5 h-11 px-6"
                        onClick={() => connectMutation.mutate()}
                        disabled={connectMutation.isPending}
                    >
                        <ExternalLink className="size-4" />
                        {connectMutation.isPending ? 'Redirecting...' : 'Connect Gmail'}
                    </Button>
                    <p className="mt-2.5 text-[13px]" style={{ color: 'var(--blanc-ink-3)' }}>
                        Takes about a minute. You'll sign in with Google.
                    </p>
                </CloudBanner>
            ) : (
                /* ─── Connected mailbox ─── */
                <SettingsSection title="Your connected mailbox">
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
                            <span>Last synced {formatSyncTime(mailbox.last_synced_at)}</span>
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
                </SettingsSection>
            )}

            <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Disconnect mailbox?</DialogTitle>
                        <DialogDescription>
                            Your synced email history stays in Albusto, and you can reconnect this mailbox anytime.
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
        </SettingsPageShell>
    );
}
