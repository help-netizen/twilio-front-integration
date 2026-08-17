import { useNavigate } from 'react-router-dom';
import { UserRound } from 'lucide-react';
import type { LocalJob } from '../../services/jobsApi';
import type { PaymentDetail } from './paymentTypes';
import { LEVEL_TWO_QUIET, LEVEL_TWO_HEADING, LEVEL_TWO_LABEL_WIDTH } from '../../styles/levelTwo';

/**
 * The job behind a payment — number, service, status, tags, providers.
 *
 * The job card renders these through JobDetailHeader and JobOpsSection, but
 * those carry the job's own controls (status dropdown, cancel, ETA). From a
 * payment you are reading, not dispatching, so this is the same information
 * without the levers.
 */

// Same type as every other value on the card — the tint is what makes it a
// status, not a size and weight of its own.
function Pill({ text }: { text: string }) {
    const styles = { background: 'rgba(27,139,99,.10)', color: 'var(--blanc-success)' };
    return (
        <span
            className="blanc-l2 inline-flex items-center px-2.5"
            style={{ ...styles, minHeight: 26, borderRadius: 8 }}
        >
            {text}
        </span>
    );
}

const rowLabel = { ...LEVEL_TWO_QUIET, width: `${LEVEL_TWO_LABEL_WIDTH}px`, flexShrink: 0 } as const;

export function PaymentJobSection({ detail, job }: { detail: PaymentDetail; job: LocalJob | null }) {
    const navigate = useNavigate();
    const jobNumber = job?.job_seq ?? job?.job_number ?? detail.job_seq ?? detail.job_number;
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
                data-testid="payment-job-title"
                disabled={!detail.local_job_id}
                onClick={() => detail.local_job_id && navigate(`/jobs/by-id/${detail.local_job_id}`)}
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
                <div className="flex items-center gap-2.5 py-1">
                    <span style={rowLabel}>Status</span>
                    <Pill text={status} />
                </div>
            )}
            {tags.length > 0 && (
                <div className="flex items-center gap-2.5 py-1">
                    <span style={rowLabel}>Tags</span>
                    <span className="flex flex-wrap gap-1.5">
                        {tags.map(tag => (
                            <span
                                key={tag.id}
                                className="blanc-l2 inline-flex items-center px-2.5"
                                style={{ minHeight: 26, borderRadius: 8, background: 'var(--blanc-accent-soft)', color: 'var(--blanc-accent)' }}
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

/**
 * Providers for a payment with NO job behind it — imported rows can carry the
 * technician's name and nothing else. When there IS a job, JobTechnicianControl
 * inside JobInfoSections already renders Provider (and lets you reassign), so
 * this would be the same block printed twice.
 */
export function PaymentProviders({ detail, job }: { detail: PaymentDetail; job: LocalJob | null }) {
    if (job) return null;
    const names = (detail.job?.providers || []).map(provider => provider.name).filter(Boolean) as string[];
    if (names.length === 0) return null;

    return (
        <div>
            <p style={{ ...LEVEL_TWO_HEADING, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 7 }}>
                <UserRound size={15} style={{ color: 'var(--blanc-ink-1)', flexShrink: 0 }} />
                Provider
            </p>
            <span className="flex flex-wrap gap-1.5">
                {names.map(name => (
                    <span
                        key={name}
                        className="blanc-l2 inline-flex items-center gap-1.5 px-3.5"
                        style={{ minHeight: 34, borderRadius: 999, background: 'rgba(25,25,25,0.05)', border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-1)' }}
                    >
                        <UserRound className="size-3.5" style={{ color: 'var(--blanc-ink-3)' }} />
                        {name}
                    </span>
                ))}
            </span>
        </div>
    );
}
