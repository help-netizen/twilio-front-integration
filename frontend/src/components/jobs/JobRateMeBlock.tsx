import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Loader2, Send } from 'lucide-react';
import { useAuth } from '../../auth/AuthProvider';
import { formatDateTimeInTZ } from '../../utils/companyTime';
import { getRateStatus } from '../../services/jobsApi';
import { Button } from '../ui/button';
import { RateLinkModal } from './RateLinkModal';

interface JobRateMeBlockProps {
    jobId: number;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    technicianName?: string;
    canSend: boolean;
    onSent?: (jobId: number) => void;
}

function TimelineStep({ label, timestamp, timezone }: {
    label: string;
    timestamp: string;
    timezone: string;
}) {
    return (
        <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
            <div className="min-w-0">
                <p className="text-sm font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>{label}</p>
                <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                    {formatDateTimeInTZ(new Date(timestamp), timezone)}
                </p>
            </div>
        </div>
    );
}

function sentViaLabel(sentVia: string | null): string {
    if (sentVia === 'sms') return 'SMS';
    if (sentVia === 'email') return 'Email';
    if (sentVia === 'copy') return 'Copy link';
    return sentVia || 'link';
}

export function JobRateMeBlock({
    jobId, customerName, customerPhone, customerEmail, technicianName, canSend, onSent,
}: JobRateMeBlockProps) {
    const { company } = useAuth();
    const timezone = company?.timezone || 'America/New_York';
    const [modalOpen, setModalOpen] = useState(false);
    const statusQuery = useQuery({
        queryKey: ['job-rate-status', jobId],
        queryFn: () => getRateStatus(jobId),
        enabled: jobId > 0,
    });
    const status = statusQuery.data;
    const showTimeline = Boolean(status?.has_token || status?.rating);

    const refreshAfterSend = async () => {
        await statusQuery.refetch();
        onSent?.(jobId);
    };

    return (
        <section className="space-y-3.5" aria-label="Rate Me">
            <p className="blanc-eyebrow">Rate Me</p>

            {statusQuery.isLoading && (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                    <Loader2 className="size-4 animate-spin" /> Loading rating activity…
                </div>
            )}

            {statusQuery.isError && (
                <p className="text-sm" style={{ color: 'var(--blanc-danger)' }}>
                    Couldn't load rating activity.
                </p>
            )}

            {showTimeline && status && (
                <div className="space-y-3.5">
                    {status.sent_at && (
                        <TimelineStep
                            label={`Rating link sent · via ${sentViaLabel(status.sent_via)}`}
                            timestamp={status.sent_at}
                            timezone={timezone}
                        />
                    )}
                    {status.opened_at && (
                        <TimelineStep label="Opened" timestamp={status.opened_at} timezone={timezone} />
                    )}
                    {status.rating?.created_at && (
                        <TimelineStep
                            label={`Rated ★${status.rating.stars}`}
                            timestamp={status.rating.created_at}
                            timezone={timezone}
                        />
                    )}
                    {status.google_click_at && (
                        <TimelineStep
                            label="Opened Google review"
                            timestamp={status.google_click_at}
                            timezone={timezone}
                        />
                    )}
                </div>
            )}

            {canSend && (
                <>
                    <Button
                        type="button"
                        className="w-full"
                        onClick={() => setModalOpen(true)}
                        style={{ backgroundColor: 'var(--blanc-accent)' }}
                    >
                        <Send className="size-4" /> Send rating link
                    </Button>
                    <RateLinkModal
                        open={modalOpen}
                        onClose={() => setModalOpen(false)}
                        jobId={jobId}
                        customerName={customerName}
                        customerPhone={customerPhone}
                        customerEmail={customerEmail}
                        technicianName={technicianName}
                        onSuccess={refreshAfterSend}
                    />
                </>
            )}
        </section>
    );
}
