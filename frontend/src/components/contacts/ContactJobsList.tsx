import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Loader2 } from 'lucide-react';
import * as jobsApi from '../../services/jobsApi';

const JOB_STATUS_COLORS: Record<string, string> = {
    'Submitted': '#3B82F6', 'Waiting for parts': '#F59E0B',
    'Follow Up with Client': '#8B5CF6', 'Visit completed': '#22C55E',
    'Job is Done': '#6B7280', 'Rescheduled': '#F97316', 'Canceled': '#EF4444',
};

function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

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

    if (loading) return <div className="text-[13px] py-2" style={{ color: 'var(--blanc-ink-3)' }}><Loader2 className="size-3.5 animate-spin inline mr-1.5" />Loading jobs…</div>;
    if (loaded && jobs.length === 0) return null;

    return (
        <div className="space-y-2">
            {jobs.map(job => {
                const color = JOB_STATUS_COLORS[job.blanc_status] || '#6B7280';
                const date = job.start_date ? new Date(job.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
                const techs = job.assigned_techs?.map((p: any) => p.name).join(', ');

                return (
                    <div
                        key={job.id}
                        onClick={() => navigate(`/jobs/${job.id}`)}
                        className="flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all hover:shadow-sm"
                        style={{ border: '1px solid var(--blanc-line)', background: 'transparent' }}
                    >
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-[13px] font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>
                                    {job.service_name || 'Job'}
                                </span>
                                {job.job_number && (
                                    <span className="text-[11px] font-mono" style={{ color: 'var(--blanc-ink-3)' }}>#{job.job_number}</span>
                                )}
                                <span
                                    className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full"
                                    style={{ background: hexToRgba(color, 0.1), color }}
                                >
                                    {job.blanc_status}
                                </span>
                            </div>
                            <div className="flex gap-3 mt-1 text-[12px]" style={{ color: 'var(--blanc-ink-3)' }}>
                                {techs && <span>{techs}</span>}
                                {date && <span>{date}</span>}
                                {job.invoice_total != null && <span>${Number(job.invoice_total).toFixed(2)}</span>}
                            </div>
                        </div>
                        <ChevronRight className="size-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                    </div>
                );
            })}
        </div>
    );
}
