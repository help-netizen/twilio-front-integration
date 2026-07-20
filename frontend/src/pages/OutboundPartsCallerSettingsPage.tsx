import { useCallback, useEffect, useState } from 'react';
import { Loader2, PackageCheck, PhoneOutgoing } from 'lucide-react';
import { toast } from 'sonner';
import {
    AgentCallWindowFields,
    type AgentCallWindowMode,
} from '../components/settings/AgentCallWindowFields';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { SettingsSection } from '../components/settings/SettingsSection';
import { Button } from '../components/ui/button';
import { CloudBanner } from '../components/ui/CloudBanner';
import {
    fetchMarketplaceApps,
    fetchOutboundPartsCallerSettings,
    installMarketplaceApp,
    saveOutboundPartsCallerSettings,
} from '../services/marketplaceApi';

const APP_KEY = 'outbound-parts-caller';

export default function OutboundPartsCallerSettingsPage() {
    const [loading, setLoading] = useState(true);
    const [installed, setInstalled] = useState(false);
    const [installing, setInstalling] = useState(false);
    const [saving, setSaving] = useState(false);
    const [windowMode, setWindowMode] = useState<AgentCallWindowMode>('company');
    const [customStart, setCustomStart] = useState('09:00');
    const [customEnd, setCustomEnd] = useState('17:00');
    const [workDays, setWorkDays] = useState<number[]>([1, 2, 3, 4, 5]);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const apps = await fetchMarketplaceApps();
            const app = apps.find(candidate => candidate.app_key === APP_KEY);
            const connected = app?.installation?.status === 'connected';
            setInstalled(connected);
            if (connected) {
                const response = await fetchOutboundPartsCallerSettings();
                const settings = response.settings;
                setWindowMode(settings.calling_window_mode === 'custom' ? 'custom' : 'company');
                setCustomStart(settings.custom_start_time || '09:00');
                setCustomEnd(settings.custom_end_time || '17:00');
                setWorkDays(settings.calling_window_work_days || [1, 2, 3, 4, 5]);
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to load settings');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const handleInstall = async () => {
        setInstalling(true);
        try {
            await installMarketplaceApp(APP_KEY);
            toast.success('Outbound Parts Caller enabled');
            await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to enable the app');
        } finally {
            setInstalling(false);
        }
    };

    const handleSave = async () => {
        if (windowMode === 'custom' && (!(customStart < customEnd) || workDays.length === 0)) {
            toast.error(workDays.length === 0
                ? 'Choose at least one calling day'
                : 'Custom start time must be earlier than end time');
            return;
        }
        setSaving(true);
        try {
            const response = await saveOutboundPartsCallerSettings({
                calling_window_mode: windowMode === 'custom' ? 'custom' : null,
                custom_start_time: windowMode === 'custom' ? customStart : null,
                custom_end_time: windowMode === 'custom' ? customEnd : null,
                calling_window_work_days: windowMode === 'custom' ? workDays : null,
            });
            const settings = response.settings;
            setWindowMode(settings.calling_window_mode === 'custom' ? 'custom' : 'company');
            setCustomStart(settings.custom_start_time || '09:00');
            setCustomEnd(settings.custom_end_time || '17:00');
            setWorkDays(settings.calling_window_work_days || [1, 2, 3, 4, 5]);
            toast.success('Settings saved');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to save settings');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <SettingsPageShell backTo="/settings/apps-integrations" backLabel="Apps & integrations" title="Outbound parts caller">
                <div className="flex items-center gap-2 text-sm text-[var(--blanc-ink-3)]">
                    <Loader2 className="size-4 animate-spin" /> Loading…
                </div>
            </SettingsPageShell>
        );
    }

    return (
        <SettingsPageShell
            backTo="/settings/apps-integrations"
            backLabel="Apps & integrations"
            title="Outbound parts caller"
            description="Sara calls customers when their part arrives and schedules the finish visit."
            actions={installed ? (
                <Button onClick={handleSave} disabled={saving}>
                    {saving ? <Loader2 className="size-4 animate-spin" /> : null} Save
                </Button>
            ) : undefined}
        >
            {!installed ? (
                <CloudBanner variant="hero">
                    <p className="blanc-eyebrow">VOICE AI</p>
                    <h3 className="mt-2 text-2xl font-semibold text-[var(--blanc-ink-1)]">
                        Schedule finish visits when parts arrive
                    </h3>
                    <p className="mt-2 text-sm text-[var(--blanc-ink-2)]">
                        Sara calls the customer, offers available return-visit windows, and schedules their choice.
                    </p>
                    <div className="mt-4 space-y-2.5">
                        <div className="flex items-start gap-2.5">
                            <PackageCheck className="mt-0.5 size-4 shrink-0 text-[var(--blanc-accent)]" />
                            <p className="text-sm text-[var(--blanc-ink-2)]">Starts from the existing Part arrived workflow.</p>
                        </div>
                        <div className="flex items-start gap-2.5">
                            <PhoneOutgoing className="mt-0.5 size-4 shrink-0 text-[var(--blanc-accent)]" />
                            <p className="text-sm text-[var(--blanc-ink-2)]">Retries keep their existing cadence and wait for allowed calling hours.</p>
                        </div>
                    </div>
                    <Button className="mt-5 h-11 px-6" onClick={handleInstall} disabled={installing}>
                        {installing ? <Loader2 className="size-4 animate-spin" /> : <PhoneOutgoing className="size-4" />}
                        Enable Outbound Parts Caller
                    </Button>
                </CloudBanner>
            ) : (
                <SettingsSection
                    title="Calling hours"
                    description="Calls outside this schedule wait until the next allowed start without consuming an attempt."
                >
                    <AgentCallWindowFields
                        name="parts-caller-window"
                        mode={windowMode}
                        onModeChange={setWindowMode}
                        customStart={customStart}
                        onCustomStartChange={setCustomStart}
                        customEnd={customEnd}
                        onCustomEndChange={setCustomEnd}
                        workDays={workDays}
                        onWorkDaysChange={setWorkDays}
                    />
                </SettingsSection>
            )}
        </SettingsPageShell>
    );
}
