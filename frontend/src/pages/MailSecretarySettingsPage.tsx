/**
 * MAIL-AGENT-001 — Mail Secretary setup page (/settings/integrations/mail-secretary).
 *
 * AI triage of inbound email: status + enable, behaviour knobs, exclusion rules
 * with an inline tester, dry-run preview, and the recent-decisions feed.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Sparkles, Play, Mail, ListChecks, SlidersHorizontal } from 'lucide-react';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { SettingsSection } from '../components/settings/SettingsSection';
import { Button } from '../components/ui/button';
import { CloudBanner } from '../components/ui/CloudBanner';
import { Checkbox } from '../components/ui/checkbox';
import { FloatingSelect } from '../components/ui/floating-select';
import { FloatingField } from '../components/ui/floating-field';
import { SelectItem } from '../components/ui/select';
import { authedFetch } from '../services/apiClient';
import { fetchMarketplaceApps, installMarketplaceApp, type MarketplaceApp } from '../services/marketplaceApi';
import {
    getMailAgentOverview, saveMailAgentSettings, testMailAgentRules, runMailAgentDryRun, listMailAgentReviews,
    type MailAgentOverview, type MailAgentReview, type MailAgentDryRunRow, type MailAgentVerdict,
} from '../services/mailAgentApi';

const APP_KEY = 'mail-secretary';

const VERDICT_META: Record<MailAgentVerdict, { label: string; bg: string; color: string }> = {
    task_created: { label: 'Task created', bg: 'rgba(27,139,99,0.12)', color: 'var(--blanc-success)' },
    skipped_excluded: { label: 'Excluded by rule', bg: 'rgba(25,25,25,0.06)', color: 'var(--blanc-ink-2)' },
    skipped_no_attention: { label: 'No attention needed', bg: 'rgba(25,25,25,0.06)', color: 'var(--blanc-ink-2)' },
    skipped_low_confidence: { label: 'Low confidence', bg: 'rgba(178,106,29,0.12)', color: 'var(--blanc-warning)' },
    skipped_unknown_sender: { label: 'Unknown sender', bg: 'rgba(178,106,29,0.12)', color: 'var(--blanc-warning)' },
    error: { label: 'Error', bg: 'rgba(240,80,63,0.12)', color: 'var(--blanc-danger)' },
};

function VerdictChip({ verdict }: { verdict: MailAgentVerdict }) {
    const meta = VERDICT_META[verdict] || VERDICT_META.error;
    return (
        <span
            className="inline-flex items-center whitespace-nowrap"
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: meta.bg, color: meta.color }}
        >
            {meta.label}
        </span>
    );
}

function StatChip({ label, value }: { label: string; value: number | string }) {
    return (
        <div className="rounded-xl px-4 py-3" style={{ background: 'var(--blanc-panel-surface)', border: '1px solid var(--blanc-line)' }}>
            <div className="text-xl font-semibold" style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}>{value}</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--blanc-ink-2)' }}>{label}</div>
        </div>
    );
}

interface CompanyUser { id: string; name: string }

export default function MailSecretarySettingsPage() {
    const [overview, setOverview] = useState<MailAgentOverview | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [installing, setInstalling] = useState(false);
    const [users, setUsers] = useState<CompanyUser[]>([]);

    // Draft settings (explicit Save, no auto-save — ADDR-UX-001 canon)
    const [enabled, setEnabled] = useState(true);
    const [threshold, setThreshold] = useState('0.6');
    const [createContact, setCreateContact] = useState(true);
    const [assignOwner, setAssignOwner] = useState('');
    const [rules, setRules] = useState('');
    const [rulesError, setRulesError] = useState<string | null>(null);

    // Rule tester
    const [testFrom, setTestFrom] = useState('');
    const [testSubject, setTestSubject] = useState('');
    const [testBody, setTestBody] = useState('');
    const [testResult, setTestResult] = useState<string | null>(null);

    // Activity
    const [reviews, setReviews] = useState<MailAgentReview[]>([]);
    const [dryRows, setDryRows] = useState<MailAgentDryRunRow[] | null>(null);
    const [dryRunning, setDryRunning] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await getMailAgentOverview();
            setOverview(data);
            setEnabled(data.settings.enabled);
            setThreshold(String(data.settings.confidence_threshold));
            setCreateContact(data.settings.create_contact_for_unknown);
            setAssignOwner(data.settings.assign_owner_user_id || '');
            setRules(data.settings.exclusion_rules || '');
            listMailAgentReviews(30).then(setReviews).catch(() => {});
        } catch {
            toast.error('Failed to load Mail Secretary settings');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        const API_BASE = import.meta.env.VITE_API_URL || '/api';
        authedFetch(`${API_BASE}/users`)
            .then(r => r.json())
            .then(data => setUsers((data.users || data || []).map((u: any) => ({
                id: u.id || u.user_id, name: u.full_name || u.name || u.email || 'Unknown',
            })).filter((u: CompanyUser) => u.id)))
            .catch(() => {});
    }, []);

    const handleInstall = async () => {
        setInstalling(true);
        try {
            const apps = await fetchMarketplaceApps();
            const app = apps.find((a: MarketplaceApp) => a.app_key === APP_KEY);
            if (!app) throw new Error('App is not published');
            await installMarketplaceApp(APP_KEY);
            toast.success('Mail Secretary enabled');
            await load();
        } catch (e: any) {
            toast.error(e?.message || 'Failed to enable the app');
        } finally {
            setInstalling(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        setRulesError(null);
        try {
            await saveMailAgentSettings({
                enabled,
                confidence_threshold: Number(threshold),
                create_contact_for_unknown: createContact,
                assign_owner_user_id: assignOwner || null,
                exclusion_rules: rules,
            });
            toast.success('Settings saved');
            load();
        } catch (e: any) {
            if (e?.code === 'BAD_RULES') {
                setRulesError(`Line ${e.line ?? '?'}: ${e.message}`);
                toast.error('Fix the exclusion rules and save again');
            } else {
                toast.error(e?.message || 'Failed to save');
            }
        } finally {
            setSaving(false);
        }
    };

    const handleTestRules = async () => {
        setTestResult(null);
        try {
            const res = await testMailAgentRules({ rules, from: testFrom, subject: testSubject, body: testBody });
            setTestResult(res.excluded
                ? `Excluded — rule on line ${res.rule_line}. The agent would NOT review this email.`
                : 'Not excluded — the agent would review this email.');
        } catch (e: any) {
            setTestResult(e?.code === 'BAD_RULES' ? `Rules error — line ${e.line ?? '?'}: ${e.message}` : 'Test failed');
        }
    };

    const handleDryRun = async () => {
        setDryRunning(true);
        setDryRows(null);
        try {
            setDryRows(await runMailAgentDryRun(10));
        } catch {
            toast.error('Dry run failed');
        } finally {
            setDryRunning(false);
        }
    };

    if (loading) {
        return (
            <SettingsPageShell backTo="/settings/integrations" backLabel="Integrations" title="Mail Secretary">
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                    <Loader2 className="size-4 animate-spin" /> Loading…
                </div>
            </SettingsPageShell>
        );
    }

    const installed = !!overview?.installed;
    const gmailConnected = !!overview?.gmail_connected;
    const stats = overview?.stats;

    return (
        <SettingsPageShell
            backTo="/settings/integrations"
            backLabel="Integrations"
            title="Mail Secretary"
            description="Find the emails that need a person and turn them into clear dispatcher tasks."
            actions={installed ? (
                <Button onClick={handleSave} disabled={saving}>
                    {saving ? <Loader2 className="size-4 animate-spin" /> : null} Save
                </Button>
            ) : undefined}
        >
            {!installed ? (
                <CloudBanner variant="hero">
                    <p className="blanc-eyebrow">EMAIL AI</p>
                    <h3
                        className="mt-2 text-2xl sm:text-[28px]"
                        style={{ fontFamily: 'var(--blanc-font-heading)', fontWeight: 800, color: 'var(--blanc-ink-1)' }}
                    >
                        Let the important emails find you
                    </h3>
                    <p className="mt-2 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                        Mail Secretary reviews incoming mail, spots what needs attention, and gives your team a clear next step.
                    </p>
                    <div className="mt-4 space-y-2.5">
                        <div className="flex items-start gap-2.5">
                            <Mail className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                            <p className="text-sm">
                                <span className="font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>Catch what needs a reply</span>
                                <span style={{ color: 'var(--blanc-ink-2)' }}> — Separate customer requests from routine inbox noise</span>
                            </p>
                        </div>
                        <div className="flex items-start gap-2.5">
                            <ListChecks className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                            <p className="text-sm">
                                <span className="font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>Turn attention into action</span>
                                <span style={{ color: 'var(--blanc-ink-2)' }}> — Create a dispatcher task when an email needs a person</span>
                            </p>
                        </div>
                        <div className="flex items-start gap-2.5">
                            <SlidersHorizontal className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                            <p className="text-sm">
                                <span className="font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>Stay in control</span>
                                <span style={{ color: 'var(--blanc-ink-2)' }}> — Tune sensitivity, exclusions, and task ownership for your team</span>
                            </p>
                        </div>
                    </div>
                    {!gmailConnected && (
                        <p className="mt-4 text-sm" style={{ color: 'var(--blanc-warning)' }}>
                            Gmail is not connected. Connect a mailbox in Settings → Integrations → Google Email first.
                        </p>
                    )}
                    <Button className="mt-5 h-11 px-6" onClick={handleInstall} disabled={installing || !gmailConnected}>
                        {installing ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                        Enable Mail Secretary
                    </Button>
                    <p className="mt-2.5 text-[13px]" style={{ color: 'var(--blanc-ink-3)' }}>
                        Takes less than a minute. Mail Secretary stores triage results, not a second copy of your mailbox.
                    </p>
                </CloudBanner>
            ) : (
                <SettingsSection
                    title="Mail triage"
                    description="Keep Mail Secretary working, or pause new reviews whenever your team needs to."
                >
                    <div className="space-y-3.5">
                            <label className="flex items-center gap-2.5 cursor-pointer">
                                <Checkbox checked={enabled} onCheckedChange={v => setEnabled(v === true)} />
                                <span className="text-sm" style={{ color: 'var(--blanc-ink-1)' }}>
                                    {enabled
                                        ? 'Mail Secretary is on — reviewing every new inbound email'
                                        : 'Mail Secretary is paused — new email will wait for your team'}
                                </span>
                            </label>
                            {stats && (
                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                    <StatChip label="Reviewed · 30d" value={stats.reviewed_30d} />
                                    <StatChip label="Tasks created" value={stats.tasks_30d} />
                                    <StatChip label="Excluded by rules" value={stats.excluded_30d} />
                                    <StatChip label="Errors" value={stats.errors_30d} />
                                </div>
                            )}
                    </div>
                </SettingsSection>
            )}

            {installed && (
                <>
                    {/* ── Behaviour ── */}
                    <SettingsSection
                        title="Behaviour"
                        description="Choose how readily Mail Secretary flags messages and handles new senders."
                    >
                        <div className="space-y-3.5">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                <FloatingSelect label="Sensitivity" value={threshold} onValueChange={setThreshold}>
                                    <SelectItem value="0.45">Flag more (may add noise)</SelectItem>
                                    <SelectItem value="0.6">Balanced</SelectItem>
                                    <SelectItem value="0.75">Strict (only confident flags)</SelectItem>
                                </FloatingSelect>
                                <FloatingSelect label="Assign tasks to" value={assignOwner || 'unassigned'} onValueChange={v => setAssignOwner(v === 'unassigned' ? '' : v)}>
                                    <SelectItem value="unassigned">Unassigned</SelectItem>
                                    {users.map(u => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                                </FloatingSelect>
                            </div>
                            <label className="flex items-center gap-2.5 cursor-pointer">
                                <Checkbox checked={createContact} onCheckedChange={v => setCreateContact(v === true)} />
                                <span className="text-sm" style={{ color: 'var(--blanc-ink-1)' }}>
                                    Create a contact for unknown senders the agent flags (potential leads)
                                </span>
                            </label>
                        </div>
                    </SettingsSection>

                    {/* ── Exclusion rules ── */}
                    <SettingsSection
                        title="Exclusion rules"
                        description="Keep newsletters, notifications, and other routine mail out of triage."
                    >
                        <div className="space-y-3.5">
                            <textarea
                                value={rules}
                                onChange={e => { setRules(e.target.value); setRulesError(null); }}
                                rows={6}
                                spellCheck={false}
                                placeholder={'from:@newsletters.\nsubject:unsubscribe\nfrom:notifications@github.com -subject:"security alert"\nsubject:/^(promo|sale)/i'}
                                className="w-full rounded-[10px] px-3.5 py-3 font-mono text-[13px] outline-none"
                                style={{
                                    background: 'var(--blanc-field)', border: '1px solid transparent',
                                    color: 'var(--blanc-ink-1)', resize: 'vertical',
                                }}
                                onFocus={e => (e.currentTarget.style.borderColor = 'var(--blanc-line-strong)')}
                                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
                            />
                            {rulesError && <p className="text-sm" style={{ color: 'var(--blanc-danger)' }}>{rulesError}</p>}
                            <p className="text-[13px]" style={{ color: 'var(--blanc-ink-3)' }}>
                                One rule per line; a matching line excludes the email. Tokens: <code>from:</code>, <code>subject:</code>, <code>body:</code> or a bare word (searches from + subject).
                                Plain text = case-insensitive contains, <code>/regex/i</code> for patterns, <code>-token</code> to require NO match, <code>"quotes"</code> keep spaces.
                                <code>#</code> starts a comment.
                            </p>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                <FloatingField label="Test: From" value={testFrom} onChange={e => setTestFrom(e.target.value)} />
                                <FloatingField label="Test: Subject" value={testSubject} onChange={e => setTestSubject(e.target.value)} />
                            </div>
                            <FloatingField label="Test: Body (optional)" value={testBody} onChange={e => setTestBody(e.target.value)} />
                            <div className="flex items-center gap-3">
                                <Button variant="ghost" onClick={handleTestRules}>Test rules</Button>
                                {testResult && <span className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>{testResult}</span>}
                            </div>
                        </div>
                    </SettingsSection>

                    {/* ── Dry run ── */}
                    <SettingsSection
                        title="Dry run"
                        description="See how Mail Secretary would handle the last 10 emails without creating tasks."
                    >
                        <div className="space-y-3.5">
                            <Button variant="ghost" onClick={handleDryRun} disabled={dryRunning}>
                                {dryRunning ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                                Run preview
                            </Button>
                            {dryRows && (
                                dryRows.length === 0 ? (
                                    <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>No inbound emails yet.</p>
                                ) : (
                                    <div className="space-y-2">
                                        {dryRows.map((r, i) => (
                                            <div key={i} className="rounded-xl px-3.5 py-2.5" style={{ background: 'var(--blanc-panel-surface)', border: '1px solid var(--blanc-line)' }}>
                                                <div className="flex items-center justify-between gap-3">
                                                    <span className="text-sm font-medium truncate" style={{ color: 'var(--blanc-ink-1)' }}>
                                                        {r.subject || '(no subject)'}
                                                    </span>
                                                    <VerdictChip verdict={r.verdict} />
                                                </div>
                                                <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--blanc-ink-3)' }}>
                                                    {r.from_name ? `${r.from_name} · ` : ''}{r.from_email}
                                                    {typeof r.confidence === 'number' && ` · ${(r.confidence * 100).toFixed(0)}%`}
                                                </div>
                                                {r.reason && <div className="text-sm mt-1" style={{ color: 'var(--blanc-ink-2)' }}>{r.reason}</div>}
                                            </div>
                                        ))}
                                    </div>
                                )
                            )}
                        </div>
                    </SettingsSection>

                    {/* ── Recent decisions ── */}
                    <SettingsSection
                        title="Recent decisions"
                        description="A clear record of each reviewed email and what Mail Secretary decided."
                    >
                        {reviews.length === 0 ? (
                            <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>No decisions yet — they appear as new email arrives.</p>
                        ) : (
                            <div className="space-y-2">
                                {reviews.map(r => (
                                    <div key={r.id} className="rounded-xl px-3.5 py-2.5" style={{ background: 'var(--blanc-panel-surface)', border: '1px solid var(--blanc-line)' }}>
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="text-sm font-medium truncate" style={{ color: 'var(--blanc-ink-1)' }}>
                                                {r.subject || '(no subject)'}
                                            </span>
                                            <VerdictChip verdict={r.verdict} />
                                        </div>
                                        <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--blanc-ink-3)' }}>
                                            {r.from_name ? `${r.from_name} · ` : ''}{r.from_email}
                                            {typeof r.confidence === 'number' && r.confidence !== null && ` · ${(Number(r.confidence) * 100).toFixed(0)}%`}
                                            {' · '}{new Date(r.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                            {r.rule_line != null && ` · rule line ${r.rule_line}`}
                                        </div>
                                        {r.reason && <div className="text-sm mt-1" style={{ color: 'var(--blanc-ink-2)' }}>{r.reason}</div>}
                                    </div>
                                ))}
                            </div>
                        )}
                    </SettingsSection>
                </>
            )}
        </SettingsPageShell>
    );
}
