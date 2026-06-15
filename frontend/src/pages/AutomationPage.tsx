/**
 * AutomationPage.tsx — AUTO-001. Rules list + editor + run history.
 */
import { useEffect, useState } from 'react';
import { Zap, Plus, History, Trash2, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { automationApi, type AutomationRule, type Catalog, type RuleRun } from '../services/automationApi';
import { RuleEditor } from '../components/automation/RuleEditor';

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

    return (
        <div style={{ padding: 24, maxWidth: 980, margin: '0 auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div>
                    <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Zap size={20} /> Automation</h1>
                    <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Rules react to events and timers — send messages, create tasks, run agents.</p>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={seed} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', background: '#fff', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}><Sparkles size={14} /> Add defaults</button>
                    <button onClick={() => setEditing({})} disabled={!catalog} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', background: '#111827', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}><Plus size={14} /> New rule</button>
                </div>
            </div>

            {loading ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}><Loader2 className="animate-spin" /></div> : (
                rules.length === 0 ? (
                    <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', border: '1px dashed #d1d5db', borderRadius: 14 }}>
                        No rules yet. Create one or add the defaults.
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {rules.map(r => (
                            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', border: '1px solid var(--blanc-line, #e5e7eb)', borderRadius: 12, background: '#fff' }}>
                                <button onClick={() => toggle(r)} title={r.enabled ? 'Enabled' : 'Disabled'} style={{ width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', background: r.enabled ? '#16a34a' : '#d1d5db', position: 'relative', flexShrink: 0 }}>
                                    <span style={{ position: 'absolute', top: 2, left: r.enabled ? 20 : 2, width: 18, height: 18, borderRadius: 9, background: '#fff', transition: 'left .15s' }} />
                                </button>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                                        {r.name}
                                        {r.is_system && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: '#eef2ff', color: '#4338ca' }}>system</span>}
                                    </div>
                                    <div style={{ fontSize: 12, color: '#6b7280' }}>
                                        {r.trigger_kind === 'event' ? `on ${r.event_type}` : (r.delay_after_event_type ? `${r.delay_seconds}s after ${r.delay_after_event_type}` : `cron ${r.schedule_cron}`)}
                                        {' · '}{r.actions.length} action{r.actions.length !== 1 ? 's' : ''}
                                    </div>
                                </div>
                                <button onClick={() => showRuns(r)} title="Run history" style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#6b7280' }}><History size={16} /></button>
                                <button onClick={() => setEditing(r)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#3c362c', fontSize: 13, fontWeight: 600 }}>Edit</button>
                                <button onClick={() => remove(r)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9ca3af' }}><Trash2 size={15} /></button>
                            </div>
                        ))}
                    </div>
                )
            )}

            {/* Editor drawer */}
            {editing && catalog && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }} onClick={() => setEditing(null)}>
                    <div onClick={e => e.stopPropagation()} style={{ width: 540, maxWidth: '100%', height: '100%', background: '#fff', padding: 24, overflowY: 'auto' }}>
                        <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 16px' }}>{(editing as AutomationRule).id ? 'Edit rule' : 'New rule'}</h2>
                        <RuleEditor catalog={catalog} initial={editing} onSave={save} onCancel={() => setEditing(null)} saving={saving} />
                    </div>
                </div>
            )}

            {/* Runs drawer */}
            {runsFor && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }} onClick={() => setRunsFor(null)}>
                    <div onClick={e => e.stopPropagation()} style={{ width: 460, maxWidth: '100%', height: '100%', background: '#fff', padding: 24, overflowY: 'auto' }}>
                        <h2 style={{ fontSize: 17, fontWeight: 700, margin: '0 0 4px' }}>Run history</h2>
                        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 16px' }}>{runsFor.name}</p>
                        {runs.length === 0 ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No runs yet.</div> : runs.map(run => (
                            <div key={run.id} style={{ padding: '10px 0', borderBottom: '1px solid #f3f4f6' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                                    <span style={{ fontWeight: 600, color: run.status === 'succeeded' ? '#16a34a' : run.status === 'failed' ? '#dc2626' : '#6b7280' }}>{run.status}</span>
                                    <span style={{ color: '#9ca3af' }}>{new Date(run.created_at).toLocaleString()}</span>
                                </div>
                                {run.error_text && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 4 }}>{run.error_text}</div>}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
