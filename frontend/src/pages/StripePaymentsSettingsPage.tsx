import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, AlertCircle, Loader2, Unplug, ExternalLink, RefreshCw } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../components/ui/dialog';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { SettingsSection } from '../components/settings/SettingsSection';
import { stripePaymentsApi, type StripePaymentsStatus, type StripeReadiness } from '../services/stripePaymentsApi';

const STATUS_NEUTRAL = 'bg-[rgba(117,106,89,0.06)] text-[var(--blanc-ink-3)]';
const STATUS_WARNING = 'bg-[rgba(178,106,29,0.12)] text-[var(--blanc-warning)]';
const STATUS_SUCCESS = 'bg-[rgba(27,139,99,0.12)] text-[var(--blanc-success)]';

const READINESS_LABEL: Record<StripeReadiness, { text: string; cls: string }> = {
    not_connected: { text: 'Available', cls: STATUS_NEUTRAL },
    onboarding_incomplete: { text: 'Setup incomplete', cls: STATUS_WARNING },
    action_required: { text: 'Action required', cls: STATUS_WARNING },
    payments_disabled: { text: 'Setup incomplete', cls: STATUS_WARNING },
    payouts_disabled: { text: 'Payouts disabled', cls: STATUS_WARNING },
    connected_ready: { text: 'Connected', cls: STATUS_SUCCESS },
    disconnected: { text: 'Disconnected', cls: STATUS_NEUTRAL },
};

function StatusBadge({ readiness }: { readiness: StripeReadiness }) {
    const r = READINESS_LABEL[readiness] || READINESS_LABEL.not_connected;
    return <Badge className={`${r.cls} hover:${r.cls}`}>{r.text}</Badge>;
}

function ReadinessRow({ ok, label, warn }: { ok: boolean; label: string; warn?: boolean }) {
    return (
        <div className="flex items-center gap-2 py-1.5" style={{ color: 'var(--blanc-ink-2)' }}>
            {ok ? <CheckCircle2 className="h-4 w-4 text-[var(--blanc-success)]" />
                : <AlertCircle className={`h-4 w-4 ${warn ? 'text-[var(--blanc-warning)]' : 'text-[var(--blanc-ink-3)]'}`} />}
            <span className="text-sm">{label}</span>
        </div>
    );
}

export default function StripePaymentsSettingsPage() {
    const qc = useQueryClient();
    const [disconnectOpen, setDisconnectOpen] = useState(false);

    const { data, isLoading } = useQuery({
        queryKey: ['stripe-payments-status'],
        queryFn: () => stripePaymentsApi.getStatus().then(r => r.status),
    });
    const status: StripePaymentsStatus | undefined = data;

    const connectMut = useMutation({
        mutationFn: () => stripePaymentsApi.connect(),
        onSuccess: ({ onboarding_url }) => { if (onboarding_url) window.location.href = onboarding_url; },
        onError: (e: Error) => toast.error(e.message),
    });
    const resumeMut = useMutation({
        mutationFn: () => stripePaymentsApi.getOnboardingLink(),
        onSuccess: ({ url }) => { if (url) window.location.href = url; },
        onError: (e: Error) => toast.error(e.message),
    });
    const refreshMut = useMutation({
        mutationFn: () => stripePaymentsApi.refreshStatus(),
        onSuccess: ({ status }) => { qc.setQueryData(['stripe-payments-status'], status); toast.success('Status refreshed'); },
        onError: (e: Error) => toast.error(e.message),
    });
    const disconnectMut = useMutation({
        mutationFn: () => stripePaymentsApi.disconnect(),
        onSuccess: () => { setDisconnectOpen(false); qc.invalidateQueries({ queryKey: ['stripe-payments-status'] }); toast.success('Stripe disconnected'); },
        onError: (e: Error) => toast.error(e.message),
    });

    const readiness = status?.readiness ?? 'not_connected';
    const connected = status?.connected;
    const acct = status?.account;

    return (
        <SettingsPageShell
            backTo="/settings/integrations"
            backLabel="Integrations"
            title="Stripe Payments"
            description="Accept customer payments by Stripe"
            actions={
                <>
                    {status?.livemode === false && connected && <Badge variant="outline">Test mode</Badge>}
                    <StatusBadge readiness={readiness} />
                </>
            }
        >
            {isLoading ? (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
            ) : status?.configured === false ? (
                <SettingsSection>
                    <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                        Stripe is not configured on this environment yet. Once the platform Stripe keys are set, you can connect your account here.
                    </p>
                </SettingsSection>
            ) : (
                <>
                    <SettingsSection title="Setup checklist">
                        {(status?.checklist ?? []).map(item => (
                            <div key={item.key} className="flex items-center justify-between py-1.5">
                                <ReadinessRow ok={item.done} label={item.label} />
                                {item.deferred && <span className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>Coming soon</span>}
                            </div>
                        ))}
                    </SettingsSection>

                    {connected && acct && (
                        <SettingsSection title="Account readiness">
                            <ReadinessRow ok={acct.details_submitted} label="Business details submitted" />
                            <ReadinessRow ok={acct.charges_enabled} label="Card payments enabled" warn={!acct.charges_enabled} />
                            <ReadinessRow ok={acct.payouts_enabled} label="Payouts enabled" warn={!acct.payouts_enabled} />
                            {acct.requirements_past_due.length > 0 && (
                                <p className="mt-2 text-sm text-[var(--blanc-warning)] flex items-start gap-2">
                                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                                    Stripe needs more information to keep payments active.
                                </p>
                            )}
                        </SettingsSection>
                    )}

                    {/* Actions */}
                    <div className="flex flex-wrap items-center gap-2.5">
                        {!connected && (
                            <Button onClick={() => connectMut.mutate()} disabled={connectMut.isPending}>
                                {connectMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Connect Stripe
                            </Button>
                        )}
                        {connected && readiness !== 'connected_ready' && (
                            <Button onClick={() => resumeMut.mutate()} disabled={resumeMut.isPending}>
                                {resumeMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Resume onboarding
                            </Button>
                        )}
                        {connected && (
                            <Button variant="outline" onClick={() => refreshMut.mutate()} disabled={refreshMut.isPending}>
                                <RefreshCw className={`h-4 w-4 mr-2 ${refreshMut.isPending ? 'animate-spin' : ''}`} /> Refresh status
                            </Button>
                        )}
                        {connected && (
                            <Button variant="outline" onClick={() => window.open('https://dashboard.stripe.com/', '_blank')}>
                                <ExternalLink className="h-4 w-4 mr-2" /> Open Stripe Dashboard
                            </Button>
                        )}
                        {connected && (
                            <Button variant="ghost" onClick={() => setDisconnectOpen(true)}>
                                <Unplug className="h-4 w-4 mr-2" /> Disconnect
                            </Button>
                        )}
                    </div>
                </>
            )}

            <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Disconnect Stripe Payments?</DialogTitle>
                        <DialogDescription>
                            New payment collection will be turned off. Your existing payment history stays intact and remains visible.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDisconnectOpen(false)}>Cancel</Button>
                        <Button variant="destructive" onClick={() => disconnectMut.mutate()} disabled={disconnectMut.isPending}>
                            {disconnectMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Disconnect
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </SettingsPageShell>
    );
}
