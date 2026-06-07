import { useState, useEffect } from 'react';
import { Phone, Search } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import { authedFetch } from '../../services/apiClient';
import type { PhoneNumber, UserGroup } from '../../types/telephony';

export default function PhoneNumbersPage() {
    const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
    const [groups, setGroups] = useState<UserGroup[]>([]);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    const [savingNumberId, setSavingNumberId] = useState<string | null>(null);

    const loadData = async () => {
        setLoading(true);
        try {
            const [nums, groupRes] = await Promise.all([
                telephonyApi.listNumbers(),
                authedFetch('/api/user-groups').then(r => r.json()).catch(() => ({ data: [] })),
            ]);
            setNumbers(nums);
            setGroups(groupRes.data || []);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { loadData(); }, []);

    const assignGroup = async (number: PhoneNumber, groupId: string | null, force = false) => {
        setSavingNumberId(number.id);
        try {
            const res = await authedFetch(`/api/phone-numbers/${number.id}/group`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group_id: groupId, force }),
            });
            const data = await res.json();
            if (res.status === 409) {
                const ok = window.confirm(data.message || 'This number is already assigned to another group. Move it?');
                if (ok) await assignGroup(number, groupId, true);
                return;
            }
            if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to update number group');
            setNumbers(current => current.map(n => n.id === number.id ? data.data : n));
        } catch (err) {
            console.error('[PhoneNumbers] group assignment failed:', err);
            alert('Failed to update number group');
        } finally {
            setSavingNumberId(null);
        }
    };

    const filtered = numbers.filter(n => !search || n.number.includes(search) || n.friendly_name.toLowerCase().includes(search.toLowerCase()) || (n.group || '').toLowerCase().includes(search.toLowerCase()));
    return (
        <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div><h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Phone Numbers</h1><p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Manage Twilio numbers</p></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ position: 'relative' }}>
                        <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
                        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." style={{ padding: '8px 12px 8px 32px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, width: 240 }} />
                    </div>
                </div>
            </div>
            {loading ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div> : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead><tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                        {['Number', 'Name', 'Provider', 'Group', 'Status', 'Webhook'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' }}>{h}</th>)}
                    </tr></thead>
                    <tbody>{filtered.map(n => (
                        <tr key={n.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}><Phone size={14} style={{ color: '#6366f1' }} />{n.number}</td>
                            <td style={{ padding: '10px 12px' }}>{n.friendly_name}</td>
                            <td style={{ padding: '10px 12px' }}>{n.provider}</td>
                            <td style={{ padding: '10px 12px' }}>
                                <select
                                    value={n.group_id || ''}
                                    disabled={savingNumberId === n.id}
                                    onChange={e => assignGroup(n, e.target.value || null)}
                                    style={{ minWidth: 160, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 12, background: '#fff', color: n.group_id ? '#111827' : '#6b7280' }}
                                >
                                    <option value="">Unassigned</option>
                                    {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                                </select>
                            </td>
                            <td style={{ padding: '10px 12px' }}><span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: n.status === 'active' ? '#d1fae5' : '#fef3c7', color: n.status === 'active' ? '#065f46' : '#92400e' }}>{n.status}</span></td>
                            <td style={{ padding: '10px 12px' }}>{n.webhook_configured ? '✓ Configured' : '✗ Not set'}</td>
                        </tr>
                    ))}</tbody>
                </table>
            )}
        </div>
    );
}
