import { useState } from 'react';
import { Hash, Plus, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface NumberGroup { id: string; name: string; description: string; numbers: string[]; flow_id?: string; }

const MOCK_GROUPS: NumberGroup[] = [
    { id: 'ng-1', name: 'Inbound', description: 'Main inbound numbers for general inquiries', numbers: ['+1 (617) 555-0101', '+1 (617) 555-0103'], flow_id: 'cf-1' },
    { id: 'ng-2', name: 'Sales', description: 'Dedicated sales line numbers', numbers: ['+1 (617) 555-0102'], flow_id: 'cf-1' },
    { id: 'ng-3', name: 'After Hours', description: 'Numbers routed to after-hours flow', numbers: ['+1 (617) 555-0104'], flow_id: 'cf-2' },
];

export default function PhoneNumberGroupsPage() {
    const navigate = useNavigate();
    const [groups] = useState(MOCK_GROUPS);
    return (
        <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div><h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Number Groups</h1><p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Group numbers by purpose and assign call flows</p></div>
                <button style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}><Plus size={15} />New Group</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {groups.map(g => (
                    <div key={g.id} onClick={() => navigate(`/settings/telephony/groups/${g.id}`)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, cursor: 'pointer', transition: 'box-shadow 0.15s' }}
                        onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)')} onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}>
                        <div style={{ width: 36, height: 36, borderRadius: 8, background: '#ede9fe', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Hash size={16} style={{ color: '#6366f1' }} /></div>
                        <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{g.name}</div>
                            <div style={{ fontSize: 12, color: '#6b7280' }}>{g.description}</div>
                        </div>
                        <span style={{ fontSize: 12, color: '#6366f1', fontWeight: 500 }}>{g.numbers.length} numbers</span>
                        <ChevronRight size={16} style={{ color: '#9ca3af' }} />
                    </div>
                ))}
            </div>
        </div>
    );
}
