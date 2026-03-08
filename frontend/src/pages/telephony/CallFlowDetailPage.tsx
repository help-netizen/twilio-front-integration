import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, GitBranch, Play, FileEdit, CheckCircle, AlertCircle, Clock, Pencil } from 'lucide-react';
import { callFlowApi } from '../../services/callFlowMockApi';
import type { CallFlow, CallFlowVersion } from '../../types/callFlow';

export default function CallFlowDetailPage() {
    const { flowId } = useParams<{ flowId: string }>();
    const navigate = useNavigate();
    const [flow, setFlow] = useState<CallFlow | null>(null);
    const [versions, setVersions] = useState<CallFlowVersion[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!flowId) return;
        Promise.all([callFlowApi.getCallFlow(flowId), callFlowApi.getVersions(flowId)]).then(([f, v]) => {
            setFlow(f); setVersions(v); setLoading(false);
        });
    }, [flowId]);

    if (loading) return <div style={{ padding: 32 }}><div style={{ width: 24, height: 24, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;
    if (!flow) return <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>Flow not found</div>;

    const draft = versions.find(v => v.status === 'draft');
    const published = versions.find(v => v.status === 'published');

    return (
        <div style={{ padding: '24px 32px', maxWidth: 900 }}>
            <button onClick={() => navigate('/settings/telephony/call-flows')} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 16, padding: 0 }}><ArrowLeft size={16} />Back to Call Flows</button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
                <div style={{ width: 44, height: 44, borderRadius: 10, background: '#f5f3ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><GitBranch size={22} style={{ color: '#8b5cf6' }} /></div>
                <div style={{ flex: 1 }}>
                    <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111', margin: 0 }}>{flow.title}</h1>
                    <p style={{ fontSize: 13, color: '#6b7280', margin: '2px 0 0' }}>{flow.description}</p>
                </div>
                {draft && (
                    <button onClick={() => navigate(`/settings/telephony/call-flows/${flow.id}/builder/${draft.id}`)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 20px', fontSize: 13, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}><Pencil size={16} />Open Builder</button>
                )}
                {!draft && published && (
                    <button onClick={() => navigate(`/settings/telephony/call-flows/${flow.id}/builder/${published.id}`)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 20px', fontSize: 13, fontWeight: 600, background: '#fff', color: '#6366f1', border: '1px solid #6366f1', borderRadius: 8, cursor: 'pointer' }}><Play size={16} />View Published</button>
                )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {/* Versions */}
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '0 0 14px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Version History</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {versions.map(v => (
                            <div key={v.id} onClick={() => navigate(`/settings/telephony/call-flows/${flow.id}/builder/${v.id}`)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', background: v.status === 'draft' ? '#fffbeb' : '#f0fdf4', borderRadius: 8, cursor: 'pointer', transition: 'opacity 0.1s' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    {v.status === 'draft' ? <FileEdit size={16} style={{ color: '#f59e0b' }} /> : <CheckCircle size={16} style={{ color: '#10b981' }} />}
                                    <div>
                                        <div style={{ fontSize: 13, fontWeight: 600 }}>v{v.version_number} — {v.status === 'draft' ? 'Draft' : 'Published'}</div>
                                        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{v.change_note || 'No description'}</div>
                                    </div>
                                </div>
                                <div style={{ fontSize: 11, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 4 }}><Clock size={12} />{new Date(v.created_at).toLocaleDateString()}</div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Info */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                        <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '0 0 14px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Flow Info</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>Status</span><span style={{ fontWeight: 600 }}>{flow.status}</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>Published Version</span><span style={{ fontWeight: 600 }}>{flow.active_version_number ? `v${flow.active_version_number}` : '—'}</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>Assigned Groups</span><span style={{ fontWeight: 600 }}>{flow.assigned_groups_count}</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>Created</span><span>{new Date(flow.created_at).toLocaleDateString()}</span></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>Updated</span><span>{new Date(flow.updated_at).toLocaleDateString()}</span></div>
                        </div>
                    </div>

                    {/* Validation */}
                    {draft && (draft.validation.errors.length > 0 || draft.validation.warnings.length > 0) && (
                        <div style={{ background: draft.validation.errors.length > 0 ? '#fef2f2' : '#fffbeb', border: `1px solid ${draft.validation.errors.length > 0 ? '#fca5a5' : '#fbbf24'}`, borderRadius: 12, padding: 20 }}>
                            <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 10px', color: draft.validation.errors.length > 0 ? '#991b1b' : '#92400e', display: 'flex', alignItems: 'center', gap: 6 }}><AlertCircle size={16} />Validation Issues</h3>
                            {draft.validation.errors.map((e, i) => <div key={i} style={{ fontSize: 12, color: '#991b1b', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>✗ {e.message}</div>)}
                            {draft.validation.warnings.map((w, i) => <div key={i} style={{ fontSize: 12, color: '#92400e', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>⚠ {w.message}</div>)}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
