import { useState } from 'react';
import { ChevronDown, Loader2, Receipt } from 'lucide-react';
import { useJobDetail } from '../../hooks/useJobDetail';
import { JobInfoSections } from '../jobs/JobInfoSections';
import { JobDescription } from '../jobs/JobDescription';
import { NotesHistoryTabs } from '../shared/NotesHistoryTabs';
import { PaymentIdentity, InvoiceFigures } from './PaymentIdentity';
import { PaymentJobSection, PaymentProviders } from './PaymentJobSections';
import type { PaymentDetail } from './paymentTypes';

/**
 * The payment card, built to read like the job card.
 *
 * LEFT  — what this payment is (the amount is the title), where it leaves the
 *         invoice, then the job it belongs to and that job's own Contact,
 *         Scheduled and Location sections.
 * RIGHT — Description, Notes/History, Metadata. No Finance: the money that
 *         matters here is the one payment already at the top.
 *
 * The job sections, the description and the notes are the job card's own
 * components pointed at the same job — not lookalikes. That is what keeps call
 * masking, Call/Text, reschedule, tasks and note editing identical here without
 * a second implementation to drift.
 */
export function PaymentDetailPanel({
    detail, loading, onClose: _onClose, onToggleDeposited,
}: {
    detail: PaymentDetail | null;
    loading: boolean;
    onClose: () => void;
    onToggleDeposited: (deposited: boolean) => void;
}) {
    const [showMetadata, setShowMetadata] = useState(false);
    const jobDetail = useJobDetail({ jobId: detail?.local_job_id ?? null });

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center" style={{ color: 'var(--blanc-ink-3)' }}>
                <Loader2 className="size-5 animate-spin" />
            </div>
        );
    }

    if (!detail) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3" style={{ color: 'var(--blanc-ink-3)' }}>
                <Receipt className="size-10 opacity-20" />
                <p className="text-sm">Unable to load payment details.</p>
            </div>
        );
    }

    const job = jobDetail.job;

    return (
        <div className="flex h-full flex-col overflow-y-auto md:flex-row md:overflow-hidden">

            {/* ═══ LEFT — the payment, then the job it paid for ═══ */}
            <div className="w-full space-y-6 px-5 py-5 md:w-1/2 md:overflow-y-auto">
                <PaymentIdentity detail={detail} onToggleDeposited={onToggleDeposited} />
                <InvoiceFigures invoice={detail.invoice} />
                <PaymentJobSection detail={detail} job={job} />

                {job ? (
                    /* Indented under the job heading: Schedule, Location and Contact
                       describe THAT job, and the shift says so without drawing a
                       frame or a rail to say it. */
                    <div className="space-y-5 border-l pl-4" style={{ borderColor: 'var(--blanc-line)', marginTop: '-4px' }}>
                        {/* The job card's own sections — flat here, framed there. */}
                        <JobInfoSections
                            job={job}
                            contactInfo={jobDetail.contactInfo}
                            onJobUpdated={jobDetail.handleJobUpdated}
                            variant="flat"
                        />
                        <PaymentProviders detail={detail} job={job} />
                    </div>
                ) : (
                    <>
                        <PaymentProviders detail={detail} job={null} />
                        {detail.job?.service_address && (
                            <div>
                                <p className="blanc-eyebrow mb-2">Location</p>
                                <p className="text-[15px] font-medium">{detail.job.service_address}</p>
                            </div>
                        )}
                    </>
                )}

                {/* Mobile keeps one scroller: the right column's content follows here. */}
                <div className="space-y-6 md:hidden">
                    {job && <JobDescription job={job} onJobUpdated={jobDetail.handleJobUpdated} />}
                    {job && <NotesHistoryTabs entityType="job" entityId={job.id} />}
                    <MetadataSection metadata={detail.metadata} showMetadata={showMetadata} setShowMetadata={setShowMetadata} />
                </div>
            </div>

            {/* ═══ RIGHT — description, notes, metadata (desktop) ═══ */}
            <div
                className="hidden w-full flex-col space-y-6 overflow-y-auto px-5 py-5 md:flex md:w-1/2"
                style={{ borderLeft: '1px solid var(--blanc-line)' }}
            >
                {job ? (
                    <>
                        <JobDescription job={job} onJobUpdated={jobDetail.handleJobUpdated} />
                        <NotesHistoryTabs entityType="job" entityId={job.id} />
                    </>
                ) : (
                    <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                        This payment is not linked to a job, so there is nothing to describe or annotate.
                    </p>
                )}
                <MetadataSection metadata={detail.metadata} showMetadata={showMetadata} setShowMetadata={setShowMetadata} />
            </div>
        </div>
    );
}

// ─── Metadata Section ────────────────────────────────────────────────────────

function MetadataSection({ metadata, showMetadata, setShowMetadata }: {
    metadata: Record<string, string | null> | null | undefined;
    showMetadata: boolean;
    setShowMetadata: (v: boolean) => void;
}) {
    if (!metadata || Object.keys(metadata).length === 0) return null;

    return (
        <div>
            <button
                onClick={() => setShowMetadata(!showMetadata)}
                className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest transition-opacity hover:opacity-70"
                style={{ color: 'var(--blanc-ink-3)', letterSpacing: '0.14em', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
                <ChevronDown className="size-3" style={{ transform: showMetadata ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} />
                Transaction Metadata
            </button>
            {showMetadata && (
                <div className="mt-2 space-y-1">
                    {Object.entries(metadata).map(([key, val]) => val ? (
                        <div key={key} className="flex gap-2 text-[12px]">
                            <span style={{ color: 'var(--blanc-ink-3)', minWidth: 100, textTransform: 'capitalize' as const }}>{key.replace(/_/g, ' ')}</span>
                            <span className="font-mono text-[11px]" style={{ color: 'var(--blanc-ink-1)', wordBreak: 'break-all' as const }}>{val}</span>
                        </div>
                    ) : null)}
                </div>
            )}
        </div>
    );
}
