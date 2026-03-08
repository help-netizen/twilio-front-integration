import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, Search, Plus, ExternalLink, Wifi, WifiOff, AlertTriangle } from 'lucide-react';
import { extendedMockApi, type PhoneNumber } from '../../services/extendedMockApi';

export default function PhoneNumbersPage() {
    const navigate = useNavigate();
    const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [filterGroup, setFilterGroup] = useState('all');
    const [filterStatus, setFilterStatus] = useState('all');

    useEffect(() => { extendedMockApi.getPhoneNumbers().then(n => { setNumbers(n); setLoading(false); }); }, []);

    const groups = [...new Set(numbers.map(n => n.number_group_name))];
    const filtered = numbers.filter(n => {
        if (search && !n.number.includes(search) && !n.friendly_name.toLowerCase().includes(search.toLowerCase())) return false;
        if (filterGroup !== 'all' && n.number_group_name !== filterGroup) return false;
        if (filterStatus !== 'all' && n.inbound_status !== filterStatus) return false;
        return true;
    });

    const summary = {
        total: numbers.length,
        active: numbers.filter(n => n.inbound_status === 'active').length,
        unassigned: numbers.filter(n => !n.number_group_id).length,
        webhook_issues: numbers.filter(n => n.voice_webhook_status !== 'configured').length,
    };

    if (loading) return <div style={{ padding: 32 }}><div style={{ width: 24, height: 24, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;

    return (
        <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <div>
                    <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111', margin: 0 }}>Phone Numbers</h1>
                    <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Inventory of provisioned numbers and their routing bindings</p>
                </div>
                <button style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 500, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}><Plus size={16} />Buy Number</button>
            </div>

            {/* Summary */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                {[
                    { label: 'Total Numbers', value: summary.total, color: '#6366f1' },
                    { label: 'Active', value: summary.active, color: '#10b981' },
                    { label: 'Unassigned', value: summary.unassigned, color: '#f59e0b' },
                    { label: 'Webhook Issues', value: summary.webhook_issues, color: '#ef4444' },
                ].map(s => (
                    <div key={s.label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 20px', flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>{s.label}</div>
                    </div>
                ))}
            </div>

            {/* Filters */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
                <div style={{ position: 'relative', flex: 1, maxWidth: 280 }}>
                    <Search size={16} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
                    <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by number or name..." style={{ width: '100%', padding: '8px 12px 8px 32px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, outline: 'none' }} />
                </div>
                <select value={filterGroup} onChange={e => setFilterGroup(e.target.value)} style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, background: '#fff' }}>
                    <option value="all">All Groups</option>
                    {groups.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, background: '#fff' }}>
                    <option value="all">All Status</option>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="pending">Pending</option>
                </select>
            </div>

            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                        <tr style={{ background: '#f9fafb' }}>
                            {['Phone Number', 'Name', 'Provider', 'Group', 'Type', 'Inbound', 'Webhook', 'Last Call'].map(h => (
                                <th key={h} style={{ textAlign: 'left', padding: '10px 14px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>{h}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map((n, i) => (
                            <tr key={n.id} style={{ background: i % 2 === 0 ? '#fff' : '#fafbfc' }}>
                                <td style={{ padding: '10px 14px', borderBottom: '1px solid #f0f0f0' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <Phone size={13} style={{ color: '#8b5cf6' }} />
                                        <span style={{ fontWeight: 500, fontFamily: 'monospace' }}>{n.number}</span>
                                    </div>
                                </td>
                                <td style={{ padding: '10px 14px', borderBottom: '1px solid #f0f0f0' }}>{n.friendly_name}</td>
                                <td style={{ padding: '10px 14px', borderBottom: '1px solid #f0f0f0', color: '#6b7280' }}>{n.provider}</td>
                                <td style={{ padding: '10px 14px', borderBottom: '1px solid #f0f0f0' }}>
                                    <span style={{ fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 10, background: n.number_group_id ? '#ede9fe' : '#fef3c7', color: n.number_group_id ? '#6d28d9' : '#92400e' }}>{n.number_group_name}</span>
                                </td>
                                <td style={{ padding: '10px 14px', borderBottom: '1px solid #f0f0f0', color: '#6b7280', textTransform: 'capitalize' }}>{n.type.replace('_', ' ')}</td>
                                <td style={{ padding: '10px 14px', borderBottom: '1px solid #f0f0f0' }}>
                                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: n.inbound_status === 'active' ? '#d1fae5' : '#fee2e2', color: n.inbound_status === 'active' ? '#065f46' : '#991b1b' }}>{n.inbound_status}</span>
                                </td>
                                <td style={{ padding: '10px 14px', borderBottom: '1px solid #f0f0f0' }}>
                                    {n.voice_webhook_status === 'configured' ? <Wifi size={14} style={{ color: '#10b981' }} /> : n.voice_webhook_status === 'error' ? <AlertTriangle size={14} style={{ color: '#ef4444' }} /> : <WifiOff size={14} style={{ color: '#9ca3af' }} />}
                                </td>
                                <td style={{ padding: '10px 14px', borderBottom: '1px solid #f0f0f0', color: '#6b7280', fontSize: 12 }}>{n.last_inbound_call ? new Date(n.last_inbound_call).toLocaleString() : '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {filtered.length === 0 && <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No numbers found</div>}
            </div>
        </div>
    );
}
