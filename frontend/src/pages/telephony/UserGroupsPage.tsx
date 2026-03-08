import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Plus, Search, Clock, Shield, Zap } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyMockApi';
import type { UserGroup } from '../../types/telephony';

const MODE_LABELS: Record<string, string> = { queue_pull: 'Queue Pull', auto_offer: 'Auto Offer' };
const STRATEGY_LABELS: Record<string, string> = { round_robin: 'Round Robin', longest_idle: 'Longest Idle', fixed_priority: 'Fixed Priority' };
const FALLBACK_LABELS: Record<string, string> = { voicemail: 'Voicemail', forward_external: 'Forward', hangup: 'Hangup' };

export default function UserGroupsPage() {
    const navigate = useNavigate();
    const [groups, setGroups] = useState<UserGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');

    useEffect(() => { telephonyApi.getUserGroups().then(g => { setGroups(g); setLoading(false); }); }, []);
    const filtered = groups.filter(g => !search || g.name.toLowerCase().includes(search.toLowerCase()));

    if (loading) return <div style={{ padding: 32 }}><div style={{ width: 24, height: 24, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;

    return (
        <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <div>
                    <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111', margin: 0 }}>User Groups</h1>
                    <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Organize operators into routing groups with policies</p>
                </div>
                <button onClick={() => { telephonyApi.createUserGroup({ name: 'New Group', routing_mode: 'queue_pull', strategy: 'round_robin' }).then(() => telephonyApi.getUserGroups().then(setGroups)); }} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 500, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}><Plus size={16} />Create Group</button>
            </div>

            <div style={{ position: 'relative', maxWidth: 320, marginBottom: 20 }}>
                <Search size={16} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search groups..." style={{ width: '100%', padding: '8px 12px 8px 32px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, outline: 'none' }} />
            </div>

            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                        <tr style={{ background: '#f9fafb' }}>
                            <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Name</th>
                            <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Mode</th>
                            <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Strategy</th>
                            <th style={{ textAlign: 'center', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Members</th>
                            <th style={{ textAlign: 'center', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Online</th>
                            <th style={{ textAlign: 'center', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Timeout</th>
                            <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Fallback</th>
                            <th style={{ textAlign: 'center', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map((g, i) => (
                            <tr key={g.id} onClick={() => navigate(`/settings/telephony/user-groups/${g.id}`)} style={{ cursor: 'pointer', background: i % 2 === 0 ? '#fff' : '#fafbfc' }} onMouseEnter={e => { e.currentTarget.style.background = '#f0f0ff'; }} onMouseLeave={e => { e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafbfc'; }}>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0' }}><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Users size={14} style={{ color: '#6366f1' }} /><span style={{ fontWeight: 500 }}>{g.name}</span></div></td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0' }}><div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Zap size={12} style={{ color: g.routing_mode === 'auto_offer' ? '#f59e0b' : '#6366f1' }} /><span>{MODE_LABELS[g.routing_mode]}</span></div></td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0' }}><div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Shield size={12} style={{ color: '#8b5cf6' }} /><span>{STRATEGY_LABELS[g.strategy]}</span></div></td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', textAlign: 'center' }}>{g.members_count}</td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', textAlign: 'center' }}><span style={{ color: g.active_members_now > 0 ? '#10b981' : '#d1d5db', fontWeight: 600 }}>{g.active_members_now}</span></td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', textAlign: 'center' }}><div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'center' }}><Clock size={12} style={{ color: '#6b7280' }} />{g.offer_timeout_sec}s</div></td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0' }}>{FALLBACK_LABELS[g.fallback_action]}</td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', textAlign: 'center' }}><span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: '#d1fae5', color: '#065f46' }}>{g.status}</span></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {filtered.length === 0 && <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No user groups found</div>}
            </div>
        </div>
    );
}
