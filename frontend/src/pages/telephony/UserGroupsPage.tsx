import { useState, useEffect } from 'react';
import { Plus, Users, Phone, Calendar, Play, Pencil, Trash2, Shuffle, Eye } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useRealtimeEvents } from '../../hooks/useRealtimeEvents';
import { useIsMobile } from '../../hooks/useIsMobile';
import { getScheduleStatus } from './scheduleStatus';
import { BottomSheet } from '../../components/ui/BottomSheet';
import { Dialog, DialogContent, DialogPanelHeader, DialogTitle, DialogDescription, DialogBody, DialogPanelFooter } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { SettingsPageShell } from '../../components/settings/SettingsPageShell';

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
    flow: { id: string; status: 'active'; updated_at: string; graph: unknown } | null;
}
// UI-QA-001: chip text reuses `dot` — deep-tier hues so 11px text passes AA on the tint.
const STATUS_COLORS: Record<string, { bg: string; dot: string }> = {
    available: { bg: '#d1fae5', dot: '#047857' },
    on_call: { bg: '#dbeafe', dot: '#2F63D8' },
    away: { bg: '#fef3c7', dot: '#B45309' },
    offline: { bg: '#F0F0F0', dot: '#6E6E6E' },
};

import { authedFetch } from '../../services/apiClient';

// ── Modal shell ──────────────────────────────────────────────────────────────
// Mobile → canonical BottomSheet (grab handle + drag). Desktop → canonical
// right-side panel layer (DialogContent variant="panel", FORM-CANON), replacing
// the old hand-rolled centered card. Only the presentation switches; form logic
// is untouched.
function Modal({ title, footer, onClose, children }: { title: string; footer?: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
    const isMobile = useIsMobile();

    if (isMobile) {
        return (
            <BottomSheet open onClose={onClose} size="full" title={title} footer={footer} bodyClassName="space-y-6">
                {children}
            </BottomSheet>
        );
    }

    return (
        <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription className="sr-only">{title}</DialogDescription>
                </DialogPanelHeader>
                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">{children}</div>
                </DialogBody>
                {footer && <DialogPanelFooter>{footer}</DialogPanelFooter>}
            </DialogContent>
        </Dialog>
    );
}

// ── Constants ────────────────────────────────────────────────────────────────
// Agents and phone numbers for form dropdowns — loaded from API
let _allAgents: { id: string; name: string }[] = [];
let _allNumbers: { id: string; number: string; friendly_name: string }[] = [];

const RING_STRATEGIES: Record<string, string> = {
    'Simultaneous': 'Rings all available agents at the same time',
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

// Section label = canonical eyebrow (.blanc-eyebrow owns font/color); only the
// icon row layout stays inline.
const sectionLabel = { display: 'flex', alignItems: 'center' as const, gap: 6, marginBottom: 10 };

// ── Unified Group Form Modal ─────────────────────────────────────────────────
function GroupFormModal({ group, onClose }: { group: UserGroupData | null; onClose: () => void }) {
    const isMobile = useIsMobile();
    const isNew = !group;
    const [name, setName] = useState(group?.name || '');
    const [members, setMembers] = useState<string[]>(group?.members.map(m => m.id) || []);
    const [nums, setNums] = useState<string[]>(group?.numbers.map(n => n.id) || []);
    const [hours, setHours] = useState<ScheduleDay[]>(group ? [...group.schedule.hours] : [...DEFAULT_HOURS]);
    const [saving, setSaving] = useState(false);

    // Build a name map from the group's existing member data + _allAgents
    const memberNameMap = new Map<string, string>();
    group?.members.forEach(m => memberNameMap.set(m.id, m.name || m.id));
    _allAgents.forEach(a => { if (!memberNameMap.has(a.id)) memberNameMap.set(a.id, a.name); });

    // Merge group's original members into the agent pool so removed members can be re-added
    const allKnownAgents: { id: string; name: string }[] = [..._allAgents];
    group?.members.forEach(m => {
        if (!allKnownAgents.some(a => a.id === m.id)) {
            allKnownAgents.push({ id: m.id, name: m.name || m.id });
        }
    });

    const availableAgents = allKnownAgents.filter(a => !members.includes(a.id));
    const availableNums = _allNumbers.filter((n: { id: string }) => !nums.includes(n.id));

    const toggleDay = (i: number) => {
        setHours(h => h.map((d, idx) => idx === i ? (d.open === 'Closed' ? { ...d, open: '09:00', close: '17:00' } : { ...d, open: 'Closed', close: '' }) : d));
    };
    const setTime = (i: number, field: 'open' | 'close', val: string) => {
        setHours(h => h.map((d, idx) => idx === i ? { ...d, [field]: val } : d));
    };

    const handleSave = async () => {
        if (!name.trim()) return;
        setSaving(true);
        try {
            const payload = {
                name, strategy: 'Simultaneous', members, numbers: nums.map(id => {
                    const n = _allNumbers.find(x => x.id === id);
                    return n ? { number: n.number, friendly_name: n.friendly_name } : { number: id };
                }), hours
            };

            if (isNew) {
                await authedFetch('/api/user-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            } else {
                await authedFetch(`/api/user-groups/${group.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            }
            onClose(); // will trigger parent refetch
        } catch (err) {
            console.error('[UserGroups] Save failed:', err);
            alert('Failed to save group');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            title={isNew ? 'New Group' : `Edit Group — ${group.name}`}
            onClose={onClose}
            footer={
                <div className="flex items-center justify-end gap-3">
                    <Button variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button onClick={handleSave} disabled={!name.trim() || saving}>{saving ? 'Saving...' : isNew ? 'Create Group' : 'Save Changes'}</Button>
                </div>
            }
        >
            {/* Group Name */}
            <div>
                <div className="blanc-eyebrow" style={sectionLabel}><Pencil size={13} />Group Name</div>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Enter group name..."
                    style={{ width: '100%', padding: '8px 12px', fontSize: 14, fontWeight: 500, border: '1px solid var(--blanc-line-strong)', borderRadius: 8, outline: 'none', color: 'var(--blanc-ink-1)', boxSizing: 'border-box' }}
                    autoFocus={isNew} />
            </div>

            {/* Members */}
            <div>
                <div className="blanc-eyebrow" style={sectionLabel}><Users size={13} />Members ({members.length})</div>
                {members.map(id => {
                    const displayName = memberNameMap.get(id) || id;
                    return (
                        <div key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--blanc-line)' }}>
                            <span style={{ fontSize: 13, fontWeight: 500 }}>{displayName}</span>
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
                            <button key={a.id} onClick={() => { memberNameMap.set(a.id, a.name); setMembers(m => [...m, a.id]); }}
                                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: 12, fontWeight: 500, background: 'rgba(25,25,25,0.04)', border: '1px solid var(--blanc-line)', borderRadius: 6, cursor: 'pointer', color: 'var(--blanc-ink-1)' }}>
                                <Plus size={12} />{a.name}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Numbers */}
            <div>
                <div className="blanc-eyebrow" style={sectionLabel}><Phone size={13} />Numbers ({nums.length})</div>
                {nums.length === 0 && <div style={{ fontSize: 12, color: '#ef4444', padding: '4px 0' }}>No numbers assigned — calls won't reach this group</div>}
                {nums.map(id => {
                    const n = _allNumbers.find((x: { id: string }) => x.id === id);
                    return (
                        <div key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--blanc-line)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <Phone size={13} style={{ color: 'var(--blanc-accent)' }} />
                                <span style={{ fontSize: 13, fontWeight: 500 }}>{n?.friendly_name || n?.number}</span>
                            </div>
                            <button onClick={() => setNums(m => m.filter(x => x !== id))}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 4 }}>
                                <Trash2 size={14} />
                            </button>
                        </div>
                    );
                })}
                {availableNums.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                        {availableNums.map(n => (
                            <button key={n.id} onClick={() => setNums(m => [...m, n.id])}
                                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 12, fontWeight: 500, background: 'rgba(25,25,25,0.03)', border: '1px solid var(--blanc-line)', borderRadius: 6, cursor: 'pointer', color: 'var(--blanc-ink-1)' }}>
                                <Plus size={12} style={{ color: 'var(--blanc-accent)' }} />{n.friendly_name || n.number}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Ring Strategy */}
            <div>
                <div className="blanc-eyebrow" style={sectionLabel}><Shuffle size={13} />Ring Strategy</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {Object.entries(RING_STRATEGIES).map(([s, tip]) => (
                        <button key={s} type="button" title={tip}
                            style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600, background: 'var(--blanc-accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'default' }}>
                            {s}
                        </button>
                    ))}
                </div>
            </div>

            {/* Business Hours */}
            <div>
                <div className="blanc-eyebrow" style={sectionLabel}><Calendar size={13} />Business Hours</div>
                {hours.map((h, i) => {
                    const isOpen = h.open !== 'Closed';
                    // Mobile: stack the two time selects onto their own full-width row below the
                    // day + Open/Off toggle, so the row never overflows a narrow (375px) screen.
                    const timeSelectStyle: React.CSSProperties = {
                        flex: isMobile ? '1 1 0' : '0 0 auto',
                        minWidth: isMobile ? 0 : 100,
                        maxWidth: isMobile ? undefined : 100,
                        height: 40, padding: '0 10px 0 8px', fontSize: 14, fontWeight: 600,
                        background: 'var(--blanc-field)', border: '1px solid var(--blanc-line)', borderRadius: 8,
                        color: 'var(--blanc-ink-1)', cursor: 'pointer', appearance: 'auto' as const,
                    };
                    const timeRow = isOpen ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: isMobile ? '1 1 100%' : '0 0 auto', minWidth: 0 }}>
                            <select value={snapTo30(h.open)} onChange={e => setTime(i, 'open', e.target.value)} style={timeSelectStyle}>
                                {TIME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                            <span style={{ color: 'var(--blanc-ink-3)', fontSize: 14, flexShrink: 0 }}>—</span>
                            <select value={snapTo30(h.close)} onChange={e => setTime(i, 'close', e.target.value)} style={timeSelectStyle}>
                                {TIME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                        </div>
                    ) : null;
                    return (
                        <div key={h.day} style={{ display: 'flex', alignItems: 'center', flexWrap: isMobile ? 'wrap' : 'nowrap', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--blanc-line)' }}>
                            <span style={{ width: 36, fontSize: 13, fontWeight: 600, color: 'var(--blanc-ink-1)', flexShrink: 0 }}>{h.day}</span>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', minWidth: 56, flexShrink: 0 }}>
                                <input type="checkbox" checked={isOpen} onChange={() => toggleDay(i)}
                                    style={{ width: 18, height: 18, accentColor: 'var(--blanc-accent)' }} />
                                <span style={{ fontSize: 11, color: isOpen ? '#22c55e' : 'var(--blanc-ink-3)', fontWeight: 600 }}>{isOpen ? 'Open' : 'Off'}</span>
                            </label>
                            {timeRow}
                        </div>
                    );
                })}
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
            if (json.ok) {
                setGroups((json.data || []).map((group: UserGroupData) => ({
                    ...group,
                    strategy: 'Simultaneous',
                })));
            }
        } catch { /* fallback: empty */ }
        setLoading(false);
    };

    useEffect(() => {
        fetchGroups();
        // Load agents from existing /api/users endpoint
        authedFetch('/api/users')
            .then(r => r.json())
            .then(j => {
                console.log('[UserGroups] /api/users response:', j.ok, 'users:', j.users?.length ?? j.data?.length ?? 0);
                const list = j.users || j.data || [];
                if (list.length) _allAgents = list.map((u: any) => ({ id: String(u.id), name: u.full_name || u.name || u.email }));
            })
            .catch(err => console.error('[UserGroups] /api/users failed:', err));
        // Load phone numbers from existing API
        authedFetch('/api/phone-numbers')
            .then(r => r.json())
            .then(j => {
                const list = j.data || j.numbers || [];
                if (list.length) _allNumbers = list.map((n: any) => ({ id: String(n.id), number: n.number || n.phone_number, friendly_name: n.friendly_name || '' }));
            })
            .catch(err => console.error('[UserGroups] /api/phone-numbers failed:', err));
    }, []);

    useRealtimeEvents({
        onGenericEvent: (eventType, data) => {
            if (eventType !== 'agent.status.changed') return;
            setGroups(current => current.map(group => {
                if (!Array.isArray(data.groupIds) || !data.groupIds.includes(group.id)) return group;
                return {
                    ...group,
                    members: group.members.map(member => member.id === data.userId ? { ...member, status: data.status } : member),
                };
            }));
        },
    });

    return (
        <SettingsPageShell
            title="User Groups"
            description="Agent groups with numbers, schedules & call flows"
            actions={
                <Button onClick={() => setEditGroup('new')}>
                    <Plus className="size-4" />New Group
                </Button>
            }
        >
            <div className="flex flex-col gap-5">
                {loading ? <div style={{ padding: 40, textAlign: 'center', color: 'var(--blanc-ink-3)' }}>Loading...</div> : groups.length === 0 ? <div style={{ padding: 40, textAlign: 'center', color: 'var(--blanc-ink-3)' }}>No groups yet. Click "New Group" to get started.</div> : null}
                {groups.map(g => (
                    <div key={g.id} style={{ background: 'var(--blanc-panel-surface)', border: '1px solid var(--blanc-line)', borderRadius: 16, overflow: 'hidden' }}>

                        {/* Header */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--blanc-line)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <div style={{ width: 40, height: 40, borderRadius: 10, background: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <Users size={18} style={{ color: '#f59e0b' }} />
                                </div>
                                <div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--blanc-ink-1)' }}>{g.name}</div>
                                        {(() => {
                                            const reachable = g.members.some(m => m.status === 'available');
                                            return (
                                                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: reachable ? '#d1fae5' : '#fef2f2', color: reachable ? '#047857' : '#b91c1c' }}>
                                                    {reachable ? 'Reachable' : 'Voicemail risk'}
                                                </span>
                                            );
                                        })()}
                                    </div>
                                    {(() => {
                                        const status = getScheduleStatus(g.schedule);
                                        return <div style={{ fontSize: 12, color: 'var(--blanc-ink-2)', marginTop: 2 }}>{status.label}</div>;
                                    })()}
                                </div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); navigate(`/settings/telephony/user-groups/${g.id}`); }}>
                                    <Eye />Details
                                </Button>
                                <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); setEditGroup(g); }}>
                                    <Pencil />Edit
                                </Button>
                                <Button size="sm" onClick={(e) => { e.stopPropagation(); navigate(`/settings/telephony/user-groups/${g.id}/flow`); }}>
                                    <Play />Flow Builder
                                </Button>
                            </div>
                        </div>

                        {/* Body */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
                            {/* Left: Members + Numbers stacked */}
                            <div style={{ borderRight: '1px solid var(--blanc-line)' }}>
                                {/* Members */}
                                <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--blanc-line)' }}>
                                    <div className="blanc-eyebrow" style={sectionLabel}>
                                        <Users size={13} />Members ({g.members.length})
                                    </div>
                                    {g.members.map(m => {
                                        const sc = STATUS_COLORS[m.status] || STATUS_COLORS.offline;
                                        return (
                                            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                                                <div style={{ width: 8, height: 8, borderRadius: '50%', background: sc.dot, flexShrink: 0 }} />
                                                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--blanc-ink-1)', flex: 1 }}>{m.name}</span>
                                                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, background: sc.bg, color: sc.dot, fontWeight: 600 }}>{m.status.replace('_', ' ')}</span>
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* Numbers */}
                                <div style={{ padding: '16px 20px' }}>
                                    <div className="blanc-eyebrow" style={sectionLabel}>
                                        <Phone size={13} />Numbers ({g.numbers.length})
                                        <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: 'var(--blanc-accent-soft)', color: 'var(--blanc-accent)', textTransform: 'none', letterSpacing: 0 }}>{g.strategy}</span>
                                    </div>
                                    {g.numbers.length === 0 && <div style={{ fontSize: 12, color: '#ef4444' }}>No numbers — calls won't reach this group</div>}
                                    {g.numbers.map(n => (
                                        <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                                            <Phone size={13} style={{ color: 'var(--blanc-accent)', flexShrink: 0 }} />
                                            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--blanc-ink-1)', flex: 1 }}>{n.number}</span>
                                            <span style={{ fontSize: 12, color: 'var(--blanc-ink-3)' }}>{n.friendly_name}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Right: Schedule */}
                            <div style={{ padding: '16px 20px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                                    <div className="blanc-eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <Calendar size={13} />Business Hours
                                    </div>
                                    <span style={{ fontSize: 12, color: 'var(--blanc-ink-2)', fontWeight: 500 }}>{g.schedule.timezone.replace('_', ' ')}</span>
                                </div>
                                {g.schedule.hours.map(h => {
                                    const isOpen = h.open !== 'Closed';
                                    return (
                                        <div key={h.day} style={{ display: 'flex', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--blanc-line)' }}>
                                            <span style={{ width: 36, fontSize: 13, fontWeight: 600, color: 'var(--blanc-ink-1)' }}>{h.day}</span>
                                            <div style={{ width: 6, height: 6, borderRadius: '50%', background: isOpen ? '#22c55e' : 'var(--blanc-line-strong)', marginRight: 8, flexShrink: 0 }} />
                                            {isOpen
                                                ? <span style={{ fontSize: 13, color: 'var(--blanc-ink-1)' }}>{h.open} – {h.close}</span>
                                                : <span style={{ fontSize: 13, color: 'var(--blanc-ink-3)' }}>Closed</span>
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
                    onClose={() => { setEditGroup(null); fetchGroups(); }}
                />
            )}
        </SettingsPageShell>
    );
}
