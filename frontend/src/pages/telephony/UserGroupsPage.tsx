import { useState, useEffect } from 'react';
import { Plus, Users, Phone, Calendar, Play, Pencil, X, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

// ── Types (kept local, matches API response) ─────────────────────────────────
interface ScheduleDay { day: string; open: string; close: string }
interface UserGroupData {
    id: string;
    name: string;
    desc: string;
    strategy: string;
    members: { id: string; name: string; status: string }[];
    numbers: { id: string; number: string; friendly_name: string }[];
    schedule: { timezone: string; hours: ScheduleDay[] };
    flow: { id: string; status: 'draft' | 'published'; updated_at: string; graph: unknown } | null;
}
const STATUS_COLORS: Record<string, { bg: string; dot: string }> = {
    available: { bg: '#d1fae5', dot: '#10b981' },
    on_call: { bg: '#dbeafe', dot: '#3b82f6' },
    away: { bg: '#fef3c7', dot: '#f59e0b' },
    offline: { bg: '#f3f4f6', dot: '#9ca3af' },
};

import { authedFetch } from '../../services/apiClient';

// ── Modal backdrop ───────────────────────────────────────────────────────────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
    return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
            onClick={onClose}>
            <div style={{ background: '#fff', borderRadius: 14, width: 600, maxHeight: '85vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}
                onClick={e => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                    <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{title}</h2>
                    <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4 }}><X size={18} /></button>
                </div>
                <div style={{ padding: '16px 20px' }}>{children}</div>
            </div>
        </div>
    );
}

// ── Constants ────────────────────────────────────────────────────────────────
// Agents and phone numbers for form dropdowns — loaded from API
let _allAgents: { id: string; name: string }[] = [];
let _allNumbers: { id: string; number: string; friendly_name: string }[] = [];

const RING_STRATEGIES: Record<string, string> = {
    'Round Robin': 'Distributes calls evenly across agents in rotation',
    'Simultaneous': 'Rings all available agents at the same time',
    'Most Idle': 'Routes to the agent who has been idle the longest',
    'Sequential': 'Rings agents in a fixed order, first available answers',
    'Weighted': 'Routes based on assigned weights (skill or priority)',
};
const DEFAULT_HOURS: ScheduleDay[] = [
    { day: 'Mon', open: '09:00', close: '17:00' }, { day: 'Tue', open: '09:00', close: '17:00' },
    { day: 'Wed', open: '09:00', close: '17:00' }, { day: 'Thu', open: '09:00', close: '17:00' },
    { day: 'Fri', open: '09:00', close: '17:00' }, { day: 'Sat', open: 'Closed', close: '' },
    { day: 'Sun', open: 'Closed', close: '' },
];

// ── 30-minute time slot options (12h AM/PM ↔ 24h) ───────────────────────────
const TIME_OPTIONS: { value: string; label: string }[] = [];
for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        const ampm = h < 12 ? 'AM' : 'PM';
        const label = `${h12}:${m === 0 ? '00' : '30'} ${ampm}`;
        const value = `${String(h).padStart(2, '0')}:${m === 0 ? '00' : '30'}`;
        TIME_OPTIONS.push({ value, label });
    }
}

/** Snap a 24h time string to the nearest 30-min slot */
function snapTo30(time: string): string {
    const [hh, mm] = time.split(':').map(Number);
    const snappedMin = mm < 15 ? 0 : mm < 45 ? 30 : 0;
    const snappedHour = mm >= 45 ? (hh + 1) % 24 : hh;
    return `${String(snappedHour).padStart(2, '0')}:${snappedMin === 0 ? '00' : '30'}`;
}

const sectionLabel = { fontSize: 12, fontWeight: 600 as const, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.05em', marginBottom: 10, display: 'flex', alignItems: 'center' as const, gap: 6 };

// ── Unified Group Form Modal ─────────────────────────────────────────────────
function GroupFormModal({ group, onClose }: { group: UserGroupData | null; onClose: () => void }) {
    const isNew = !group;
    const [name, setName] = useState(group?.name || '');
    const [members, setMembers] = useState<string[]>(group?.members.map(m => m.id) || []);
    const [nums, setNums] = useState<string[]>(group?.numbers.map(n => n.id) || []);
    const [strategy, setStrategy] = useState(group?.strategy || 'Round Robin');
    const [hours, setHours] = useState<ScheduleDay[]>(group ? [...group.schedule.hours] : [...DEFAULT_HOURS]);

    const availableAgents = _allAgents.filter((a: { id: string }) => !members.includes(a.id));
    const availableNums = _allNumbers.filter((n: { id: string }) => !nums.includes(n.id));

    const toggleDay = (i: number) => {
        setHours(h => h.map((d, idx) => idx === i ? (d.open === 'Closed' ? { ...d, open: '09:00', close: '17:00' } : { ...d, open: 'Closed', close: '' }) : d));
    };
    const setTime = (i: number, field: 'open' | 'close', val: string) => {
        setHours(h => h.map((d, idx) => idx === i ? { ...d, [field]: val } : d));
    };

    return (
        <Modal title={isNew ? 'New Group' : `Edit Group — ${group.name}`} onClose={onClose}>
            {/* Group Name */}
            <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 6 }}>Group Name</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Enter group name..."
                    style={{ width: '100%', padding: '8px 12px', fontSize: 14, fontWeight: 500, border: '1px solid #d1d5db', borderRadius: 8, outline: 'none', color: '#111', boxSizing: 'border-box' }}
                    autoFocus={isNew} />
            </div>

            <div style={{ height: 1, background: '#e5e7eb', margin: '0 -20px 20px' }} />

            {/* Members */}
            <div style={{ marginBottom: 20 }}>
                <div style={sectionLabel}><Users size={13} />Members ({members.length})</div>
                {members.map(id => {
                    const a = _allAgents.find((x: { id: string }) => x.id === id);
                    return (
                        <div key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
                            <span style={{ fontSize: 13, fontWeight: 500 }}>{a?.name}</span>
                            <button onClick={() => setMembers(m => m.filter(x => x !== id))}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 4 }}>
                                <Trash2 size={14} />
                            </button>
                        </div>
                    );
                })}
                {availableAgents.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                        {availableAgents.map(a => (
                            <button key={a.id} onClick={() => setMembers(m => [...m, a.id])}
                                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: 12, fontWeight: 500, background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', color: '#374151' }}>
                                <Plus size={12} />{a.name}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <div style={{ height: 1, background: '#e5e7eb', margin: '0 -20px 20px' }} />

            {/* Numbers + Ring Strategy */}
            <div style={{ marginBottom: 20 }}>
                <div style={sectionLabel}><Phone size={13} />Numbers ({nums.length})</div>
                {/* Ring Strategy */}
                <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>Ring Strategy</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {Object.entries(RING_STRATEGIES).map(([s, tip]) => (
                            <button key={s} onClick={() => setStrategy(s)} title={tip}
                                style={{ padding: '4px 10px', fontSize: 11, fontWeight: strategy === s ? 600 : 400, background: strategy === s ? '#6366f1' : '#f3f4f6', color: strategy === s ? '#fff' : '#374151', border: strategy === s ? 'none' : '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer' }}>
                                {s}
                            </button>
                        ))}
                    </div>
                </div>
                {nums.length === 0 && <div style={{ fontSize: 12, color: '#ef4444', padding: '4px 0' }}>No numbers assigned — calls won't reach this group</div>}
                {nums.map(id => {
                    const n = _allNumbers.find((x: { id: string }) => x.id === id);
                    return (
                        <div key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <Phone size={13} style={{ color: '#6366f1' }} />
                                <span style={{ fontSize: 13, fontWeight: 500 }}>{n?.number}</span>
                                <span style={{ fontSize: 11, color: '#9ca3af' }}>{n?.friendly_name}</span>
                            </div>
                            <button onClick={() => setNums(m => m.filter(x => x !== id))}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 4 }}>
                                <Trash2 size={14} />
                            </button>
                        </div>
                    );
                })}
                {availableNums.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                        {availableNums.map(n => (
                            <button key={n.id} onClick={() => setNums(m => [...m, n.id])}
                                style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 10px', marginBottom: 4, fontSize: 12, fontWeight: 500, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', color: '#374151', textAlign: 'left' }}>
                                <Plus size={12} style={{ color: '#6366f1' }} />{n.number} <span style={{ color: '#9ca3af' }}>· {n.friendly_name}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <div style={{ height: 1, background: '#e5e7eb', margin: '0 -20px 20px' }} />

            {/* Business Hours */}
            <div style={{ marginBottom: 8 }}>
                <div style={sectionLabel}><Calendar size={13} />Business Hours</div>
                {hours.map((h, i) => {
                    const isOpen = h.open !== 'Closed';
                    return (
                        <div key={h.day} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                            <span style={{ width: 36, fontSize: 13, fontWeight: 600, color: '#374151' }}>{h.day}</span>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', minWidth: 56 }}>
                                <input type="checkbox" checked={isOpen} onChange={() => toggleDay(i)}
                                    style={{ width: 15, height: 15, accentColor: '#6366f1' }} />
                                <span style={{ fontSize: 11, color: isOpen ? '#22c55e' : '#9ca3af', fontWeight: 600 }}>{isOpen ? 'Open' : 'Off'}</span>
                            </label>
                            {isOpen && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <select value={snapTo30(h.open)} onChange={e => setTime(i, 'open', e.target.value)}
                                        style={{ minWidth: 100, maxWidth: 100, height: 36, padding: '0 15px 0 6px', fontSize: 14, fontWeight: 600, background: 'rgba(9,30,66,0.04)', border: '1px solid #f6f6f6', borderRadius: 8, color: '#0c0c0d', cursor: 'pointer', appearance: 'auto' }}>
                                        {TIME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                    </select>
                                    <span style={{ color: '#a3a3a3', fontSize: 14 }}>—</span>
                                    <select value={snapTo30(h.close)} onChange={e => setTime(i, 'close', e.target.value)}
                                        style={{ minWidth: 100, maxWidth: 100, height: 36, padding: '0 15px 0 6px', fontSize: 14, fontWeight: 600, background: 'rgba(9,30,66,0.04)', border: '1px solid #f6f6f6', borderRadius: 8, color: '#0c0c0d', cursor: 'pointer', appearance: 'auto' }}>
                                        {TIME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                    </select>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
                <button onClick={onClose} style={{ padding: '8px 16px', fontSize: 13, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}>Cancel</button>
                <button onClick={onClose} disabled={!name.trim()} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: name.trim() ? '#6366f1' : '#d1d5db', color: '#fff', border: 'none', borderRadius: 8, cursor: name.trim() ? 'pointer' : 'default' }}>{isNew ? 'Create Group' : 'Save Changes'}</button>
            </div>
        </Modal>
    );
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function UserGroupsPage() {
    const navigate = useNavigate();
    const [editGroup, setEditGroup] = useState<UserGroupData | null | 'new'>(null);
    const [groups, setGroups] = useState<UserGroupData[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchGroups = async () => {
        try {
            const res = await authedFetch('/api/user-groups');
            const json = await res.json();
            if (json.ok) setGroups(json.data);
        } catch { /* fallback: empty */ }
        setLoading(false);
    };

    useEffect(() => {
        fetchGroups();
        // Load agents from existing /api/users endpoint
        authedFetch('/api/users')
            .then(r => r.json())
            .then(j => { if (j.ok && j.data) _allAgents = j.data.map((u: any) => ({ id: String(u.id), name: u.name || u.email })); })
            .catch(() => { });
        // Load phone numbers from existing API
        authedFetch('/api/phone-numbers')
            .then(r => r.json())
            .then(j => { if (j.ok && j.data) _allNumbers = j.data.map((n: any) => ({ id: String(n.id), number: n.number, friendly_name: n.friendly_name || '' })); })
            .catch(() => { });
    }, []);

    return (
        <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div>
                    <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>User Groups</h1>
                    <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Agent groups with numbers, schedules & call flows</p>
                </div>
                <button onClick={() => setEditGroup('new')} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
                    <Plus size={15} />New Group
                </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {loading ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div> : groups.length === 0 ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No groups yet. Click "New Group" to get started.</div> : null}
                {groups.map(g => (
                    <div key={g.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, overflow: 'hidden', transition: 'box-shadow 0.15s' }}
                        onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.07)')}
                        onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}>

                        {/* Header */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #f3f4f6' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <div style={{ width: 40, height: 40, borderRadius: 10, background: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <Users size={18} style={{ color: '#f59e0b' }} />
                                </div>
                                <div style={{ fontSize: 16, fontWeight: 700, color: '#111' }}>{g.name}</div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <button onClick={(e) => { e.stopPropagation(); setEditGroup(g); }}
                                    style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', fontSize: 12, fontWeight: 500, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}>
                                    <Pencil size={13} />Edit
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); navigate(`/settings/telephony/user-groups/${g.id}/flow`); }}
                                    style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px', fontSize: 13, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
                                    <Play size={13} />Flow Builder
                                </button>
                            </div>
                        </div>

                        {/* Body */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
                            {/* Left: Members + Numbers stacked */}
                            <div style={{ borderRight: '1px solid #f3f4f6' }}>
                                {/* Members */}
                                <div style={{ padding: '16px 20px', borderBottom: '1px solid #f3f4f6' }}>
                                    <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <Users size={13} />Members ({g.members.length})
                                    </div>
                                    {g.members.map(m => {
                                        const sc = STATUS_COLORS[m.status] || STATUS_COLORS.offline;
                                        return (
                                            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                                                <div style={{ width: 8, height: 8, borderRadius: '50%', background: sc.dot, flexShrink: 0 }} />
                                                <span style={{ fontSize: 13, fontWeight: 500, color: '#111', flex: 1 }}>{m.name}</span>
                                                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, background: sc.bg, color: sc.dot, fontWeight: 600 }}>{m.status.replace('_', ' ')}</span>
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* Numbers */}
                                <div style={{ padding: '16px 20px' }}>
                                    <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <Phone size={13} />Numbers ({g.numbers.length})
                                        <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: '#ede9fe', color: '#6366f1', textTransform: 'none', letterSpacing: 0 }}>{g.strategy}</span>
                                    </div>
                                    {g.numbers.length === 0 && <div style={{ fontSize: 12, color: '#ef4444' }}>No numbers — calls won't reach this group</div>}
                                    {g.numbers.map(n => (
                                        <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                                            <Phone size={13} style={{ color: '#6366f1', flexShrink: 0 }} />
                                            <span style={{ fontSize: 13, fontWeight: 500, color: '#111', flex: 1 }}>{n.number}</span>
                                            <span style={{ fontSize: 12, color: '#9ca3af' }}>{n.friendly_name}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Right: Schedule */}
                            <div style={{ padding: '16px 20px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                                    <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <Calendar size={13} />Business Hours
                                    </div>
                                    <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 500 }}>{g.schedule.timezone.replace('_', ' ')}</span>
                                </div>
                                {g.schedule.hours.map(h => {
                                    const isOpen = h.open !== 'Closed';
                                    return (
                                        <div key={h.day} style={{ display: 'flex', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
                                            <span style={{ width: 36, fontSize: 13, fontWeight: 600, color: '#374151' }}>{h.day}</span>
                                            <div style={{ width: 6, height: 6, borderRadius: '50%', background: isOpen ? '#22c55e' : '#e5e7eb', marginRight: 8, flexShrink: 0 }} />
                                            {isOpen
                                                ? <span style={{ fontSize: 13, color: '#374151' }}>{h.open} – {h.close}</span>
                                                : <span style={{ fontSize: 13, color: '#9ca3af' }}>Closed</span>
                                            }
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Unified Group Form Modal */}
            {editGroup !== null && (
                <GroupFormModal
                    group={editGroup === 'new' ? null : editGroup}
                    onClose={() => setEditGroup(null)}
                />
            )}
        </div>
    );
}
