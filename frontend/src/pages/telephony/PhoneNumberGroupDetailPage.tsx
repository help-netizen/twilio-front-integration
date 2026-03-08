import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Phone, GitBranch, Settings } from 'lucide-react';

const MOCK_DATA: Record<string, { name: string; desc: string; numbers: { id: string; number: string; name: string }[]; flow: string }> = {
    'ng-1': { name: 'Inbound', desc: 'Main inbound numbers', numbers: [{ id: 'pn-1', number: '+1 (617) 555-0101', name: 'Main Line' }, { id: 'pn-3', number: '+1 (617) 555-0103', name: 'Support Line' }], flow: 'Main Inbound Flow' },
    'ng-2': { name: 'Sales', desc: 'Dedicated sales lines', numbers: [{ id: 'pn-2', number: '+1 (617) 555-0102', name: 'Sales Line' }], flow: 'Main Inbound Flow' },
    'ng-3': { name: 'After Hours', desc: 'After hours routing', numbers: [{ id: 'pn-4', number: '+1 (617) 555-0104', name: 'Test Number' }], flow: 'After-Hours Flow' },
};

export default function PhoneNumberGroupDetailPage() {
    const { groupId } = useParams<{ groupId: string }>();
    const navigate = useNavigate();
    const group = MOCK_DATA[groupId || ''] || { name: 'Unknown', desc: '', numbers: [], flow: 'None' };
    return (
        <div style={{ padding: 24 }}>
            <button onClick={() => navigate('/settings/telephony/groups')} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 16 }}><ArrowLeft size={14} />Back to Groups</button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
                <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{group.name}</h1>
                <button style={{ padding: '4px 10px', fontSize: 11, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}><Settings size={12} />Edit</button>
            </div>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 24px' }}>{group.desc}</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}><Phone size={15} />Numbers ({group.numbers.length})</div>
                    {group.numbers.map(n => (
                        <div key={n.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13 }}>
                            <span style={{ fontWeight: 500 }}>{n.number}</span><span style={{ color: '#6b7280' }}>{n.name}</span>
                        </div>
                    ))}
                </div>
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}><GitBranch size={15} />Assigned Flow</div>
                    <div style={{ padding: '12px 16px', background: '#f9fafb', borderRadius: 8, fontSize: 13, fontWeight: 500 }}>{group.flow}</div>
                </div>
            </div>
        </div>
    );
}
