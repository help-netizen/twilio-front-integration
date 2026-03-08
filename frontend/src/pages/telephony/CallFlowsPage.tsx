import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, GitBranch } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import type { CallFlow } from '../../types/telephony';

export default function CallFlowsPage() {
    const [flows, setFlows] = useState<CallFlow[]>([]);
    const [loading, setLoading] = useState(true);
    const navigate = useNavigate();

    useEffect(() => { telephonyApi.listFlows().then(f => { setFlows(f); setLoading(false); }); }, []);

    return (
        <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div>
                    <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: '#111' }}>Call Flows</h1>
                    <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Visual call routing flows</p>
                </div>
                <button style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}><Plus size={15} />New Flow</button>
            </div>
            {loading ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading...</div>
            ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
                    {flows.map(f => (
                        <div key={f.id} onClick={() => navigate(`/settings/telephony/call-flows/${f.id}`)} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, cursor: 'pointer', transition: 'box-shadow 0.15s' }}
                            onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.08)')}
                            onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                <GitBranch size={18} style={{ color: '#6366f1' }} />
                                <span style={{ fontSize: 15, fontWeight: 600, color: '#111' }}>{f.name}</span>
                            </div>
                            <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>{f.description}</p>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: f.status === 'published' ? '#d1fae5' : '#fef3c7', color: f.status === 'published' ? '#065f46' : '#92400e' }}>{f.status}</span>
                                <span style={{ fontSize: 11, color: '#9ca3af' }}>{f.graph.states.length} states</span>
                                <span style={{ fontSize: 11, color: '#9ca3af' }}>Updated {f.updated_at}</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
