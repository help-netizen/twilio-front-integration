import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { authedFetch } from '../services/apiClient';
import {
    getPermissionState,
    subscribeToPush,
    hasActiveSubscription,
    sendTestNotification,
    type PermissionState,
} from '../services/pushNotificationService';
import { BellOff, CheckCircle, AlertCircle, XCircle, Send, RefreshCw, Lock } from 'lucide-react';
import { Switch } from '../components/ui/switch';
import { SettingsSection } from '../components/settings/SettingsSection';

/**
 * NOTIF-REWORK-001 — Alerts & notifications (per-user).
 *
 * Two flat groups: the device push state ("On this device") and the five
 * notification categories the user configures for themselves. There is no
 * per-role / per-channel matrix: a notification is delivered when the category
 * is on AND the user has access to the record it's about — access is the gate,
 * enforced server-side. Channel is device-level (browser push here; the mobile
 * app has its own master toggle).
 */

// ─── Types & API ─────────────────────────────────────────────────────────────

interface NotifCategory {
    key: string;
    label: string;
    description: string;
    enabled: boolean;
}
interface NotifSettings {
    categories: NotifCategory[];
    device: { browser_push: { supported: boolean; permission: string; subscribed: boolean } };
}

async function fetchNotifSettings(): Promise<NotifSettings> {
    const res = await authedFetch('/api/settings/notifications');
    const data = await res.json();
    return data.data;
}

async function patchCategory(vars: { key: string; enabled: boolean }): Promise<NotifCategory> {
    const res = await authedFetch(`/api/settings/notifications/${vars.key}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: vars.enabled }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to save');
    return data.data;
}

// ─── Browser-push status pill ─────────────────────────────────────────────────

function StatusBadge({ state, hasSub }: { state: PermissionState; hasSub: boolean }) {
    const base = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium';
    if (state === 'unsupported') {
        return <span className={base} style={{ background: 'var(--blanc-surface-muted)', color: 'var(--blanc-ink-3)' }}><XCircle className="size-3.5" /> Not supported</span>;
    }
    if (state === 'denied') {
        return <span className={base} style={{ background: 'rgba(240,80,63,.12)', color: 'var(--blanc-danger)' }}><AlertCircle className="size-3.5" /> Blocked in browser</span>;
    }
    if (state === 'granted' && hasSub) {
        return <span className={base} style={{ background: 'rgba(27,139,99,.12)', color: 'var(--blanc-success, #1b8b63)' }}><CheckCircle className="size-3.5" /> Enabled</span>;
    }
    return <span className={base} style={{ background: 'var(--blanc-accent-soft)', color: '#5b21b6' }}><BellOff className="size-3.5" /> Not enabled</span>;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function NotificationsSection() {
    const queryClient = useQueryClient();

    // Browser push (client-local truth; the API cannot read Notification.permission)
    const [permState, setPermState] = useState<PermissionState>('default');
    const [hasSub, setHasSub] = useState(false);
    const [refreshing, setRefreshing] = useState(false);

    const refreshBrowserState = async () => {
        setRefreshing(true);
        setPermState(getPermissionState());
        setHasSub(await hasActiveSubscription());
        setRefreshing(false);
    };
    useEffect(() => { refreshBrowserState(); }, []);

    const { data, isLoading } = useQuery<NotifSettings>({
        queryKey: ['notification-settings'],
        queryFn: fetchNotifSettings,
    });

    const toggle = useMutation({
        mutationFn: patchCategory,
        onMutate: async (vars) => {
            await queryClient.cancelQueries({ queryKey: ['notification-settings'] });
            const prev = queryClient.getQueryData<NotifSettings>(['notification-settings']);
            if (prev) {
                queryClient.setQueryData<NotifSettings>(['notification-settings'], {
                    ...prev,
                    categories: prev.categories.map((c) => (c.key === vars.key ? { ...c, enabled: vars.enabled } : c)),
                });
            }
            return { prev };
        },
        onError: (_e, _vars, ctx) => {
            if (ctx?.prev) queryClient.setQueryData(['notification-settings'], ctx.prev);
            toast.error('Could not save that change');
        },
        onSettled: () => queryClient.invalidateQueries({ queryKey: ['notification-settings'] }),
    });

    const handleEnablePush = async () => {
        const ok = await subscribeToPush();
        if (ok) toast.success('Browser notifications enabled');
        else if (getPermissionState() === 'denied') toast.error('Notifications are blocked in your browser settings');
        await refreshBrowserState();
    };
    const handleTest = async () => {
        try {
            const r = await sendTestNotification();
            if (r.sent > 0) toast.success('Test notification sent');
            else toast.error('No active subscriptions to send to');
        } catch { toast.error('Test notification failed'); }
    };

    return (
        <>
            {/* ── On this device ─────────────────────────────────────────────── */}
            <SettingsSection
                title="On this device"
                description="Push in this browser. In the mobile app, manage it from the app's settings."
                flat
            >
                <div className="flex flex-wrap items-center gap-3 pt-0.5">
                    <StatusBadge state={permState} hasSub={hasSub} />
                    {(permState === 'default' || (permState === 'granted' && !hasSub)) && (
                        <button
                            onClick={handleEnablePush}
                            className="rounded-[10px] px-3.5 py-2 text-sm font-semibold text-white"
                            style={{ background: 'var(--blanc-accent)' }}
                        >
                            Enable notifications
                        </button>
                    )}
                    {permState === 'granted' && hasSub && (
                        <button
                            onClick={handleTest}
                            className="inline-flex items-center gap-1.5 rounded-[10px] px-3.5 py-2 text-sm font-semibold"
                            style={{ border: '1px solid var(--blanc-line-strong)', color: 'var(--blanc-ink-1)', background: 'var(--blanc-surface-strong)' }}
                        >
                            <Send className="size-3.5" /> Send test
                        </button>
                    )}
                    <button
                        onClick={refreshBrowserState}
                        disabled={refreshing}
                        className="inline-flex items-center gap-1.5 rounded-[10px] px-3 py-2 text-sm font-medium disabled:opacity-50"
                        style={{ color: 'var(--blanc-ink-3)' }}
                    >
                        <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
                    </button>
                </div>
                {permState === 'denied' && (
                    <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--blanc-ink-3)' }}>
                        Notifications are blocked in your browser settings. Open the site permissions (lock icon in the address bar), allow Notifications, then refresh.
                    </p>
                )}
            </SettingsSection>

            {/* ── Notifications (categories) ─────────────────────────────────── */}
            <SettingsSection
                title="Notifications"
                description="The updates you want — your own settings. You only get one when you have access to what it's about (no Leads access → no lead alerts)."
                flat
            >
                {isLoading || !data ? (
                    <div className="animate-pulse space-y-3 pt-1">
                        {[0, 1, 2, 3, 4].map((i) => (
                            <div key={i} className="h-10 rounded" style={{ background: 'rgba(25,25,25,0.04)' }} />
                        ))}
                    </div>
                ) : (
                    <div>
                        {data.categories.map((cat, i) => (
                            <div
                                key={cat.key}
                                className="flex items-center gap-4 py-3.5"
                                style={i > 0 ? { borderTop: '1px solid var(--blanc-line)' } : undefined}
                            >
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>{cat.label}</div>
                                    <div className="mt-0.5 text-xs leading-snug" style={{ color: 'var(--blanc-ink-2)' }}>{cat.description}</div>
                                </div>
                                <Switch
                                    checked={cat.enabled}
                                    onCheckedChange={(enabled) => toggle.mutate({ key: cat.key, enabled })}
                                    aria-label={cat.label}
                                />
                            </div>
                        ))}
                        <p className="mt-3 flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--blanc-ink-3)' }}>
                            <Lock className="size-3" /> Delivered only where your notifications are turned on and to records you can access.
                        </p>
                    </div>
                )}
            </SettingsSection>
        </>
    );
}
