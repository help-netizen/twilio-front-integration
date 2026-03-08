import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Settings, GitBranch, Play, Phone, Calendar, Clock } from 'lucide-react';
import type { CallFlowGraph } from '../../types/telephony';
import { NODE_KIND_META, type CallFlowNodeKind } from '../../types/telephony';

// User Group = members + assigned numbers + schedule (1:1) + call flow (1:1)
interface ScheduleDay { day: string; open: string; close: string }
interface UserGroupData {
    name: string;
    desc: string;
    strategy: string;
    members: { id: string; name: string; status: string }[];
    numbers: { id: string; number: string; friendly_name: string }[];
    schedule: { timezone: string; hours: ScheduleDay[] };
    flow: { id: string; status: 'draft' | 'published'; updated_at: string; graph: CallFlowGraph };
}

const MOCK: Record<string, UserGroupData> = {
    'ug-1': {
        name: 'Sales Team', desc: 'All sales agents', strategy: 'Round Robin',
        members: [
            { id: 'ag-1', name: 'Sarah Johnson', status: 'available' },
            { id: 'ag-2', name: 'Mike Chen', status: 'on_call' },
        ],
        numbers: [
            { id: 'pn-1', number: '+1 (617) 555-0101', friendly_name: 'Main Line' },
            { id: 'pn-2', number: '+1 (617) 555-0102', friendly_name: 'Sales Line' },
        ],
        schedule: {
            timezone: 'America/New_York',
            hours: [
                { day: 'Mon', open: '09:00', close: '18:00' }, { day: 'Tue', open: '09:00', close: '18:00' },
                { day: 'Wed', open: '09:00', close: '18:00' }, { day: 'Thu', open: '09:00', close: '18:00' },
                { day: 'Fri', open: '09:00', close: '17:00' }, { day: 'Sat', open: 'Closed', close: '' },
                { day: 'Sun', open: 'Closed', close: '' },
            ],
        },
        flow: {
            id: 'cf-1', status: 'published', updated_at: '2026-03-06',
            graph: {
                states: [
                    { id: 's-start', name: 'Call Received', kind: 'start', isInitial: true },
                    { id: 's-greeting', name: 'Welcome Greeting', kind: 'greeting' },
                    { id: 's-hours', name: 'Business Hours?', kind: 'branch' },
                    { id: 's-menu', name: 'Main Menu', kind: 'menu' },
                    { id: 's-queue', name: 'Agent Queue', kind: 'queue' },
                    { id: 's-voicemail', name: 'Leave Message', kind: 'voicemail' },
                    { id: 's-hangup', name: 'End Call', kind: 'hangup' },
                ],
                transitions: [
                    { id: 't-1', from_state_id: 's-start', to_state_id: 's-greeting', label: 'answer' },
                    { id: 't-2', from_state_id: 's-greeting', to_state_id: 's-hours', label: 'check hours' },
                    { id: 't-3', from_state_id: 's-hours', to_state_id: 's-menu', label: 'open' },
                    { id: 't-4', from_state_id: 's-hours', to_state_id: 's-voicemail', label: 'closed' },
                    { id: 't-5', from_state_id: 's-menu', to_state_id: 's-queue', label: 'selected' },
                    { id: 't-6', from_state_id: 's-queue', to_state_id: 's-hangup', label: 'connected' },
                    { id: 't-7', from_state_id: 's-queue', to_state_id: 's-voicemail', label: 'timeout' },
                    { id: 't-8', from_state_id: 's-voicemail', to_state_id: 's-hangup', label: 'recorded' },
                ],
            },
        },
    },
    'ug-2': {
        name: 'Support Team', desc: 'Technical support', strategy: 'Simultaneous',
        members: [
            { id: 'ag-3', name: 'Lisa Park', status: 'away' },
            { id: 'ag-4', name: 'Tom Rivera', status: 'available' },
        ],
        numbers: [
            { id: 'pn-3', number: '+1 (617) 555-0103', friendly_name: 'Support Line' },
        ],
        schedule: {
            timezone: 'America/New_York',
            hours: [
                { day: 'Mon', open: '08:00', close: '22:00' }, { day: 'Tue', open: '08:00', close: '22:00' },
                { day: 'Wed', open: '08:00', close: '22:00' }, { day: 'Thu', open: '08:00', close: '22:00' },
                { day: 'Fri', open: '08:00', close: '20:00' }, { day: 'Sat', open: '10:00', close: '16:00' },
                { day: 'Sun', open: 'Closed', close: '' },
            ],
        },
        flow: {
            id: 'cf-2', status: 'draft', updated_at: '2026-03-07',
            graph: {
                states: [
                    { id: 's-start', name: 'Call Received', kind: 'start', isInitial: true },
                    { id: 's-msg', name: 'After Hours Message', kind: 'play_audio' },
                    { id: 's-vm', name: 'Voicemail', kind: 'voicemail' },
                    { id: 's-end', name: 'End Call', kind: 'hangup' },
                ],
                transitions: [
                    { id: 't-1', from_state_id: 's-start', to_state_id: 's-msg', label: 'answer' },
                    { id: 't-2', from_state_id: 's-msg', to_state_id: 's-vm', label: 'played' },
                    { id: 't-3', from_state_id: 's-vm', to_state_id: 's-end', label: 'recorded' },
                ],
            },
        },
    },
};

const SC: Record<string, { bg: string; dot: string }> = {
    available: { bg: '#d1fae5', dot: '#10b981' },
    on_call: { bg: '#dbeafe', dot: '#3b82f6' },
    away: { bg: '#fef3c7', dot: '#f59e0b' },
};

export default function UserGroupDetailPage() {
    const { groupId } = useParams<{ groupId: string }>();
    const navigate = useNavigate();
    const g = MOCK[groupId || ''];
    if (!g) return <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Group not found</div>;

    return (
        <div style={{ padding: 24 }}>
            <button onClick={() => navigate('/settings/telephony/user-groups')} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 16 }}>
                <ArrowLeft size={14} />Back to User Groups
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{g.name}</h1>
                <button style={{ padding: '4px 10px', fontSize: 11, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Settings size={12} />Edit
                </button>
            </div>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 20px' }}>
                {g.desc} · Ring strategy: <strong>{g.strategy}</strong>
            </p>

            {/* Row 1: Members + Assigned Numbers */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Users size={15} />Members ({g.members.length})
                    </div>
                    {g.members.map(m => {
                        const sc = SC[m.status] || { bg: '#f3f4f6', dot: '#9ca3af' };
                        return (
                            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid #f3f4f6' }}>
                                <div style={{ width: 8, height: 8, borderRadius: '50%', background: sc.dot }} />
                                <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{m.name}</span>
                                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: sc.bg, color: sc.dot, fontWeight: 600 }}>{m.status}</span>
                            </div>
                        );
                    })}
                </div>

                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Phone size={15} style={{ color: '#10b981' }} />Assigned Numbers ({g.numbers.length})
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>Inbound calls on these numbers route through this group's flow</div>
                    {g.numbers.map(n => (
                        <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                            <Phone size={13} style={{ color: '#6366f1' }} />
                            <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{n.number}</span>
                            <span style={{ fontSize: 11, color: '#6b7280' }}>{n.friendly_name}</span>
                        </div>
                    ))}
                </div>
            </div>

            {/* Row 2: Schedule + Call Flow */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {/* Schedule */}
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Calendar size={15} style={{ color: '#3b82f6' }} />Schedule
                        </div>
                        <span style={{ fontSize: 11, color: '#6b7280' }}>{g.schedule.timezone}</span>
                    </div>
                    {g.schedule.hours.map(h => (
                        <div key={h.day} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #f3f4f6', fontSize: 12 }}>
                            <span style={{ fontWeight: 500, minWidth: 40 }}>{h.day}</span>
                            <span style={{ color: h.open === 'Closed' ? '#ef4444' : '#374151', display: 'flex', alignItems: 'center', gap: 4 }}>
                                {h.open === 'Closed' ? 'Closed' : <><Clock size={10} />{h.open} — {h.close}</>}
                            </span>
                        </div>
                    ))}
                </div>

                {/* Call Flow */}
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <GitBranch size={15} style={{ color: '#6366f1' }} />Call Flow
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: g.flow.status === 'published' ? '#d1fae5' : '#fef3c7', color: g.flow.status === 'published' ? '#065f46' : '#92400e' }}>
                                {g.flow.status}
                            </span>
                            <button
                                onClick={() => navigate(`/settings/telephony/user-groups/${groupId}/flow`)}
                                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', fontSize: 12, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
                            >
                                <Play size={12} />Open Builder
                            </button>
                        </div>
                    </div>

                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
                        Updated {g.flow.updated_at} · {g.flow.graph.states.length} states · {g.flow.graph.transitions.length} transitions
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {g.flow.graph.states.map(s => {
                            const meta = NODE_KIND_META[s.kind as CallFlowNodeKind] || { icon: '?', label: s.kind, color: '#6b7280' };
                            return (
                                <div key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 12, border: '1px solid #e5e7eb' }}>
                                    <span>{meta.icon}</span>
                                    <span style={{ fontWeight: 500 }}>{s.name}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}
