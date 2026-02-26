import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { authedFetch } from '../services/apiClient';
import { Separator } from '../components/ui/separator';
import { AlertTriangle, MessageSquare, PhoneOff, Voicemail } from 'lucide-react';

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
            <div className="shrink-0 mt-0.5 text-gray-500">{icon}</div>
            <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                    <div>
                        <div className="font-medium text-sm">{label}</div>
                        <div className="text-xs text-gray-500 mt-0.5">{description}</div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                        <input
                            type="checkbox"
                            className="sr-only peer"
                            checked={trigger.enabled}
                            onChange={(e) => onChange({ ...trigger, enabled: e.target.checked })}
                        />
                        <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-orange-500" />
                    </label>
                </div>
                {trigger.enabled && (
                    <div className="mt-3 flex items-center gap-4 text-xs">
                        <label className="flex items-center gap-1.5">
                            <input
                                type="checkbox"
                                className="rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                                checked={trigger.create_task}
                                onChange={(e) => onChange({ ...trigger, create_task: e.target.checked })}
                            />
                            <span className="text-gray-700">Create Task</span>
                        </label>
                        {trigger.create_task && (
                            <>
                                <label className="flex items-center gap-1.5">
                                    <span className="text-gray-500">Priority</span>
                                    <select
                                        className="text-xs border rounded px-1.5 py-0.5 bg-white"
                                        value={trigger.task_priority}
                                        onChange={(e) => onChange({ ...trigger, task_priority: e.target.value })}
                                    >
                                        <option value="p1">P1 — Urgent</option>
                                        <option value="p2">P2 — Normal</option>
                                        <option value="p3">P3 — Low</option>
                                    </select>
                                </label>
                                <label className="flex items-center gap-1.5">
                                    <span className="text-gray-500">SLA</span>
                                    <select
                                        className="text-xs border rounded px-1.5 py-0.5 bg-white"
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
            <div className="max-w-2xl mx-auto p-6">
                <div className="animate-pulse space-y-4">
                    <div className="h-8 bg-gray-200 rounded w-64" />
                    <div className="h-40 bg-gray-100 rounded" />
                </div>
            </div>
        );
    }

    if (error || !config) {
        return (
            <div className="max-w-2xl mx-auto p-6">
                <p className="text-red-500">Failed to load settings</p>
            </div>
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
        <div className="max-w-2xl mx-auto p-6">
            <div className="flex items-center gap-3 mb-1">
                <AlertTriangle className="size-6 text-orange-500" />
                <h1 className="text-2xl font-semibold">Action Required</h1>
            </div>
            <p className="text-sm text-gray-500 mb-6">
                Configure when threads are automatically flagged as "Action Required" and tasks are created.
            </p>

            <Separator className="mb-2" />

            <h2 className="text-sm font-semibold text-gray-700 mb-1">Automation Triggers</h2>
            <p className="text-xs text-gray-500 mb-2">
                When enabled, threads matching these events will be automatically flagged.
            </p>

            <TriggerRow
                icon={<MessageSquare className="size-5" />}
                label="Inbound SMS"
                description="Flag when a customer sends an SMS message"
                trigger={config.triggers.inbound_sms}
                onChange={(t) => handleTriggerChange('inbound_sms', t)}
            />
            <Separator />
            <TriggerRow
                icon={<PhoneOff className="size-5" />}
                label="Missed Call"
                description="Flag when an inbound call is missed or unanswered"
                trigger={config.triggers.missed_call}
                onChange={(t) => handleTriggerChange('missed_call', t)}
            />
            <Separator />
            <TriggerRow
                icon={<Voicemail className="size-5" />}
                label="Voicemail"
                description="Flag when a caller leaves a voicemail"
                trigger={config.triggers.voicemail}
                onChange={(t) => handleTriggerChange('voicemail', t)}
            />

            {saveMutation.isPending && (
                <p className="text-xs text-gray-400 mt-4">Saving…</p>
            )}
        </div>
    );
}
