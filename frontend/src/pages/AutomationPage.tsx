/**
 * AutomationPage.tsx — AUTO-001. Rules list + editor + run history.
 */
import { useEffect, useState } from 'react';
import { Plus, History, Trash2, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { automationApi, type AutomationRule, type Catalog, type RuleRun } from '../services/automationApi';
import { RuleEditor } from '../components/automation/RuleEditor';
import { FloatingDetailPanel } from '../components/ui/FloatingDetailPanel';

const LINE = 'var(--blanc-line, rgba(117,106,89,0.18))';
const INK2 = 'var(--blanc-ink-2, #536070)';
const INK3 = 'var(--blanc-ink-3, #7d8796)';
const PRI = 'var(--blanc-job, #2f63d8)';

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
        <div style={{ padding: '28px 24px', maxWidth: 1000, margin: '0 auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 22, gap: 16, flexWrap: 'wrap' }}>
                <div>
                    <div className="blanc-eyebrow">Automation</div>
                    <h1 style={{ fontSize: 24, fontWeight: 600, margin: '4px 0 4px', fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: 'var(--blanc-ink-1, #202734)' }}>Rules</h1>
                    <p style={{ fontSize: 13, color: INK3, margin: 0 }}>React to events and timers — send messages, create tasks, run agents.</p>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={seed} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', background: 'transparent', border: `1px solid ${LINE}`, borderRadius: 10, fontSize: 13, cursor: 'pointer', color: INK2, fontWeight: 500 }}><Sparkles size={14} /> Add defaults</button>
                    <button onClick={() => setEditing({})} disabled={!catalog} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', background: PRI, color: '#fff', border: 'none', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: catalog ? 1 : 0.6 }}><Plus size={14} /> New rule</button>
                </div>
            </div>

            {loading ? <div style={{ padding: 40, textAlign: 'center', color: INK3 }}><Loader2 className="animate-spin" /></div> : (
                rules.length === 0 ? (
                    <div style={{ padding: 40, textAlign: 'center', color: INK3, border: `1px dashed ${LINE}`, borderRadius: 16 }}>
                        No rules yet. Create one, or add a few sensible defaults to start.
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {rules.map(r => (
                            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', border: `1px solid ${LINE}`, borderRadius: 14, background: 'var(--blanc-surface-strong, #fffdf9)' }}>
                                <button onClick={() => toggle(r)} aria-label={r.enabled ? 'Disable rule' : 'Enable rule'} style={{ width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', background: r.enabled ? 'var(--blanc-success, #1b8b63)' : 'rgba(117,106,89,0.22)', position: 'relative', flexShrink: 0 }}>
                                    <span style={{ position: 'absolute', top: 2, left: r.enabled ? 20 : 2, width: 18, height: 18, borderRadius: 9, background: '#fff', transition: 'left .15s' }} />
                                </button>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, fontSize: 14.5, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--blanc-ink-1, #202734)' }}>
                                        {r.name}
                                        {r.is_system && <span style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 99, background: 'rgba(47,99,216,0.12)', color: '#234d9e' }}>system</span>}
                                    </div>
                                    <div style={{ fontSize: 12.5, color: INK3, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ruleSentence(r)}</div>
                                </div>
                                <button onClick={() => showRuns(r)} aria-label="Run history" style={{ border: 'none', background: 'none', cursor: 'pointer', color: INK3, display: 'flex' }}><History size={16} /></button>
                                <button onClick={() => setEditing(r)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: PRI, fontSize: 13, fontWeight: 600 }}>Edit</button>
                                <button onClick={() => remove(r)} aria-label="Delete rule" style={{ border: 'none', background: 'none', cursor: 'pointer', color: INK3, display: 'flex' }}><Trash2 size={15} /></button>
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
        </div>
    );
}
