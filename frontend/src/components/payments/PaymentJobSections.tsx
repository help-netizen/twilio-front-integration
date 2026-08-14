import { useNavigate } from 'react-router-dom';
import type { LocalJob } from '../../services/jobsApi';
import type { PaymentDetail } from './paymentTypes';

/**
 * The job behind a payment — number, service, status, tags, providers.
 *
 * The job card renders these through JobDetailHeader and JobOpsSection, but
 * those carry the job's own controls (status dropdown, cancel, ETA). From a
 * payment you are reading, not dispatching, so this is the same information
 * without the levers.
 */

function Pill({ text }: { text: string }) {
    const styles = { background: 'rgba(27,139,99,.10)', color: 'var(--blanc-success)' };
    return (
        <span
            className="inline-flex items-center px-2.5 text-[11.5px] font-semibold"
            style={{ ...styles, minHeight: 24, borderRadius: 8 }}
        >
            {text}
        </span>
    );
}

export function PaymentJobSection({ detail, job }: { detail: PaymentDetail; job: LocalJob | null }) {
    const navigate = useNavigate();
    const jobNumber = job?.job_number || detail.job_number;
    const service = job?.service_name || detail.job_type;
    const status = job?.blanc_status || detail.status;
    const tags = job?.tags || [];

    if (!jobNumber && !service) return null;

    return (
        <div>
            {/* One title, one thought: the job number and what was done read as a
                single line, and everything under it belongs to that job. */}
            <button
                type="button"
                disabled={!detail.local_job_id}
                onClick={() => detail.local_job_id && navigate(`/jobs/${detail.local_job_id}`)}
                className="blanc-section-heading block text-left hover:underline disabled:no-underline"
                style={{
                    background: 'none', border: 'none', padding: 0, marginBottom: 8,
                    cursor: detail.local_job_id ? 'pointer' : 'default',
                }}
            >
                {jobNumber ? `Job #${jobNumber}` : 'Job'}{service ? ` · ${service}` : ''}
            </button>

            {/* Status and Tags are rows like Mobile or Location — same label
                column, same weight. A lone pill under a title looked like a
                fragment of something else. */}
            {status && (
                <div className="flex items-baseline gap-2.5 py-1">
                    <span className="w-[58px] flex-none text-[12px]" style={{ color: 'var(--blanc-ink-3)' }}>Status</span>
                    <Pill text={status} />
                </div>
            )}
            {tags.length > 0 && (
                <div className="flex items-baseline gap-2.5 py-1">
                    <span className="w-[58px] flex-none text-[12px]" style={{ color: 'var(--blanc-ink-3)' }}>Tags</span>
                    <span className="flex flex-wrap gap-1.5">
                        {tags.map(tag => (
                            <span
                                key={tag.id}
                                className="inline-flex items-center px-2.5 text-[11px] font-semibold"
                                style={{ height: 22, borderRadius: 6, background: 'var(--blanc-accent-soft)', color: 'var(--blanc-accent)' }}
                            >
                                {tag.name}
                            </span>
                        ))}
                    </span>
                </div>
            )}
        </div>
    );
}

/** Providers as the job card shows them — bubbles, not a list. */
export function PaymentProviders({ detail, job }: { detail: PaymentDetail; job: LocalJob | null }) {
    const fromJob = (job?.assigned_techs || []).map(tech => tech.name).filter(Boolean) as string[];
    const fromPayment = (detail.job?.providers || []).map(provider => provider.name).filter(Boolean) as string[];
    const names = fromJob.length > 0 ? fromJob : fromPayment;
    if (names.length === 0) return null;

    return (
        <div className="flex items-baseline gap-2.5 py-1.5">
            <span className="w-[58px] flex-none text-[12px]" style={{ color: 'var(--blanc-ink-3)' }}>Provider</span>
            <span className="flex flex-wrap gap-1.5">
                {names.map(name => (
                    <span
                        key={name}
                        className="inline-flex items-center px-3 text-[13px] font-medium"
                        style={{ minHeight: 28, borderRadius: 999, background: 'var(--blanc-surface-muted)', color: 'var(--blanc-ink-1)' }}
                    >
                        {name}
                    </span>
                ))}
            </span>
        </div>
    );
}
