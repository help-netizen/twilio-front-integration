/**
 * RuleEditor.tsx — AUTO-001. Trigger → conditions → actions builder, written
 * as a readable sentence (When … only if … then do …).
 */
import { useState } from 'react';
import { Plus, Trash2, Zap, X } from 'lucide-react';
import type { AutomationRule, Catalog, RuleAction } from '../../services/automationApi';

const LINE = 'var(--blanc-line, rgba(117,106,89,0.18))';
const input: React.CSSProperties = {
    height: 38, borderRadius: 10, padding: '0 10px', border: `1px solid ${LINE}`,
    fontSize: 14, background: '#fff', color: 'var(--blanc-ink-1, #202734)', boxSizing: 'border-box',
};
const eyebrow: React.CSSProperties = {
    fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.13em',
    color: 'var(--blanc-ink-3, #7d8796)', fontWeight: 500,
};
const block: React.CSSProperties = { padding: 16, background: 'rgba(117,106,89,0.05)', borderRadius: 16 };
const kw = { color: 'var(--blanc-ink-3, #7d8796)', fontWeight: 500, padding: '0 2px' } as React.CSSProperties;

// Human labels for the raw operators stored on the rule.
const OP_LABELS: Record<string, string> = {
    eq: 'is', ne: 'is not', in: 'is one of', nin: 'is not one of',
    contains: 'contains', gt: 'is greater than', lt: 'is less than',
    exists: 'is set', truthy: 'is true',
};
const NO_VALUE = new Set(['exists', 'truthy']);
const DURATIONS: Array<[number, string]> = [
    [300, '5 minutes'], [900, '15 minutes'], [1800, '30 minutes'], [3600, '1 hour'],
    [7200, '2 hours'], [14400, '4 hours'], [86400, '1 day'], [172800, '2 days'], [604800, '1 week'],
];

interface Cond { field: string; op: string; value?: any }

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
    return (
        <span style={{ display: 'inline-flex', background: 'rgba(117,106,89,0.1)', borderRadius: 10, padding: 3 }}>
            {options.map(([v, lbl]) => (
                <button key={v} type="button" onClick={() => onChange(v)} style={{
                    fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer', padding: '6px 14px', borderRadius: 8,
                    background: value === v ? '#fff' : 'transparent', color: value === v ? 'var(--blanc-ink-1, #202734)' : 'var(--blanc-ink-2, #536070)',
                }}>{lbl}</button>
            ))}
        </span>
    );
}

export function RuleEditor({ catalog, initial, onSave, onCancel, saving }: {
    catalog: Catalog;
    initial?: Partial<AutomationRule>;
    onSave: (rule: Partial<AutomationRule>) => void;
    onCancel: () => void;
    saving: boolean;
}) {
    const [name, setName] = useState(initial?.name || '');
    const [description, setDescription] = useState(initial?.description || '');
    const [triggerKind, setTriggerKind] = useState<'event' | 'schedule'>(initial?.trigger_kind || 'event');
    const [eventType, setEventType] = useState(initial?.event_type || catalog.event_types[0]?.key || '');
    const [scheduleMode, setScheduleMode] = useState<'delay' | 'cron'>(initial?.schedule_cron ? 'cron' : 'delay');
    const [delayAfter, setDelayAfter] = useState(initial?.delay_after_event_type || catalog.event_types[0]?.key || '');
    const [delaySeconds, setDelaySeconds] = useState(initial?.delay_seconds || 3600);
    const [cron, setCron] = useState(initial?.schedule_cron || '');
    const [logic, setLogic] = useState<'all' | 'any'>(initial?.conditions?.any ? 'any' : 'all');
    const [conds, setConds] = useState<Cond[]>((initial?.conditions?.all || initial?.conditions?.any || []) as Cond[]);
    const [actions, setActions] = useState<RuleAction[]>(initial?.actions || []);

    const activeEvent = triggerKind === 'event' ? eventType : delayAfter;
    const sampleFields = catalog.event_types.find(e => e.key === activeEvent)?.sample_fields || [];
    const buildConditions = () => conds.length ? { [logic]: conds } : {};

    const submit = () => {
        const rule: Partial<AutomationRule> = { name, description, trigger_kind: triggerKind, conditions: buildConditions(), actions };
        if (triggerKind === 'event') {
            rule.event_type = eventType;
        } else if (scheduleMode === 'delay') {
            rule.delay_after_event_type = delayAfter || null; rule.delay_seconds = delaySeconds; rule.schedule_cron = null;
        } else {
            rule.schedule_cron = cron || null; rule.delay_after_event_type = null;
        }
        onSave(rule);
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
                <label style={{ ...eyebrow, display: 'block', marginBottom: 5 }}>Rule name</label>
                <input style={{ ...input, width: '100%' }} value={name} onChange={e => setName(e.target.value)} placeholder="Text the customer when a job is completed" />
            </div>
            <div>
                <label style={{ ...eyebrow, display: 'block', marginBottom: 5 }}>Description</label>
                <input style={{ ...input, width: '100%' }} value={description || ''} onChange={e => setDescription(e.target.value)} placeholder="Optional" />
            </div>

            {/* When */}
            <div style={block}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
                    <span style={eyebrow}>When</span>
                    <Segmented value={triggerKind} onChange={setTriggerKind} options={[['event', 'An event happens'], ['schedule', 'On a schedule']]} />
                </div>
                {triggerKind === 'event' ? (
                    <div style={{ fontSize: 15, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={kw}>When</span>
                        <select style={input} value={eventType} onChange={e => setEventType(e.target.value)}>
                            {catalog.event_types.map(et => <option key={et.key} value={et.key}>{et.label}</option>)}
                        </select>
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <Segmented value={scheduleMode} onChange={setScheduleMode} options={[['delay', 'Wait after an event'], ['cron', 'On a fixed schedule']]} />
                        {scheduleMode === 'delay' ? (
                            <div style={{ fontSize: 15, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <span style={kw}>Wait</span>
                                <select style={input} value={delaySeconds} onChange={e => setDelaySeconds(parseInt(e.target.value, 10))}>
                                    {DURATIONS.map(([s, lbl]) => <option key={s} value={s}>{lbl}</option>)}
                                </select>
                                <span style={kw}>after</span>
                                <select style={input} value={delayAfter} onChange={e => setDelayAfter(e.target.value)}>
                                    {catalog.event_types.map(et => <option key={et.key} value={et.key}>{et.label}</option>)}
                                </select>
                            </div>
                        ) : (
                            <div style={{ fontSize: 15, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <span style={kw}>Run on cron</span>
                                <input style={{ ...input, minWidth: 160 }} value={cron} onChange={e => setCron(e.target.value)} placeholder="0 9 * * *" />
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Only if */}
            <div style={block}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={eyebrow}>Only if</span>
                    {conds.length > 1 && (
                        <select value={logic} onChange={e => setLogic(e.target.value as any)} style={{ ...input, height: 30, fontSize: 12.5 }}>
                            <option value="all">match all</option>
                            <option value="any">match any</option>
                        </select>
                    )}
                </div>
                {conds.length === 0 && <p style={{ fontSize: 13, color: 'var(--blanc-ink-3, #7d8796)', margin: '0 0 8px' }}>Always runs. Add a condition to narrow it.</p>}
                {conds.map((c, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input list="rule-fields" style={{ ...input, flex: '1 1 130px', minWidth: 120 }} value={c.field} placeholder="field"
                            onChange={e => setConds(cs => cs.map((x, j) => j === i ? { ...x, field: e.target.value } : x))} />
                        <select style={input} value={c.op} onChange={e => setConds(cs => cs.map((x, j) => j === i ? { ...x, op: e.target.value } : x))}>
                            {Object.entries(OP_LABELS).map(([o, lbl]) => <option key={o} value={o}>{lbl}</option>)}
                        </select>
                        {!NO_VALUE.has(c.op) && (
                            <input style={{ ...input, flex: '1 1 120px', minWidth: 110 }} value={c.value ?? ''} placeholder="value"
                                onChange={e => setConds(cs => cs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
                        )}
                        <button onClick={() => setConds(cs => cs.filter((_, j) => j !== i))} aria-label="Remove condition" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--blanc-ink-3, #7d8796)', display: 'flex' }}><X size={16} /></button>
                    </div>
                ))}
                <datalist id="rule-fields">{sampleFields.map(f => <option key={f} value={f} />)}</datalist>
                <button onClick={() => setConds(cs => [...cs, { field: sampleFields[0] || '', op: 'eq', value: '' }])}
                    style={{ marginTop: 2, border: `1px solid ${LINE}`, background: 'transparent', color: 'var(--blanc-ink-2, #536070)', fontSize: 12.5, fontWeight: 500, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px', borderRadius: 8 }}>
                    <Plus size={13} /> Add condition
                </button>
            </div>

            {/* Then do */}
            <div style={block}>
                <label style={{ ...eyebrow, display: 'block', marginBottom: 10 }}>Then do</label>
                {actions.map((a, i) => (
                    <ActionRow key={i} action={a} catalog={catalog} sampleFields={sampleFields}
                        onChange={na => setActions(as => as.map((x, j) => j === i ? na : x))}
                        onRemove={() => setActions(as => as.filter((_, j) => j !== i))} />
                ))}
                <select value="" onChange={e => { if (e.target.value) setActions(as => [...as, { type: e.target.value, params: {} }]); }}
                    style={{ ...input, width: '100%', marginTop: 2 }}>
                    <option value="">+ Add an action…</option>
                    {catalog.action_types.map(at => <option key={at.type} value={at.type}>{at.type}</option>)}
                </select>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={onCancel} style={{ padding: '9px 16px', background: 'transparent', border: `1px solid ${LINE}`, borderRadius: 10, cursor: 'pointer', color: 'var(--blanc-ink-2, #536070)', fontWeight: 500 }}>Cancel</button>
                <button onClick={submit} disabled={saving || !name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: 'var(--blanc-job, #2f63d8)', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 600, cursor: 'pointer', opacity: saving || !name ? 0.6 : 1 }}>
                    <Zap size={14} /> {saving ? 'Saving…' : 'Save rule'}
                </button>
            </div>
        </div>
    );
}

function ActionRow({ action, catalog, sampleFields, onChange, onRemove }: {
    action: RuleAction; catalog: Catalog; sampleFields: string[];
    onChange: (a: RuleAction) => void; onRemove: () => void;
}) {
    const hint = catalog.action_types.find(at => at.type === action.type)?.params || {};
    const setParam = (k: string, v: any) => onChange({ ...action, params: { ...action.params, [k]: v } });
    return (
        <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, padding: 12, marginBottom: 8, background: '#fff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <strong style={{ fontSize: 13.5, color: 'var(--blanc-ink-1, #202734)' }}>{action.type}</strong>
                <button onClick={onRemove} aria-label="Remove action" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--blanc-ink-3, #7d8796)', display: 'flex' }}><Trash2 size={14} /></button>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
                {Object.entries(hint).map(([k, desc]) => (
                    <div key={k}>
                        <label style={{ ...eyebrow, display: 'block', marginBottom: 4 }}>{k}</label>
                        <input style={{ ...input, width: '100%', height: 34 }} value={action.params[k] ?? ''} placeholder={String(desc)}
                            onChange={e => setParam(k, e.target.value)} />
                    </div>
                ))}
            </div>
            {sampleFields.length > 0 && (
                <p style={{ fontSize: 11.5, color: 'var(--blanc-ink-3, #7d8796)', margin: '8px 0 0' }}>
                    Insert variables: {sampleFields.map(f => `{{${f}}}`).join('  ')}
                </p>
            )}
        </div>
    );
}

export default RuleEditor;
