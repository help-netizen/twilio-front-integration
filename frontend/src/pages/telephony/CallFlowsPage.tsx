import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitBranch, Plus, Search, AlertCircle, CheckCircle } from 'lucide-react';
import { callFlowApi } from '../../services/callFlowMockApi';
import type { CallFlow } from '../../types/callFlow';

export default function CallFlowsPage() {
    const navigate = useNavigate();
    const [flows, setFlows] = useState<CallFlow[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');

    useEffect(() => { callFlowApi.getCallFlows().then(f => { setFlows(f); setLoading(false); }); }, []);
    const filtered = flows.filter(f => !search || f.title.toLowerCase().includes(search.toLowerCase()));

    const summary = {
        total: flows.length,
        published: flows.filter(f => f.status === 'published').length,
        draft: flows.filter(f => f.has_draft).length,
        errors: flows.filter(f => f.has_validation_errors).length,
    };

    if (loading) return <div style={{ padding: 32 }}><div style={{ width: 24, height: 24, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;

    return (
        <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <div>
                    <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111', margin: 0 }}>Call Flows</h1>
                    <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Visual routing flows for inbound calls</p>
                </div>
                <button onClick={() => navigate('/settings/telephony')} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 500, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}><Plus size={16} />Create Flow</button>
            </div>

            {/* Summary */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                {[
                    { label: 'Total', value: summary.total, color: '#6366f1' },
                    { label: 'Published', value: summary.published, color: '#10b981' },
                    { label: 'Drafts', value: summary.draft, color: '#f59e0b' },
                    { label: 'With Errors', value: summary.errors, color: '#ef4444' },
                ].map(s => (
                    <div key={s.label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
                        <div style={{ fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>{s.label}</div>
                    </div>
                ))}
            </div>

            <div style={{ position: 'relative', maxWidth: 320, marginBottom: 20 }}>
                <Search size={16} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search flows..." style={{ width: '100%', padding: '8px 12px 8px 32px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, outline: 'none' }} />
            </div>

            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                        <tr style={{ background: '#f9fafb' }}>
                            <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Flow</th>
                            <th style={{ textAlign: 'center', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Status</th>
                            <th style={{ textAlign: 'center', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Version</th>
                            <th style={{ textAlign: 'center', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Groups</th>
                            <th style={{ textAlign: 'center', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Validation</th>
                            <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Updated</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map((f, i) => (
                            <tr key={f.id} onClick={() => navigate(`/settings/telephony/call-flows/${f.id}`)} style={{ cursor: 'pointer', background: i % 2 === 0 ? '#fff' : '#fafbfc' }} onMouseEnter={e => { e.currentTarget.style.background = '#f0f0ff'; }} onMouseLeave={e => { e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafbfc'; }}>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <GitBranch size={14} style={{ color: '#8b5cf6' }} />
                                        <div>
                                            <div style={{ fontWeight: 500 }}>{f.title}</div>
                                            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{f.description}</div>
                                        </div>
                                    </div>
                                </td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', textAlign: 'center' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                        {f.status === 'published' && <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: '#d1fae5', color: '#065f46' }}>Published</span>}
                                        {f.has_draft && <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: '#fef3c7', color: '#92400e' }}>Draft</span>}
                                        {f.status === 'archived' && <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: '#f3f4f6', color: '#6b7280' }}>Archived</span>}
                                    </div>
                                </td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', textAlign: 'center' }}>{f.active_version_number ? `v${f.active_version_number}` : '—'}</td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', textAlign: 'center' }}>{f.assigned_groups_count}</td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', textAlign: 'center' }}>
                                    {f.has_validation_errors ? <AlertCircle size={16} style={{ color: '#ef4444' }} /> : <CheckCircle size={16} style={{ color: '#10b981' }} />}
                                </td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', color: '#6b7280' }}>{new Date(f.updated_at).toLocaleDateString()}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {filtered.length === 0 && <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No flows found</div>}
            </div>
        </div>
    );
}
