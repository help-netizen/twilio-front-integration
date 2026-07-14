/**
 * OUTBOUND-LEAD-CALL-001 — Outbound Lead Caller settings (§11.2).
 * Mirrors MailSecretarySettingsPage: SettingsPageShell + SettingsSection +
 * sonner toasts + draft state with explicit Save. Sources multi-select is a
 * Checkbox list (design canon: toggles/checkboxes are NOT floated).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, PhoneOutgoing, CalendarCheck, ListChecks } from 'lucide-react';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { SettingsSection } from '../components/settings/SettingsSection';
import { CloudBanner } from '../components/ui/CloudBanner';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import {
    getOutboundLeadCallerOverview,
    saveOutboundLeadCallerSettings,
    type OutboundLeadCallerOverview,
} from '../services/outboundLeadCallerApi';
import { fetchMarketplaceApps, installMarketplaceApp, type MarketplaceApp } from '../services/marketplaceApi';
import { JOB_SOURCES } from '../components/leads/editLeadHelpers';

const APP_KEY = 'outbound-lead-caller';

// Same canonicalization as the backend (outboundLeadCallSettingsService).
const norm = (s: string) => s.trim().replace(/\s+/g, '').toLowerCase();

const STATUS_LABELS: Record<string, string> = {
    booked: 'Booked',
    no_answer: 'No answer',
    voicemail: 'Voicemail',
    declined: 'Declined',
    failed: 'Failed',
    canceled: 'Canceled',
    exhausted: 'Exhausted',
    pending: 'Queued',
    dialing: 'Dialing',
};

function StatChip({ label, value }: { label: string; value: number | string }) {
    return (
        <div className="rounded-xl px-4 py-3" style={{ background: 'var(--blanc-surface-muted)' }}>
            <div className="text-xl font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>{value}</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--blanc-ink-3)' }}>{label}</div>
        </div>
    );
}

export default function OutboundLeadCallerSettingsPage() {
    const [overview, setOverview] = useState<OutboundLeadCallerOverview | null>(null);
    const [loading, setLoading] = useState(true);
    const [installing, setInstalling] = useState(false);
    const [saving, setSaving] = useState(false);
    // Draft: normalized keys of enabled sources + display label per key.
    const [selected, setSelected] = useState<Set<string>>(new Set());

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await getOutboundLeadCallerOverview();
            setOverview(data);
            setSelected(new Set((data.settings.enabled_sources || []).map(norm)));
        } catch (e: any) {
            toast.error(e?.message || 'Failed to load settings');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    // Options = canonical JOB_SOURCES ∪ observed company sources, deduped by
    // normalization; canonical label wins when normalized-equal. Sara's own
    // 'AI Phone' label is never offered.
    const options = useMemo(() => {
        const byKey = new Map<string, string>();
        for (const s of JOB_SOURCES) byKey.set(norm(s), s);
        for (const s of overview?.company_sources || []) {
            const k = norm(s);
            if (!byKey.has(k)) byKey.set(k, s.trim());
        }
        byKey.delete('aiphone');
        return [...byKey.entries()].map(([key, label]) => ({ key, label }));
    }, [overview?.company_sources]);

    const handleInstall = async () => {
        setInstalling(true);
        try {
            const apps = await fetchMarketplaceApps();
            const app = apps.find((a: MarketplaceApp) => a.app_key === APP_KEY);
            if (!app) throw new Error('App is not published');
            await installMarketplaceApp(APP_KEY);
            toast.success('Outbound Lead Caller enabled');
            await load();
        } catch (e: any) {
            toast.error(e?.message || 'Failed to enable the app');
        } finally {
            setInstalling(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const labels = options.filter(o => selected.has(o.key)).map(o => o.label);
            const settings = await saveOutboundLeadCallerSettings(labels);
            setSelected(new Set((settings.enabled_sources || []).map(norm)));
            toast.success('Settings saved');
        } catch (e: any) {
            toast.error(e?.message || 'Failed to save settings');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <SettingsPageShell backTo="/settings/integrations" backLabel="Integrations" title="Outbound Lead Caller">
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                    <Loader2 className="size-4 animate-spin" /> Loading…
                </div>
            </SettingsPageShell>
        );
    }

    const installed = !!overview?.installed;
    const recent = (overview?.recent || []).filter(r => STATUS_LABELS[r.status]);

    return (
        <SettingsPageShell
            backTo="/settings/integrations"
            backLabel="Integrations"
            title="Outbound Lead Caller"
            description="Sara calls new leads from your chosen sources and books them into the schedule."
            actions={installed ? (
                <Button onClick={handleSave} disabled={saving}>
                    {saving ? <Loader2 className="size-4 animate-spin" /> : null} Save
                </Button>
            ) : undefined}
        >
            {!installed ? (
                <CloudBanner variant="hero">
                    <p className="blanc-eyebrow">VOICE AI</p>
                    <h3
                        className="mt-2 text-2xl sm:text-[28px]"
                        style={{ fontFamily: 'var(--blanc-font-heading)', fontWeight: 800, color: 'var(--blanc-ink-1)' }}
                    >
                        Call every new lead in under a minute
                    </h3>
                    <p className="mt-2 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                        Sara phones each new lead from the sources you pick, offers real appointment windows, and books the customer's choice.
                    </p>
                    <div className="mt-4 space-y-2.5">
                        <div className="flex items-start gap-2.5">
                            <PhoneOutgoing className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                            <p className="text-sm">
                                <span className="font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>Speed to lead</span>
                                <span style={{ color: 'var(--blanc-ink-2)' }}> — Calls go out immediately during business hours, first thing the next morning otherwise</span>
                            </p>
                        </div>
                        <div className="flex items-start gap-2.5">
                            <CalendarCheck className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                            <p className="text-sm">
                                <span className="font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>Books, not just greets</span>
                                <span style={{ color: 'var(--blanc-ink-2)' }}> — Offers windows ranked by your scheduling engine and holds the customer's pick on the lead</span>
                            </p>
                        </div>
                        <div className="flex items-start gap-2.5">
                            <ListChecks className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                            <p className="text-sm">
                                <span className="font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>Nothing slips</span>
                                <span style={{ color: 'var(--blanc-ink-2)' }}> — Unreached or declined leads become dispatcher tasks; every call lands in Pulse with recording and transcript</span>
                            </p>
                        </div>
                    </div>
                    <Button className="mt-5 h-11 px-6" onClick={handleInstall} disabled={installing}>
                        {installing ? <Loader2 className="size-4 animate-spin" /> : <PhoneOutgoing className="size-4" />}
                        Enable Outbound Lead Caller
                    </Button>
                    <p className="mt-2.5 text-[13px]" style={{ color: 'var(--blanc-ink-3)' }}>
                        Takes less than a minute. Pro Referral is preselected — adjust sources any time.
                    </p>
                </CloudBanner>
            ) : (
                <>
                    <SettingsSection
                        title="Lead sources"
                        description="Sara calls every NEW lead created with one of these sources. Existing leads are never called retroactively."
                    >
                        <div className="space-y-3">
                            {options.map(({ key, label }) => (
                                <div key={key}>
                                    <label className="flex items-center gap-2.5 cursor-pointer">
                                        <Checkbox
                                            checked={selected.has(key)}
                                            onCheckedChange={(checked) => {
                                                setSelected(prev => {
                                                    const next = new Set(prev);
                                                    if (checked) next.add(key); else next.delete(key);
                                                    return next;
                                                });
                                            }}
                                        />
                                        <span className="text-sm" style={{ color: 'var(--blanc-ink-1)' }}>{label}</span>
                                    </label>
                                    {key === 'yelp' && (
                                        <p className="text-xs mt-1 ml-7" style={{ color: 'var(--blanc-ink-3)' }}>
                                            Yelp leads are already handled by the email booking agent — enabling calls runs both.
                                        </p>
                                    )}
                                </div>
                            ))}
                        </div>
                    </SettingsSection>

                    <SettingsSection title="How it works">
                        <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                            Sara calls each new lead from an enabled source within about a minute — during your business
                            hours (from Dispatch settings). Out-of-hours leads are called at the next business-day start.
                            Unanswered calls retry up to 3 times (immediately, +30 minutes, +2 hours). If the customer
                            books, the appointment hold appears on the lead; if not, a dispatcher task is created.
                            Every call shows up in Pulse with recording and transcript.
                        </p>
                    </SettingsSection>

                    {recent.length > 0 && (
                        <SettingsSection title="Last 30 days">
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                {recent.map(r => (
                                    <StatChip key={r.status} label={STATUS_LABELS[r.status]} value={r.count} />
                                ))}
                            </div>
                        </SettingsSection>
                    )}
                </>
            )}
        </SettingsPageShell>
    );
}
