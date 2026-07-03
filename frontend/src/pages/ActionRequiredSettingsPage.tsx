import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { authedFetch } from '../services/apiClient';
import { MessageSquare, PhoneOff, Voicemail } from 'lucide-react';
import { Switch } from '../components/ui/switch';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { SettingsSection } from '../components/settings/SettingsSection';
import NotificationsSection from './NotificationsSection';

// Types
interface TriggerConfig {
    enabled: boolean;
    create_task: boolean;
    task_priority: string;
    task_sla_minutes: number;
}

interface ARConfig {
    enabled: boolean;
    triggers: {
        inbound_sms: TriggerConfig;
        missed_call: TriggerConfig;
        voicemail: TriggerConfig;
    };
}

// API
async function fetchConfig(): Promise<ARConfig> {
    const res = await authedFetch('/api/settings/action-required');
    const data = await res.json();
    return data.config;
}

async function saveConfig(config: ARConfig): Promise<ARConfig> {
    const res = await authedFetch('/api/settings/action-required', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
    });
    const data = await res.json();
    return data.config;
}

// Trigger row component
function TriggerRow({
    icon,
    label,
    description,
    trigger,
    onChange,
}: {
    icon: React.ReactNode;
    label: string;
    description: string;
    trigger: TriggerConfig;
    onChange: (updated: TriggerConfig) => void;
}) {
    return (
        <div className="flex items-start gap-4 py-4">
            <div className="shrink-0 mt-0.5" style={{ color: 'var(--blanc-ink-3)' }}>{icon}</div>
            <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                    <div>
                        <div className="font-medium text-sm" style={{ color: 'var(--blanc-ink-1)' }}>{label}</div>
                        <div className="text-xs mt-0.5" style={{ color: 'var(--blanc-ink-3)' }}>{description}</div>
                    </div>
                    <Switch
                        checked={trigger.enabled}
                        onCheckedChange={(checked) => onChange({ ...trigger, enabled: checked })}
                    />
                </div>
                {trigger.enabled && (
                    <div className="mt-3 flex items-center gap-4 text-xs">
                        <label className="flex items-center gap-1.5">
                            <input
                                type="checkbox"
                                className="rounded"
                                style={{ accentColor: 'var(--blanc-job)' }}
                                checked={trigger.create_task}
                                onChange={(e) => onChange({ ...trigger, create_task: e.target.checked })}
                            />
                            <span style={{ color: 'var(--blanc-ink-2)' }}>Create Task</span>
                        </label>
                        {trigger.create_task && (
                            <>
                                <label className="flex items-center gap-1.5">
                                    <span style={{ color: 'var(--blanc-ink-3)' }}>Priority</span>
                                    <select
                                        className="text-xs rounded px-1.5 py-0.5"
                                        style={{ border: '1px solid var(--blanc-line)', background: 'rgba(117,106,89,0.04)', color: 'var(--blanc-ink-1)' }}
                                        value={trigger.task_priority}
                                        onChange={(e) => onChange({ ...trigger, task_priority: e.target.value })}
                                    >
                                        <option value="p1">P1 — Urgent</option>
                                        <option value="p2">P2 — Normal</option>
                                        <option value="p3">P3 — Low</option>
                                    </select>
                                </label>
                                <label className="flex items-center gap-1.5">
                                    <span style={{ color: 'var(--blanc-ink-3)' }}>SLA</span>
                                    <select
                                        className="text-xs rounded px-1.5 py-0.5"
                                        style={{ border: '1px solid var(--blanc-line)', background: 'rgba(117,106,89,0.04)', color: 'var(--blanc-ink-1)' }}
                                        value={String(trigger.task_sla_minutes)}
                                        onChange={(e) => onChange({ ...trigger, task_sla_minutes: parseInt(e.target.value) })}
                                    >
                                        <option value="5">5 min</option>
                                        <option value="10">10 min</option>
                                        <option value="15">15 min</option>
                                        <option value="30">30 min</option>
                                        <option value="60">1 hour</option>
                                        <option value="120">2 hours</option>
                                    </select>
                                </label>
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

// Main page
export default function ActionRequiredSettingsPage() {
    const queryClient = useQueryClient();

    const { data: config, isLoading, error } = useQuery<ARConfig>({
        queryKey: ['action-required-settings'],
        queryFn: fetchConfig,
    });

    const saveMutation = useMutation({
        mutationFn: saveConfig,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['action-required-settings'] });
            toast.success('Settings saved');
        },
        onError: () => {
            toast.error('Failed to save settings');
        },
    });

    if (isLoading) {
        return (
            <SettingsPageShell title="Actions & notifications" description="Flag threads that need attention, and manage browser push alerts.">
                <div className="animate-pulse space-y-4">
                    <div className="h-8 rounded w-64" style={{ background: 'rgba(117,106,89,0.08)' }} />
                    <div className="h-40 rounded" style={{ background: 'rgba(117,106,89,0.04)' }} />
                </div>
            </SettingsPageShell>
        );
    }

    if (error || !config) {
        return (
            <SettingsPageShell title="Actions & notifications" description="Flag threads that need attention, and manage browser push alerts.">
                <p style={{ color: 'var(--blanc-danger)' }}>Failed to load settings</p>
            </SettingsPageShell>
        );
    }

    const handleTriggerChange = (key: keyof ARConfig['triggers'], updated: TriggerConfig) => {
        saveMutation.mutate({
            ...config,
            triggers: {
                ...config.triggers,
                [key]: updated,
            },
        });
    };

    return (
        <SettingsPageShell title="Actions & notifications" description="Flag threads that need attention, and manage browser push alerts.">
            <SettingsSection
                title="Action triggers"
                description={'When enabled, matching events are flagged "Action Required" — optionally creating a task.'}
            >
                <TriggerRow
                    icon={<MessageSquare className="size-5" />}
                    label="Inbound SMS"
                    description="Flag when a customer sends an SMS message"
                    trigger={config.triggers.inbound_sms}
                    onChange={(t) => handleTriggerChange('inbound_sms', t)}
                />
                <TriggerRow
                    icon={<PhoneOff className="size-5" />}
                    label="Missed Call"
                    description="Flag when an inbound call is missed or unanswered"
                    trigger={config.triggers.missed_call}
                    onChange={(t) => handleTriggerChange('missed_call', t)}
                />
                <TriggerRow
                    icon={<Voicemail className="size-5" />}
                    label="Voicemail"
                    description="Flag when a caller leaves a voicemail"
                    trigger={config.triggers.voicemail}
                    onChange={(t) => handleTriggerChange('voicemail', t)}
                />

                {saveMutation.isPending && (
                    <p className="text-xs mt-2" style={{ color: 'var(--blanc-ink-3, #7d8796)' }}>Saving…</p>
                )}
            </SettingsSection>

            <NotificationsSection />
        </SettingsPageShell>
    );
}
