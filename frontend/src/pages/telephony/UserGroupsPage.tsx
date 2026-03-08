import { useState } from 'react';
import { Users, Plus, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface UserGroup { id: string; name: string; description: string; members: string[]; ring_strategy: string; }

const MOCK: UserGroup[] = [
    { id: 'ug-1', name: 'Sales Team', description: 'All sales agents', members: ['Sarah Johnson', 'Mike Chen'], ring_strategy: 'Round Robin' },
    { id: 'ug-2', name: 'Support Team', description: 'Technical support agents', members: ['Lisa Park', 'Tom Rivera'], ring_strategy: 'Simultaneous' },
];

export default function UserGroupsPage() {
    const navigate = useNavigate();
    const [groups] = useState(MOCK);
    return (
        <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div><h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>User Groups</h1><p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Agent groups for call routing</p></div>
                <button style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}><Plus size={15} />New Group</button>
            </div>
            {groups.map(g => (
                <div key={g.id} onClick={() => navigate(`/settings/telephony/user-groups/${g.id}`)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, cursor: 'pointer', marginBottom: 10, transition: 'box-shadow 0.15s' }}
                    onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)')} onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}>
                    <div style={{ width: 36, height: 36, borderRadius: 8, background: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Users size={16} style={{ color: '#f59e0b' }} /></div>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{g.name}</div>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>{g.description}</div>
                    </div>
                    <span style={{ fontSize: 11, color: '#6b7280' }}>{g.members.length} members · {g.ring_strategy}</span>
                    <ChevronRight size={16} style={{ color: '#9ca3af' }} />
                </div>
            ))}
        </div>
    );
}
