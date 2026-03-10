import { useState } from 'react';
import { Plus, Users, Phone, Calendar, Play, Pencil, X, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { USER_GROUPS, STATUS_COLORS, type UserGroupData, type ScheduleDay } from '../../data/userGroupsMock';

// ── Modal backdrop ───────────────────────────────────────────────────────────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
    return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
            onClick={onClose}>
            <div style={{ background: '#fff', borderRadius: 14, width: 520, maxHeight: '80vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}
                onClick={e => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
                    <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{title}</h2>
                    <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4 }}><X size={18} /></button>
                </div>
                <div style={{ padding: '16px 20px' }}>{children}</div>
            </div>
        </div>
    );
}

// ── Edit Members Modal ───────────────────────────────────────────────────────
const ALL_AGENTS = [
    { id: 'ag-1', name: 'Sarah Johnson' }, { id: 'ag-2', name: 'Mike Chen' },
    { id: 'ag-3', name: 'Lisa Park' }, { id: 'ag-4', name: 'Tom Rivera' },
    { id: 'ag-5', name: 'Alex Kim' }, { id: 'ag-6', name: 'Emma Davis' },
];

function EditMembersModal({ group, onClose }: { group: UserGroupData; onClose: () => void }) {
    const [members, setMembers] = useState(group.members.map(m => m.id));
    const available = ALL_AGENTS.filter(a => !members.includes(a.id));
    return (
        <Modal title={`Members — ${group.name}`} onClose={onClose}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>Current members ({members.length})</div>
            {members.map(id => {
                const a = ALL_AGENTS.find(x => x.id === id);
                return (
                    <div key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{a?.name}</span>
                        <button onClick={() => setMembers(m => m.filter(x => x !== id))}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 4 }}>
                            <Trash2 size={14} />
                        </button>
                    </div>
                );
            })}
            {available.length > 0 && (
                <>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 16, marginBottom: 8 }}>Add members</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {available.map(a => (
                            <button key={a.id} onClick={() => setMembers(m => [...m, a.id])}
                                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', fontSize: 12, fontWeight: 500, background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', color: '#374151' }}>
                                <Plus size={12} />{a.name}
                            </button>
                        ))}
                    </div>
                </>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
                <button onClick={onClose} style={{ padding: '8px 16px', fontSize: 13, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}>Cancel</button>
                <button onClick={onClose} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>Save</button>
            </div>
        </Modal>
    );
}

// ── Edit Numbers Modal ───────────────────────────────────────────────────────
const ALL_NUMBERS = [
    { id: 'pn-1', number: '+1 (617) 555-0101', friendly_name: 'Main Line' },
    { id: 'pn-2', number: '+1 (617) 555-0102', friendly_name: 'Sales Line' },
    { id: 'pn-3', number: '+1 (617) 555-0103', friendly_name: 'Support Line' },
    { id: 'pn-4', number: '+1 (617) 555-0104', friendly_name: 'Billing Line' },
    { id: 'pn-5', number: '+1 (617) 555-0105', friendly_name: 'Emergency' },
];

const RING_STRATEGIES = ['Round Robin', 'Simultaneous', 'Most Idle', 'Sequential', 'Weighted'];

function EditNumbersModal({ group, onClose }: { group: UserGroupData; onClose: () => void }) {
    const [nums, setNums] = useState(group.numbers.map(n => n.id));
    const [strategy, setStrategy] = useState(group.strategy);
    const available = ALL_NUMBERS.filter(n => !nums.includes(n.id));
    return (
        <Modal title={`Numbers & Ring Strategy — ${group.name}`} onClose={onClose}>
            {/* Ring Strategy */}
            <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #e5e7eb' }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>Ring Strategy</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {RING_STRATEGIES.map(s => (
                        <button key={s} onClick={() => setStrategy(s)}
                            style={{ padding: '5px 12px', fontSize: 12, fontWeight: strategy === s ? 600 : 400, background: strategy === s ? '#6366f1' : '#f3f4f6', color: strategy === s ? '#fff' : '#374151', border: strategy === s ? 'none' : '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer' }}>
                            {s}
                        </button>
                    ))}
                </div>
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>Assigned numbers ({nums.length})</div>
            {nums.length === 0 && <div style={{ fontSize: 13, color: '#ef4444', padding: '8px 0' }}>No numbers assigned — calls won't reach this group</div>}
            {nums.map(id => {
                const n = ALL_NUMBERS.find(x => x.id === id);
                return (
                    <div key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
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
            {available.length > 0 && (
                <>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 16, marginBottom: 8 }}>Available numbers</div>
                    {available.map(n => (
                        <button key={n.id} onClick={() => setNums(m => [...m, n.id])}
                            style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '8px 10px', marginBottom: 4, fontSize: 12, fontWeight: 500, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', color: '#374151', textAlign: 'left' }}>
                            <Plus size={12} style={{ color: '#6366f1' }} />{n.number} <span style={{ color: '#9ca3af' }}>· {n.friendly_name}</span>
                        </button>
                    ))}
                </>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
                <button onClick={onClose} style={{ padding: '8px 16px', fontSize: 13, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}>Cancel</button>
                <button onClick={onClose} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>Save</button>
            </div>
        </Modal>
    );
}

// ── Edit Schedule Modal ──────────────────────────────────────────────────────
function EditScheduleModal({ group, onClose }: { group: UserGroupData; onClose: () => void }) {
    const [hours, setHours] = useState<ScheduleDay[]>([...group.schedule.hours]);
    const toggle = (i: number) => {
        setHours(h => h.map((d, idx) => idx === i ? (d.open === 'Closed' ? { ...d, open: '09:00', close: '17:00' } : { ...d, open: 'Closed', close: '' }) : d));
    };
    const setTime = (i: number, field: 'open' | 'close', val: string) => {
        setHours(h => h.map((d, idx) => idx === i ? { ...d, [field]: val } : d));
    };
    return (
        <Modal title={`Business Hours — ${group.name}`} onClose={onClose}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>Timezone: {group.schedule.timezone.replace('_', ' ')}</div>
            {hours.map((h, i) => {
                const isOpen = h.open !== 'Closed';
                return (
                    <div key={h.day} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid #f3f4f6' }}>
                        <span style={{ width: 40, fontSize: 14, fontWeight: 600, color: '#374151' }}>{h.day}</span>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', minWidth: 60 }}>
                            <input type="checkbox" checked={isOpen} onChange={() => toggle(i)}
                                style={{ width: 16, height: 16, accentColor: '#6366f1' }} />
                            <span style={{ fontSize: 12, color: isOpen ? '#22c55e' : '#9ca3af', fontWeight: 600 }}>{isOpen ? 'Open' : 'Off'}</span>
                        </label>
                        {isOpen && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <input type="time" value={h.open} onChange={e => setTime(i, 'open', e.target.value)}
                                    style={{ padding: '4px 8px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 6, color: '#374151' }} />
                                <span style={{ color: '#9ca3af' }}>→</span>
                                <input type="time" value={h.close} onChange={e => setTime(i, 'close', e.target.value)}
                                    style={{ padding: '4px 8px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 6, color: '#374151' }} />
                            </div>
                        )}
                    </div>
                );
            })}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
                <button onClick={onClose} style={{ padding: '8px 16px', fontSize: 13, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}>Cancel</button>
                <button onClick={onClose} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>Save</button>
            </div>
        </Modal>
    );
}

// ── Pencil button helper ─────────────────────────────────────────────────────
function PenBtn({ onClick }: { onClick: () => void }) {
    return (
        <button onClick={e => { e.stopPropagation(); onClick(); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 2, borderRadius: 4, transition: 'color 0.1s' }}
            onMouseEnter={e => (e.currentTarget.style.color = '#6366f1')}
            onMouseLeave={e => (e.currentTarget.style.color = '#9ca3af')}>
            <Pencil size={13} />
        </button>
    );
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function UserGroupsPage() {
    const navigate = useNavigate();
    const [modal, setModal] = useState<{ type: 'members' | 'numbers' | 'schedule'; group: UserGroupData } | null>(null);

    return (
        <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div>
                    <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>User Groups</h1>
                    <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Agent groups with numbers, schedules & call flows</p>
                </div>
                <button style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
                    <Plus size={15} />New Group
                </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {USER_GROUPS.map(g => (
                    <div key={g.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, overflow: 'hidden', transition: 'box-shadow 0.15s' }}
                        onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.07)')}
                        onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}>

                        {/* Header — name + Flow Builder only */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #f3f4f6' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <div style={{ width: 40, height: 40, borderRadius: 10, background: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <Users size={18} style={{ color: '#f59e0b' }} />
                                </div>
                                <div>
                                    <div style={{ fontSize: 16, fontWeight: 700, color: '#111' }}>{g.name}</div>
                                </div>
                            </div>
                            <button onClick={(e) => { e.stopPropagation(); navigate(`/settings/telephony/user-groups/${g.id}/flow`); }}
                                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px', fontSize: 13, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
                                <Play size={13} />Flow Builder
                            </button>
                        </div>

                        {/* Body */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
                            {/* Left: Members + Numbers stacked */}
                            <div style={{ borderRight: '1px solid #f3f4f6' }}>
                                {/* Members */}
                                <div style={{ padding: '16px 20px', borderBottom: '1px solid #f3f4f6' }}>
                                    <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <Users size={13} />Members ({g.members.length})
                                        <PenBtn onClick={() => setModal({ type: 'members', group: g })} />
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
                                        <PenBtn onClick={() => setModal({ type: 'numbers', group: g })} />
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
                                        <PenBtn onClick={() => setModal({ type: 'schedule', group: g })} />
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

            {/* Modals */}
            {modal?.type === 'members' && <EditMembersModal group={modal.group} onClose={() => setModal(null)} />}
            {modal?.type === 'numbers' && <EditNumbersModal group={modal.group} onClose={() => setModal(null)} />}
            {modal?.type === 'schedule' && <EditScheduleModal group={modal.group} onClose={() => setModal(null)} />}
        </div>
    );
}
