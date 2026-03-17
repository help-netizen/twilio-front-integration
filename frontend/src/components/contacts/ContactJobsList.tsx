import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase } from 'lucide-react';
import * as jobsApi from '../../services/jobsApi';
import { contactDetailStyles, getJobStatusStyle } from './contactDetailHelpers';

export function JobsList({ contactId }: { contactId: number }) {
    const [jobs, setJobs] = useState<jobsApi.LocalJob[]>([]);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const navigate = useNavigate();

    useEffect(() => {
        if (!contactId) return;
        setLoading(true);
        setLoaded(false);
        jobsApi.listJobs({ contact_id: contactId, limit: 50 })
            .then(data => { setJobs(data.results); setLoaded(true); })
            .catch(() => setLoaded(true))
            .finally(() => setLoading(false));
    }, [contactId]);

    return (
        <div style={{ marginBottom: '24px' }}>
            <h3 style={contactDetailStyles.sectionTitleStyle}>
                <Briefcase style={{ width: '16px', height: '16px' }} />
                Jobs {loaded ? `(${jobs.length})` : ''}
            </h3>
            {loading && (
                <div style={{ fontSize: '13px', color: '#94a3b8', padding: '8px 0' }}>Loading jobs…</div>
            )}
            {loaded && jobs.length === 0 && (
                <div style={{
                    padding: '32px', textAlign: 'center', color: '#94a3b8',
                    fontSize: '14px', backgroundColor: '#f8fafc', borderRadius: '8px',
                }}>
                    <Briefcase style={{ width: '32px', height: '32px', margin: '0 auto 8px', opacity: 0.3 }} />
                    No jobs found
                </div>
            )}
            {jobs.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {jobs.map(job => {
                        const statusStyle = getJobStatusStyle(job.blanc_status);
                        const date = job.start_date ? new Date(job.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
                        return (
                            <div
                                key={job.id}
                                onClick={() => navigate(`/jobs/${job.id}`)}
                                style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    padding: '12px 16px', borderRadius: '10px', border: '1px solid #e5e7eb',
                                    backgroundColor: '#fff', cursor: 'pointer', gap: '8px',
                                    transition: 'all 0.15s',
                                }}
                                onMouseEnter={e => { e.currentTarget.style.borderColor = '#93c5fd'; e.currentTarget.style.boxShadow = '0 1px 4px rgba(59,130,246,0.1)'; }}
                                onMouseLeave={e => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.boxShadow = 'none'; }}
                            >
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                        <span style={{ fontSize: '14px', fontWeight: 500, color: '#111827' }}>
                                            {job.service_name || 'Job'}
                                        </span>
                                        {job.job_number && (
                                            <span style={{ fontSize: '12px', color: '#9ca3af', fontFamily: 'monospace' }}>#{job.job_number}</span>
                                        )}
                                        <span style={{
                                            fontSize: '11px', fontWeight: 600, padding: '2px 8px',
                                            borderRadius: '10px', backgroundColor: statusStyle.bg,
                                            color: statusStyle.color,
                                        }}>
                                            {job.blanc_status}
                                        </span>
                                    </div>
                                    <div style={{ display: 'flex', gap: '12px', marginTop: '4px', fontSize: '12px', color: '#6b7280' }}>
                                        {job.assigned_techs && job.assigned_techs.length > 0 && (
                                            <span>👤 {job.assigned_techs.map((p: any) => p.name).join(', ')}</span>
                                        )}
                                        {date && <span>📅 {date}</span>}
                                        {job.invoice_total && <span>💰 ${job.invoice_total}</span>}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
