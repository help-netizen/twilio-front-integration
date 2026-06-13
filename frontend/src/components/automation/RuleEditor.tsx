/**
 * RuleEditor.tsx — AUTO-001. Trigger → conditions → actions builder.
 */
import { useState } from 'react';
import { Plus, Trash2, Zap } from 'lucide-react';
import type { AutomationRule, Catalog, RuleAction } from '../../services/automationApi';

const input: React.CSSProperties = { width: '100%', height: 38, borderRadius: 8, padding: '0 10px', border: '1px solid var(--blanc-line, #d1d5db)', fontSize: 13 };
const label: React.CSSProperties = { fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#6b7280', display: 'block', marginBottom: 5 };
const OPS = ['eq', 'ne', 'in', 'nin', 'contains', 'gt', 'lt', 'exists', 'truthy'];

interface Cond { field: string; op: string; value?: any }

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
    const [delayAfter, setDelayAfter] = useState(initial?.delay_after_event_type || '');
    const [delaySeconds, setDelaySeconds] = useState(initial?.delay_seconds || 3600);
    const [cron, setCron] = useState(initial?.schedule_cron || '');
    const [logic, setLogic] = useState<'all' | 'any'>(initial?.conditions?.any ? 'any' : 'all');
    const [conds, setConds] = useState<Cond[]>(
        (initial?.conditions?.all || initial?.conditions?.any || []) as Cond[]
    );
    const [actions, setActions] = useState<RuleAction[]>(initial?.actions || []);

    const sampleFields = catalog.event_types.find(e => e.key === (triggerKind === 'event' ? eventType : delayAfter))?.sample_fields || [];

    const buildConditions = () => conds.length ? { [logic]: conds } : {};

    const submit = () => {
        const rule: Partial<AutomationRule> = {
            name, description, trigger_kind: triggerKind, conditions: buildConditions(), actions,
        };
        if (triggerKind === 'event') rule.event_type = eventType;
        else { rule.delay_after_event_type = delayAfter || null; rule.delay_seconds = delaySeconds; rule.schedule_cron = cron || null; }
        onSave(rule);
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
                <label style={label}>Rule name</label>
                <input style={input} value={name} onChange={e => setName(e.target.value)} placeholder="Notify customer when job is done" />
            </div>
            <div>
                <label style={label}>Description</label>
                <input style={input} value={description || ''} onChange={e => setDescription(e.target.value)} placeholder="Optional" />
            </div>

            {/* Trigger */}
            <div style={{ padding: 14, background: 'rgba(117,106,89,0.04)', borderRadius: 12 }}>
                <label style={label}>When</label>
                <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                    {(['event', 'schedule'] as const).map(k => (
                        <button key={k} onClick={() => setTriggerKind(k)} style={{
                            padding: '6px 12px', borderRadius: 8, fontSize: 12.5, cursor: 'pointer',
                            border: `1px solid ${triggerKind === k ? '#111827' : '#d1d5db'}`,
                            background: triggerKind === k ? '#111827' : '#fff', color: triggerKind === k ? '#fff' : '#374151',
                        }}>{k === 'event' ? 'An event happens' : 'On a timer'}</button>
                    ))}
                </div>
                {triggerKind === 'event' ? (
                    <select style={input} value={eventType} onChange={e => setEventType(e.target.value)}>
                        {catalog.event_types.map(et => <option key={et.key} value={et.key}>{et.label}</option>)}
                    </select>
                ) : (
                    <div style={{ display: 'grid', gap: 8 }}>
                        <select style={input} value={delayAfter} onChange={e => setDelayAfter(e.target.value)}>
                            <option value="">After an event…</option>
                            {catalog.event_types.map(et => <option key={et.key} value={et.key}>{et.label}</option>)}
                        </select>
                        {delayAfter && (
                            <input style={input} type="number" value={delaySeconds}
                                onChange={e => setDelaySeconds(parseInt(e.target.value, 10) || 0)} placeholder="Delay seconds" />
                        )}
                        <input style={input} value={cron} onChange={e => setCron(e.target.value)} placeholder="…or cron (e.g. 0 9 * * *)" />
                    </div>
                )}
            </div>

            {/* Conditions */}
            <div style={{ padding: 14, background: 'rgba(117,106,89,0.04)', borderRadius: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <label style={{ ...label, margin: 0 }}>Only if</label>
                    <select value={logic} onChange={e => setLogic(e.target.value as any)} style={{ ...input, width: 'auto', height: 30 }}>
                        <option value="all">match ALL</option>
                        <option value="any">match ANY</option>
                    </select>
                </div>
                {conds.map((c, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                        <input list="fields" style={{ ...input, flex: 2 }} value={c.field} placeholder="field"
                            onChange={e => setConds(cs => cs.map((x, j) => j === i ? { ...x, field: e.target.value } : x))} />
                        <select style={{ ...input, flex: 1 }} value={c.op}
                            onChange={e => setConds(cs => cs.map((x, j) => j === i ? { ...x, op: e.target.value } : x))}>
                            {OPS.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                        <input style={{ ...input, flex: 2 }} value={c.value ?? ''} placeholder="value"
                            onChange={e => setConds(cs => cs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
                        <button onClick={() => setConds(cs => cs.filter((_, j) => j !== i))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9ca3af' }}><Trash2 size={15} /></button>
                    </div>
                ))}
                <datalist id="fields">{sampleFields.map(f => <option key={f} value={f} />)}</datalist>
                <button onClick={() => setConds(cs => [...cs, { field: sampleFields[0] || '', op: 'eq', value: '' }])}
                    style={{ marginTop: 4, border: 'none', background: 'none', color: '#3c362c', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Plus size={13} /> Add condition
                </button>
            </div>

            {/* Actions */}
            <div style={{ padding: 14, background: 'rgba(117,106,89,0.04)', borderRadius: 12 }}>
                <label style={label}>Then do</label>
                {actions.map((a, i) => (
                    <ActionRow key={i} action={a} catalog={catalog} sampleFields={sampleFields}
                        onChange={na => setActions(as => as.map((x, j) => j === i ? na : x))}
                        onRemove={() => setActions(as => as.filter((_, j) => j !== i))} />
                ))}
                <select value="" onChange={e => { if (e.target.value) setActions(as => [...as, { type: e.target.value, params: {} }]); }}
                    style={{ ...input, marginTop: 6 }}>
                    <option value="">+ Add action…</option>
                    {catalog.action_types.map(at => <option key={at.type} value={at.type}>{at.type}</option>)}
                </select>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={onCancel} style={{ padding: '9px 16px', background: '#fff', border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer' }}>Cancel</button>
                <button onClick={submit} disabled={saving || !name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#111827', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer', opacity: saving || !name ? 0.6 : 1 }}>
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
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 10, marginBottom: 8, background: '#fff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <strong style={{ fontSize: 13 }}>{action.type}</strong>
                <button onClick={onRemove} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9ca3af' }}><Trash2 size={14} /></button>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
                {Object.entries(hint).map(([k, desc]) => (
                    <div key={k}>
                        <input style={{ ...input, height: 32 }} value={action.params[k] ?? ''} placeholder={`${k} — ${desc}`}
                            onChange={e => setParam(k, e.target.value)} />
                    </div>
                ))}
            </div>
            {sampleFields.length > 0 && (
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '6px 0 0' }}>
                    Templates: {sampleFields.map(f => `{{${f}}}`).join(' ')}
                </p>
            )}
        </div>
    );
}

export default RuleEditor;
