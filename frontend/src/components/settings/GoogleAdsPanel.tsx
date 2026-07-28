import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw, TriangleAlert, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { Button } from '../ui/button';
import {
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogPanelFooter,
    DialogPanelHeader,
    DialogTitle,
} from '../ui/dialog';
import {
    fetchGoogleAdsConnection,
    syncGoogleAds,
    disconnectGoogleAds,
    type GoogleAdsConnection,
} from '../../services/googleAdsApi';

interface GoogleAdsPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

const INK1 = 'var(--blanc-ink-1)';
const INK2 = 'var(--blanc-ink-2)';
const INK3 = 'var(--blanc-ink-3)';
const OK = 'var(--blanc-success)';
const WARN = 'var(--blanc-warning)';
const DANGER = 'var(--blanc-danger)';

function fmtDateTime(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const SYNC_TONE: Record<string, { label: string; color: string; bg: string }> = {
    ok: { label: 'Synced', color: OK, bg: 'rgba(27,139,99,0.12)' },
    running: { label: 'Syncing…', color: 'var(--blanc-info)', bg: 'rgba(47,99,216,0.12)' },
    pending: { label: 'Queued', color: WARN, bg: 'rgba(178,106,29,0.12)' },
    error: { label: 'Sync error', color: DANGER, bg: 'rgba(240,80,63,0.12)' },
};

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center justify-between gap-4" style={{ padding: '9px 0', borderTop: '1px solid var(--blanc-line)' }}>
            <span style={{ fontSize: 13, color: INK3 }}>{label}</span>
            <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: INK1, textAlign: 'right' }}>{value}</span>
        </div>
    );
}

function ConnectedView({ conn }: { conn: GoogleAdsConnection }) {
    const tone = SYNC_TONE[conn.last_sync_status ?? ''] ?? { label: conn.last_sync_status ?? '—', color: INK3, bg: 'var(--blanc-field)' };
    const range = conn.synced_from_date && conn.synced_through_date
        ? `${conn.synced_from_date} → ${conn.synced_through_date}`
        : 'not yet backfilled';
    return (
        <div className="space-y-6">
            {conn.status === 'reconnect_required' && (
                <div style={{ display: 'flex', gap: 8, fontSize: 13, color: INK2, background: 'rgba(240,80,63,0.08)', borderRadius: 12, padding: '10px 13px' }}>
                    <TriangleAlert size={16} style={{ color: DANGER, flexShrink: 0, marginTop: 1 }} />
                    <div>Google Ads rejected the stored credentials. Re-run the server bootstrap with a fresh refresh token to resume syncing.</div>
                </div>
            )}
            <section>
                <div className="blanc-eyebrow" style={{ marginBottom: 6 }}>Account</div>
                <Row label="Google Ads account" value={conn.customer_id_masked ? `•••• ${conn.customer_id_masked}` : '—'} />
                <Row label="Currency" value={conn.currency_code || '—'} />
                {conn.account_timezone && <Row label="Account time zone" value={conn.account_timezone} />}
            </section>
            <section>
                <div className="blanc-eyebrow" style={{ marginBottom: 6 }}>Spend sync</div>
                <div className="flex items-center justify-between gap-4" style={{ padding: '9px 0', borderTop: '1px solid var(--blanc-line)' }}>
                    <span style={{ fontSize: 13, color: INK3 }}>Status</span>
                    <span style={{ fontSize: 11.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999, background: tone.bg, color: tone.color }}>{tone.label}</span>
                </div>
                <Row label="Last synced" value={fmtDateTime(conn.last_synced_at)} />
                <Row label="Coverage" value={range} />
                {conn.last_error_code && <Row label="Last error" value={conn.last_error_code} />}
            </section>
            <div style={{ fontSize: 12.5, color: INK2, background: 'var(--blanc-accent-soft)', borderRadius: 12, padding: '10px 13px' }}>
                Spend refreshes automatically every day. See it in{' '}
                <Link to="/settings/analytics" style={{ color: 'var(--blanc-accent)', fontWeight: 600 }}>
                    Analytics <ArrowRight size={12} style={{ display: 'inline', verticalAlign: 'middle' }} />
                </Link>
                {' '}— ROAS by channel, area, and technician.
            </div>
        </div>
    );
}

function SetupView({ status }: { status?: string }) {
    return (
        <div className="space-y-5">
            <p style={{ fontSize: 14, color: INK2 }}>
                Google Ads spend is connected through your server credentials, then pulled automatically — no ad-account
                password is ever entered here.
            </p>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, color: INK2, lineHeight: 1.7 }}>
                <li>Add your Google Ads API credentials as server environment variables (<span className="mono">GOOGLE_ADS_CLIENT_ID</span>, <span className="mono">…_CLIENT_SECRET</span>, <span className="mono">…_DEVELOPER_TOKEN</span>, and the token encryption key).</li>
                <li>Run the one-time bootstrap with your account's customer id and refresh token.</li>
                <li>Spend backfills automatically and then refreshes daily.</li>
            </ol>
            {status === 'reconnect_required' && (
                <div style={{ display: 'flex', gap: 8, fontSize: 13, color: INK2, background: 'rgba(240,80,63,0.08)', borderRadius: 12, padding: '10px 13px' }}>
                    <TriangleAlert size={16} style={{ color: DANGER, flexShrink: 0, marginTop: 1 }} />
                    <div>The previous credentials were revoked. Re-run the bootstrap with a fresh refresh token.</div>
                </div>
            )}
            <div style={{ fontSize: 12.5, color: INK3 }}>
                Until then, Analytics shows the funnel and revenue for every channel — only the ad-spend and ROAS columns wait on this connection.
            </div>
        </div>
    );
}

export function GoogleAdsPanel({ open, onOpenChange }: GoogleAdsPanelProps) {
    const queryClient = useQueryClient();
    const [confirmDisconnect, setConfirmDisconnect] = useState(false);

    const connQuery = useQuery({
        queryKey: ['google-ads-connection'],
        queryFn: fetchGoogleAdsConnection,
        enabled: open,
    });
    const conn = connQuery.data;

    const syncMut = useMutation({
        mutationFn: syncGoogleAds,
        onSuccess: () => {
            toast.success('Sync queued — spend refreshes shortly.');
            queryClient.invalidateQueries({ queryKey: ['google-ads-connection'] });
        },
        onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not start sync.'),
    });
    const disconnectMut = useMutation({
        mutationFn: disconnectGoogleAds,
        onSuccess: () => {
            toast.success('Google Ads disconnected. Past spend is kept.');
            setConfirmDisconnect(false);
            queryClient.invalidateQueries({ queryKey: ['google-ads-connection'] });
        },
        onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not disconnect.'),
    });

    return (
        <Dialog open={open} onOpenChange={o => { onOpenChange(o); if (!o) setConfirmDisconnect(false); }}>
            <DialogContent variant="panel">
                <DialogPanelHeader className="md:px-8 md:pt-7">
                    <div className="blanc-eyebrow">Marketing analytics</div>
                    <DialogTitle
                        className="text-2xl font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: INK1 }}
                    >
                        Google Ads
                    </DialogTitle>
                    <DialogDescription>
                        Pulls daily campaign spend into Analytics so every channel, area, and technician shows a real ROAS.
                    </DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px]">
                        {connQuery.isLoading ? (
                            <div className="flex items-center gap-2 text-sm" style={{ color: INK3 }}>
                                <Loader2 className="h-4 w-4 animate-spin" /> Loading connection…
                            </div>
                        ) : connQuery.isError ? (
                            <div className="space-y-3">
                                <p className="text-sm" style={{ color: DANGER }}>The Google Ads connection could not be loaded.</p>
                                <Button variant="outline" onClick={() => connQuery.refetch()}>Try again</Button>
                            </div>
                        ) : conn?.connected ? (
                            <ConnectedView conn={conn} />
                        ) : (
                            <SetupView status={conn?.status} />
                        )}
                    </div>
                </DialogBody>

                <DialogPanelFooter className="md:px-8">
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
                    {conn?.connected && (
                        confirmDisconnect ? (
                            <div className="flex gap-2">
                                <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>Cancel</Button>
                                <Button
                                    variant="outline"
                                    style={{ color: DANGER, borderColor: 'var(--blanc-line-strong)' }}
                                    disabled={disconnectMut.isPending}
                                    onClick={() => disconnectMut.mutate()}
                                >
                                    {disconnectMut.isPending ? 'Disconnecting…' : 'Confirm disconnect'}
                                </Button>
                            </div>
                        ) : (
                            <div className="flex gap-2">
                                <Button variant="outline" onClick={() => setConfirmDisconnect(true)}>Disconnect</Button>
                                <Button disabled={syncMut.isPending} onClick={() => syncMut.mutate()}>
                                    <RefreshCw className={`size-3.5${syncMut.isPending ? ' animate-spin' : ''}`} />
                                    {syncMut.isPending ? 'Syncing…' : 'Sync now'}
                                </Button>
                            </div>
                        )
                    )}
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}
