/**
 * AutomationPage.tsx — AUTO-001. Rules list + editor + run history.
 */
import { useEffect, useState } from 'react';
import { Plus, History, Trash2, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { automationApi, type AutomationRule, type Catalog, type RuleRun } from '../services/automationApi';
import { RuleEditor } from '../components/automation/RuleEditor';
import { FloatingDetailPanel } from '../components/ui/FloatingDetailPanel';
import { Button } from '../components/ui/button';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';

const INK2 = 'var(--blanc-ink-2, #536070)';
const INK3 = 'var(--blanc-ink-3, #7d8796)';

function humanizeDur(s?: number | null): string {
    if (!s) return '';
    if (s % 86400 === 0) return `${s / 86400} day${s / 86400 > 1 ? 's' : ''}`;
    if (s % 3600 === 0) return `${s / 3600} hour${s / 3600 > 1 ? 's' : ''}`;
    if (s % 60 === 0) return `${s / 60} min`;
    return `${s}s`;
}

export default function AutomationPage() {
    const [rules, setRules] = useState<AutomationRule[]>([]);
    const [catalog, setCatalog] = useState<Catalog | null>(null);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState<Partial<AutomationRule> | null>(null);
    const [saving, setSaving] = useState(false);
    const [runsFor, setRunsFor] = useState<AutomationRule | null>(null);
    const [runs, setRuns] = useState<RuleRun[]>([]);

    const load = async () => {
        setLoading(true);
        try {
            const [c, r] = await Promise.all([automationApi.catalog(), automationApi.listRules()]);
            setCatalog(c); setRules(r.rules);
        } catch (e: any) { toast.error(e.message || 'Failed to load automation'); }
        finally { setLoading(false); }
    };
    useEffect(() => { load(); }, []);

    const save = async (rule: Partial<AutomationRule>) => {
        setSaving(true);
        try {
            if (editing && (editing as AutomationRule).id) await automationApi.updateRule((editing as AutomationRule).id, rule);
            else await automationApi.createRule(rule);
            setEditing(null); await load();
            toast.success('Rule saved');
        } catch (e: any) { toast.error(e.message || 'Save failed'); }
        finally { setSaving(false); }
    };

    const toggle = async (r: AutomationRule) => {
        try { await automationApi.updateRule(r.id, { enabled: !r.enabled }); await load(); }
        catch (e: any) { toast.error(e.message); }
    };

    const remove = async (r: AutomationRule) => {
        if (!window.confirm(`Delete rule "${r.name}"?`)) return;
        try { await automationApi.deleteRule(r.id); await load(); }
        catch (e: any) { toast.error(e.message); }
    };

    const showRuns = async (r: AutomationRule) => {
        setRunsFor(r);
        try { const { runs } = await automationApi.runs(r.id); setRuns(runs); }
        catch { setRuns([]); }
    };

    const seed = async () => {
        try { const { inserted } = await automationApi.seedDefaults(); toast.success(`${inserted} default rule(s) added`); await load(); }
        catch (e: any) { toast.error(e.message); }
    };

    const evLabel = (key?: string | null) => catalog?.event_types.find(e => e.key === key)?.label || key || '';
    const ruleSentence = (r: AutomationRule) => {
        const trigger = r.trigger_kind === 'event'
            ? `When ${evLabel(r.event_type)}`
            : r.delay_after_event_type
                ? `${humanizeDur(r.delay_seconds)} after ${evLabel(r.delay_after_event_type)}`
                : `On schedule ${r.schedule_cron}`;
        const acts = r.actions.map(a => a.type).join(', ');
        return acts ? `${trigger} → ${acts}` : trigger;
    };

    return (
        <SettingsPageShell
            title="Automations"
            description="React to events and timers — send messages, create tasks, run agents."
            actions={
                <>
                    <Button variant="outline" onClick={seed}><Sparkles size={14} /> Add defaults</Button>
                    <Button onClick={() => setEditing({})} disabled={!catalog}><Plus size={14} /> New rule</Button>
                </>
            }
        >
            {loading ? <div className="py-10 text-center" style={{ color: INK3 }}><Loader2 className="animate-spin" /></div> : (
                rules.length === 0 ? (
                    <div className="rounded-2xl border border-dashed p-10 text-center" style={{ borderColor: 'var(--blanc-line)', color: INK3 }}>
                        No rules yet. Create one, or add a few sensible defaults to start.
                    </div>
                ) : (
                    <div className="flex flex-col gap-2.5">
                        {rules.map(r => (
                            <div key={r.id} className="flex items-center gap-3 rounded-xl border px-4 py-3.5" style={{ borderColor: 'var(--blanc-line)', background: 'var(--blanc-surface-strong)' }}>
                                <button onClick={() => toggle(r)} aria-label={r.enabled ? 'Disable rule' : 'Enable rule'} className="relative h-[22px] w-10 shrink-0 cursor-pointer rounded-full" style={{ background: r.enabled ? 'var(--blanc-success)' : 'rgba(25,25,25,0.18)' }}>
                                    <span className="absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white transition-[left] duration-150" style={{ left: r.enabled ? 20 : 2 }} />
                                </button>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5 text-[14.5px] font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>
                                        {r.name}
                                        {r.is_system && <span className="rounded-full px-[7px] py-px text-[10.5px]" style={{ background: 'rgba(47,99,216,0.12)', color: 'var(--blanc-info)' }}>system</span>}
                                    </div>
                                    <div className="mt-0.5 truncate text-[12.5px]" style={{ color: INK3 }}>{ruleSentence(r)}</div>
                                </div>
                                <button onClick={() => showRuns(r)} aria-label="Run history" className="flex cursor-pointer" style={{ color: INK3 }}><History size={16} /></button>
                                <button onClick={() => setEditing(r)} className="cursor-pointer text-[13px] font-semibold" style={{ color: 'var(--blanc-job)' }}>Edit</button>
                                <button onClick={() => remove(r)} aria-label="Delete rule" className="flex cursor-pointer" style={{ color: INK3 }}><Trash2 size={15} /></button>
                            </div>
                        ))}
                    </div>
                )
            )}

            {/* Editor drawer */}
            {editing && catalog && (
                <FloatingDetailPanel open wide onClose={() => setEditing(null)}>
                    <div style={{ padding: 26, height: '100%', overflowY: 'auto' }}>
                        <h2 style={{ fontSize: 19, fontWeight: 600, margin: '0 0 18px', fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: 'var(--blanc-ink-1, #202734)' }}>{(editing as AutomationRule).id ? 'Edit rule' : 'New rule'}</h2>
                        <RuleEditor catalog={catalog} initial={editing} onSave={save} onCancel={() => setEditing(null)} saving={saving} />
                    </div>
                </FloatingDetailPanel>
            )}

            {/* Runs drawer */}
            {runsFor && (
                <FloatingDetailPanel open onClose={() => setRunsFor(null)}>
                    <div style={{ padding: 26, height: '100%', overflowY: 'auto' }}>
                        <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 4px', fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: 'var(--blanc-ink-1, #202734)' }}>Run history</h2>
                        <p style={{ fontSize: 13, color: INK3, margin: '0 0 16px' }}>{runsFor.name}</p>
                        {runs.length === 0 ? <div style={{ color: INK3, fontSize: 13 }}>No runs yet.</div> : runs.map(run => (
                            <div key={run.id} style={{ padding: '12px 0' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                                    <span style={{ fontWeight: 600, color: run.status === 'succeeded' ? 'var(--blanc-success, #1b8b63)' : run.status === 'failed' ? 'var(--blanc-danger, #d44d3c)' : INK2 }}>{run.status}</span>
                                    <span style={{ color: INK3 }}>{new Date(run.created_at).toLocaleString()}</span>
                                </div>
                                {run.error_text && <div style={{ fontSize: 12, color: 'var(--blanc-danger, #d44d3c)', marginTop: 4 }}>{run.error_text}</div>}
                            </div>
                        ))}
                    </div>
                </FloatingDetailPanel>
            )}
        </SettingsPageShell>
    );
}
