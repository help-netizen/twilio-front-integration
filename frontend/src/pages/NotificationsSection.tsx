import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { authedFetch } from '../services/apiClient';
import { useAuth } from '../auth/AuthProvider';
import {
    getPermissionState,
    subscribeToPush,
    hasActiveSubscription,
    sendTestNotification,
    type PermissionState,
} from '../services/pushNotificationService';
import { Separator } from '../components/ui/separator';
import { Bell, BellOff, CheckCircle, AlertCircle, XCircle, Send, RefreshCw, Shield } from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface NotificationConfig {
    browser_push_new_text_message_enabled: boolean;
    browser_push_new_lead_enabled: boolean;
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function fetchNotificationConfig(): Promise<NotificationConfig> {
    const res = await authedFetch('/api/settings/notifications');
    const data = await res.json();
    return data.config;
}

async function saveNotificationConfig(config: NotificationConfig): Promise<NotificationConfig> {
    const res = await authedFetch('/api/settings/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to save');
    return data.config;
}

// ─── Status Badge ────────────────────────────────────────────────────────────

function StatusBadge({ state, hasSub }: { state: PermissionState; hasSub: boolean }) {
    if (state === 'unsupported') {
        return (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                <XCircle className="size-3.5" /> Not Supported
            </span>
        );
    }
    if (state === 'denied') {
        return (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-50 text-red-700">
                <AlertCircle className="size-3.5" /> Blocked in Browser
            </span>
        );
    }
    if (state === 'granted' && hasSub) {
        return (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700">
                <CheckCircle className="size-3.5" /> Enabled
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700">
            <BellOff className="size-3.5" /> Not Enabled
        </span>
    );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function NotificationsSection() {
    const { hasRole } = useAuth();
    const isAdmin = hasRole('company_admin', 'super_admin');
    const queryClient = useQueryClient();

    // Browser state
    const [permState, setPermState] = useState<PermissionState>('default');
    const [hasSub, setHasSub] = useState(false);
    const [refreshing, setRefreshing] = useState(false);

    const refreshBrowserState = async () => {
        setRefreshing(true);
        setPermState(getPermissionState());
        const sub = await hasActiveSubscription();
        setHasSub(sub);
        setRefreshing(false);
    };

    useEffect(() => { refreshBrowserState(); }, []);

    // Company config
    const { data: config, isLoading } = useQuery<NotificationConfig>({
        queryKey: ['notification-settings'],
        queryFn: fetchNotificationConfig,
    });

    const saveMutation = useMutation({
        mutationFn: saveNotificationConfig,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['notification-settings'] });
            toast.success('Notification settings saved');
        },
        onError: () => toast.error('Failed to save notification settings'),
    });

    // Handlers
    const handleEnable = async () => {
        const ok = await subscribeToPush();
        if (ok) {
            toast.success('Browser notifications enabled!');
            await refreshBrowserState();
        } else {
            toast.error('Could not enable notifications. Check browser permissions.');
            await refreshBrowserState();
        }
    };

    const handleTest = async () => {
        try {
            const result = await sendTestNotification();
            if (result.sent > 0) toast.success('Test notification sent!');
            else toast.error('No active subscriptions to send to');
        } catch {
            toast.error('Test notification failed');
        }
    };

    const handleToggle = (key: keyof NotificationConfig) => {
        if (!config || !isAdmin) return;
        saveMutation.mutate({ ...config, [key]: !config[key] });
    };

    if (isLoading) {
        return (
            <div className="animate-pulse space-y-4">
                <div className="h-6 bg-gray-200 rounded w-48" />
                <div className="h-32 bg-gray-100 rounded" />
            </div>
        );
    }

    return (
        <div className="space-y-5">
            {/* ── Card 1: Browser Push Status ─────────────────────────────── */}
            <div className="border rounded-lg p-4 bg-white">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <Bell className="size-5 text-orange-500" />
                        <h3 className="font-medium text-sm">Browser Push Notifications</h3>
                    </div>
                    <StatusBadge state={permState} hasSub={hasSub} />
                </div>

                {/* Unsupported */}
                {permState === 'unsupported' && (
                    <p className="text-xs text-gray-500">
                        Your browser does not support push notifications. Try using Chrome, Edge, or Firefox.
                    </p>
                )}

                {/* Default — can enable */}
                {permState === 'default' && (
                    <div className="flex items-center gap-3">
                        <button
                            onClick={handleEnable}
                            className="px-3 py-1.5 bg-orange-500 text-white text-sm rounded-md hover:bg-orange-600 transition-colors"
                        >
                            Enable notifications
                        </button>
                        <span className="text-xs text-gray-500">Click to allow browser notifications</span>
                    </div>
                )}

                {/* Granted */}
                {permState === 'granted' && (
                    <div className="flex items-center gap-3 flex-wrap">
                        {!hasSub && (
                            <button
                                onClick={handleEnable}
                                className="px-3 py-1.5 bg-orange-500 text-white text-sm rounded-md hover:bg-orange-600 transition-colors"
                            >
                                Activate subscription
                            </button>
                        )}
                        {hasSub && (
                            <button
                                onClick={handleTest}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 border text-sm rounded-md hover:bg-gray-50 transition-colors"
                            >
                                <Send className="size-3.5" /> Send test notification
                            </button>
                        )}
                        <button
                            onClick={refreshBrowserState}
                            disabled={refreshing}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 border text-sm rounded-md hover:bg-gray-50 transition-colors disabled:opacity-50"
                        >
                            <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Refresh status
                        </button>
                    </div>
                )}

                {/* Denied / Blocked */}
                {permState === 'denied' && (
                    <div className="space-y-2">
                        <p className="text-xs text-gray-600">
                            Notifications are blocked in your browser settings. To re-enable:
                        </p>
                        <ol className="text-xs text-gray-500 list-decimal list-inside space-y-1">
                            <li>Click the lock/info icon in the address bar</li>
                            <li>Find "Notifications" and change to "Allow"</li>
                            <li>Refresh this page</li>
                        </ol>
                        <button
                            onClick={refreshBrowserState}
                            disabled={refreshing}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 border text-sm rounded-md hover:bg-gray-50 transition-colors mt-1 disabled:opacity-50"
                        >
                            <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Refresh status
                        </button>
                    </div>
                )}
            </div>

            {/* ── Card 2: Company Notification Types ──────────────────────── */}
            {config && (
                <div className="border rounded-lg p-4 bg-white">
                    <div className="flex items-center gap-2 mb-1">
                        <Shield className="size-5 text-gray-500" />
                        <h3 className="font-medium text-sm">Company Notification Types</h3>
                    </div>
                    {!isAdmin && (
                        <p className="text-xs text-gray-500 mb-3">
                            Notification types are managed by your company admin.
                        </p>
                    )}
                    {isAdmin && (
                        <p className="text-xs text-gray-500 mb-3">
                            These settings apply to all users in this company.
                        </p>
                    )}

                    {/* Toggle: New text message */}
                    <div className="flex items-center justify-between py-2.5">
                        <div>
                            <div className="font-medium text-sm">New text message</div>
                            <div className="text-xs text-gray-500">Push when a customer sends an SMS</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input
                                type="checkbox"
                                className="sr-only peer"
                                checked={config.browser_push_new_text_message_enabled}
                                onChange={() => handleToggle('browser_push_new_text_message_enabled')}
                                disabled={!isAdmin}
                            />
                            <div className={`w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-orange-500 ${!isAdmin ? 'opacity-60 cursor-not-allowed' : ''}`} />
                        </label>
                    </div>

                    <Separator />

                    {/* Toggle: New lead */}
                    <div className="flex items-center justify-between py-2.5">
                        <div>
                            <div className="font-medium text-sm">New lead</div>
                            <div className="text-xs text-gray-500">Push when a new lead is created</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input
                                type="checkbox"
                                className="sr-only peer"
                                checked={config.browser_push_new_lead_enabled}
                                onChange={() => handleToggle('browser_push_new_lead_enabled')}
                                disabled={!isAdmin}
                            />
                            <div className={`w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-orange-500 ${!isAdmin ? 'opacity-60 cursor-not-allowed' : ''}`} />
                        </label>
                    </div>

                    {saveMutation.isPending && (
                        <p className="text-xs text-gray-400 mt-2">Saving…</p>
                    )}
                </div>
            )}
        </div>
    );
}
