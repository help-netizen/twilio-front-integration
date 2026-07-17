import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Settings, GitBranch, Play, Phone, Calendar, Clock, Plus, Trash2, AlertTriangle, CheckCircle } from 'lucide-react';
import { NODE_KIND_META, type CallFlowNodeKind } from '../../types/telephony';
import { authedFetch } from '../../services/apiClient';
import { useRealtimeEvents } from '../../hooks/useRealtimeEvents';
import { getScheduleStatus } from './scheduleStatus';

const STATUS_COLORS: Record<string, { bg: string; dot: string }> = {
    available: { bg: '#d1fae5', dot: '#10b981' },
    on_call: { bg: '#dbeafe', dot: '#3b82f6' },
    offline: { bg: '#f3f4f6', dot: '#9ca3af' },
};

interface UserGroupDetail {
    id: string;
    name: string;
    desc: string;
    strategy: string;
    members: { id: string; name: string; status: string }[];
    numbers: { id: string; number: string; friendly_name: string }[];
    schedule: { timezone: string; hours: { day: string; open: string; close: string }[] };
    flow: { id: string; updated_at: string; graph: { states: any[]; transitions: any[] } } | null;
}

interface AgentOption {
    id: string;
    name: string;
}

interface NumberOption {
    id: string;
    number: string;
    friendly_name: string;
    group_id?: string | null;
}

export default function UserGroupDetailPage() {
    const { groupId } = useParams<{ groupId: string }>();
    const navigate = useNavigate();
    const [group, setGroup] = useState<UserGroupDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [editingName, setEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState('');
    const [savingName, setSavingName] = useState(false);
    const [allAgents, setAllAgents] = useState<AgentOption[]>([]);
    const [allNumbers, setAllNumbers] = useState<NumberOption[]>([]);
    const [savingInline, setSavingInline] = useState(false);

    const loadGroup = async () => {
        if (!groupId) return;
        setLoading(true);
        try {
            const res = await authedFetch(`/api/user-groups/${groupId}`);
            const data = await res.json();
            if (data.ok) {
                setGroup(data.data);
                setNameDraft(data.data.name || '');
            } else {
                setGroup(null);
            }
        } catch {
            setGroup(null);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { loadGroup(); }, [groupId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        let cancelled = false;
        Promise.all([
            authedFetch('/api/users').then(r => r.json()).catch(() => ({ users: [], data: [] })),
            authedFetch('/api/phone-numbers').then(r => r.json()).catch(() => ({ data: [] })),
        ]).then(([usersJson, numbersJson]) => {
            if (cancelled) return;
            const users = usersJson.users || usersJson.data || [];
            const numbers = numbersJson.data || numbersJson.numbers || [];
            setAllAgents(users.map((user: any) => ({ id: String(user.id), name: user.full_name || user.name || user.email || String(user.id) })));
            setAllNumbers(numbers.map((number: any) => ({
                id: String(number.id),
                number: number.number || number.phone_number,
                friendly_name: number.friendly_name || '',
                group_id: number.group_id || null,
            })).filter((number: NumberOption) => Boolean(number.number)));
        });
        return () => { cancelled = true; };
    }, []);

    useRealtimeEvents({
        onGenericEvent: (eventType, data) => {
            if (eventType !== 'agent.status.changed' || !groupId || !Array.isArray(data.groupIds) || !data.groupIds.includes(groupId)) return;
            setGroup(current => current ? {
                ...current,
                members: current.members.map(member => member.id === data.userId ? { ...member, status: data.status } : member),
            } : current);
        },
    });

    const saveName = async () => {
        if (!groupId || !nameDraft.trim() || !group) return;
        setSavingName(true);
        try {
            await saveGroupPatch({ name: nameDraft.trim() });
            setEditingName(false);
        } finally {
            setSavingName(false);
        }
    };

    const saveGroupPatch = async (patch: { name?: string; members?: string[]; numbers?: { number: string; friendly_name?: string }[] }) => {
        if (!groupId || !group) return;
        setSavingInline(true);
        try {
            const payload = {
                name: patch.name ?? group.name,
                members: patch.members ?? group.members.map(member => member.id),
                numbers: patch.numbers ?? group.numbers.map(number => ({ number: number.number, friendly_name: number.friendly_name })),
                hours: group.schedule.hours,
            };
            const res = await authedFetch(`/api/user-groups/${groupId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to update group');
            setGroup(data.data);
            setNameDraft(data.data.name || '');
        } catch (err) {
            console.error('[UserGroupDetail] inline update failed:', err);
            alert('Failed to update group');
        } finally {
            setSavingInline(false);
        }
    };

    const addMember = (agent: AgentOption) => {
        if (!group) return;
        saveGroupPatch({ members: [...group.members.map(member => member.id), agent.id] });
    };

    const removeMember = (agentId: string) => {
        if (!group) return;
        saveGroupPatch({ members: group.members.map(member => member.id).filter(id => id !== agentId) });
    };

    const addNumber = (number: NumberOption) => {
        if (!group) return;
        saveGroupPatch({
            numbers: [
                ...group.numbers.map(n => ({ number: n.number, friendly_name: n.friendly_name })),
                { number: number.number, friendly_name: number.friendly_name },
            ],
        });
    };

    const removeNumber = (numberValue: string) => {
        if (!group) return;
        saveGroupPatch({
            numbers: group.numbers
                .filter(number => number.number !== numberValue)
                .map(number => ({ number: number.number, friendly_name: number.friendly_name })),
        });
    };

    if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>;
    if (!group) return <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Group not found</div>;

    const flowStates = group.flow?.graph?.states || [];
    const flowTransitions = group.flow?.graph?.transitions || [];
    const reachable = group.members.some(member => member.status === 'available');
    const scheduleStatus = getScheduleStatus(group.schedule);
    const availableAgents = allAgents.filter(agent => !group.members.some(member => member.id === agent.id));
    const availableNumbers = allNumbers.filter(number => !number.group_id && !group.numbers.some(current => current.number === number.number));

    return (
        <div style={{ padding: 24 }}>
            <button onClick={() => navigate('/settings/telephony/user-groups')} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 16 }}>
                <ArrowLeft size={14} />Back to User Groups
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                {editingName ? (
                    <>
                        <input value={nameDraft} onChange={e => setNameDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false); }} style={{ fontSize: 20, fontWeight: 700, border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 8px' }} autoFocus />
                        <button onClick={saveName} disabled={savingName || !nameDraft.trim()} style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>{savingName ? 'Saving...' : 'Save'}</button>
                    </>
                ) : (
                    <>
                        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{group.name}</h1>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 10, background: reachable ? '#d1fae5' : '#fef2f2', color: reachable ? '#047857' : '#b91c1c' }}>
                            {reachable ? <CheckCircle size={12} /> : <AlertTriangle size={12} />}
                            {reachable ? 'Reachable' : 'No available agents'}
                        </span>
                        <button onClick={() => setEditingName(true)} style={{ padding: '4px 10px', fontSize: 11, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                            <Settings size={12} />Edit
                        </button>
                    </>
                )}
            </div>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 20px' }}>
                {group.desc} · Ring strategy: <strong>Simultaneous</strong>
            </p>
            {!reachable && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', marginBottom: 16, border: '1px solid #fecaca', borderRadius: 8, background: '#fef2f2', color: '#991b1b', fontSize: 13, fontWeight: 600 }}>
                    <AlertTriangle size={15} />Calls will go to voicemail until at least one group agent is available.
                </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Users size={15} />Members ({group.members.length})
                    </div>
                    {group.members.map(m => {
                        const sc = STATUS_COLORS[m.status] || STATUS_COLORS.offline;
                        return (
                            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid #f3f4f6' }}>
                                <div style={{ width: 8, height: 8, borderRadius: '50%', background: sc.dot }} />
                                <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{m.name}</span>
                                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: sc.bg, color: sc.dot, fontWeight: 600 }}>{m.status.replace('_', ' ')}</span>
                                <button disabled={savingInline} onClick={() => removeMember(m.id)} title="Remove member" style={{ background: 'none', border: 'none', cursor: savingInline ? 'default' : 'pointer', color: '#ef4444', padding: 4 }}>
                                    <Trash2 size={13} />
                                </button>
                            </div>
                        );
                    })}
                    {availableAgents.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                            {availableAgents.map(agent => (
                                <button key={agent.id} disabled={savingInline} onClick={() => addMember(agent)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 9px', fontSize: 12, fontWeight: 600, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: savingInline ? 'default' : 'pointer' }}>
                                    <Plus size={12} />{agent.name}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Phone size={15} style={{ color: '#10b981' }} />Assigned Numbers ({group.numbers.length})
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>Inbound calls on these numbers route through this group's flow</div>
                    {group.numbers.map(n => (
                        <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                            <Phone size={13} style={{ color: '#6366f1' }} />
                            <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{n.number}</span>
                            <span style={{ fontSize: 11, color: '#6b7280' }}>{n.friendly_name}</span>
                            <button disabled={savingInline} onClick={() => removeNumber(n.number)} title="Remove number" style={{ background: 'none', border: 'none', cursor: savingInline ? 'default' : 'pointer', color: '#ef4444', padding: 4 }}>
                                <Trash2 size={13} />
                            </button>
                        </div>
                    ))}
                    {availableNumbers.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                            {availableNumbers.map(number => (
                                <button key={number.id} disabled={savingInline} onClick={() => addNumber(number)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 9px', fontSize: 12, fontWeight: 600, background: '#f9fafb', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: savingInline ? 'default' : 'pointer' }}>
                                    <Plus size={12} />{number.friendly_name || number.number}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Calendar size={15} style={{ color: '#3b82f6' }} />Schedule
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: scheduleStatus.isOpen ? '#d1fae5' : '#f3f4f6', color: scheduleStatus.isOpen ? '#047857' : '#6b7280' }}>{scheduleStatus.shortLabel}</span>
                            <span style={{ fontSize: 11, color: '#6b7280' }}>{group.schedule.timezone}</span>
                        </div>
                    </div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>{scheduleStatus.label}</div>
                    {group.schedule.hours.map(h => (
                        <div key={h.day} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #f3f4f6', fontSize: 12 }}>
                            <span style={{ fontWeight: 500, minWidth: 40 }}>{h.day}</span>
                            <span style={{ color: h.open === 'Closed' ? '#ef4444' : '#374151', display: 'flex', alignItems: 'center', gap: 4 }}>
                                {h.open === 'Closed' ? 'Closed' : <><Clock size={10} />{h.open} - {h.close}</>}
                            </span>
                        </div>
                    ))}
                </div>

                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <GitBranch size={15} style={{ color: '#6366f1' }} />Call Flow
                        </div>
                        <button
                            onClick={() => navigate(`/settings/telephony/user-groups/${groupId}/flow`)}
                            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', fontSize: 12, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
                        >
                            <Play size={12} />Open Builder
                        </button>
                    </div>

                    {group.flow ? (
                        <>
                            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
                                Updated {new Date(group.flow.updated_at).toLocaleString()} · {flowStates.length} states · {flowTransitions.length} transitions
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                {flowStates.map(s => {
                                    const meta = NODE_KIND_META[s.kind as CallFlowNodeKind] || { icon: '?', label: s.kind, color: '#6b7280' };
                                    return (
                                        <div key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 12, border: '1px solid #e5e7eb' }}>
                                            <span>{meta.icon}</span>
                                            <span style={{ fontWeight: 500 }}>{s.name}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    ) : <div style={{ fontSize: 12, color: '#9ca3af' }}>No flow configured</div>}
                </div>
            </div>
        </div>
    );
}
