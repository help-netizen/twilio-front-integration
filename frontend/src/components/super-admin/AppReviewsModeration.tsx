import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import {
    fetchAppReviewQueue, moderateAppReview,
    type AppModerationReview, type AppReviewStatus,
} from '../../services/marketplaceApi';
import { Stars } from '../settings/marketplace/marketplaceUi';

/**
 * MARKETPLACE-RATINGS-001 super-admin queue — the "Apps reviews" section on the
 * Super admin page. Reviews flagged by the security gate or the LLM policy check
 * land in Pending; the super admin publishes (approve) or rejects them.
 * Backed by /api/platform/app-reviews (requirePlatformRole super_admin).
 */
const TABS: { id: AppReviewStatus; label: string }[] = [
    { id: 'pending', label: 'Pending' },
    { id: 'posted', label: 'Posted' },
    { id: 'rejected', label: 'Rejected' },
];

const SOURCE_LABEL: Record<string, string> = { security: 'Security gate', llm: 'Policy check', manual: 'Manual' };

function ReviewTile({ r, onModerate, busy }: {
    r: AppModerationReview;
    onModerate: (action: 'approve' | 'reject') => void;
    busy: boolean;
}) {
    return (
        <div className="rounded-2xl bg-[var(--blanc-surface-strong)] p-4" style={{ boxShadow: '0 1px 2px rgba(25,25,25,.04)' }}>
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-[15px] font-bold text-[var(--blanc-ink-1)]">{r.app_name}</span>
                        <Stars value={r.stars} size={13} />
                    </div>
                    <div className="mt-0.5 text-[12.5px] text-[var(--blanc-ink-3)]">
                        {r.reviewer_first_name || 'Someone'} · {r.company_name} · {new Date(r.created_at).toLocaleDateString()}
                    </div>
                </div>
                <div className="flex shrink-0 gap-2">
                    {r.status !== 'posted' && (
                        <Button size="sm" disabled={busy} onClick={() => onModerate('approve')}>Publish</Button>
                    )}
                    {r.status !== 'rejected' && (
                        <Button size="sm" variant="outline" disabled={busy}
                            className="text-[var(--blanc-danger,#F0503F)] hover:text-[var(--blanc-danger,#F0503F)]"
                            onClick={() => onModerate('reject')}>Reject</Button>
                    )}
                </div>
            </div>
            {r.comment && <p className="mt-2.5 whitespace-pre-wrap text-[13.5px] text-[var(--blanc-ink-2)]">{r.comment}</p>}
            {r.moderation_reason && (
                <p className="mt-2 text-[12px] text-[var(--blanc-ink-3)]">
                    {r.moderation_source ? `${SOURCE_LABEL[r.moderation_source] ?? r.moderation_source}: ` : ''}{r.moderation_reason}
                    {r.moderator_first_name ? ` — by ${r.moderator_first_name}` : ''}
                </p>
            )}
        </div>
    );
}

export function AppReviewsModeration() {
    const qc = useQueryClient();
    const [status, setStatus] = useState<AppReviewStatus>('pending');
    const q = useQuery({ queryKey: ['app-review-queue', status], queryFn: () => fetchAppReviewQueue(status) });
    const mod = useMutation({
        mutationFn: (v: { id: number; action: 'approve' | 'reject' }) => moderateAppReview(v.id, v.action),
        onSuccess: (_r, v) => {
            qc.invalidateQueries({ queryKey: ['app-review-queue'] });
            toast.success(v.action === 'approve' ? 'Review published' : 'Review rejected');
        },
        onError: (e: Error) => toast.error(e.message || 'Moderation failed'),
    });
    const reviews = q.data?.reviews ?? [];

    return (
        <section className="space-y-4">
            <div className="flex items-center gap-2">
                {TABS.map(t => (
                    <button key={t.id} type="button" onClick={() => setStatus(t.id)}
                        className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors ${
                            status === t.id ? 'bg-[var(--blanc-accent-soft)] text-[var(--blanc-accent-ink,#5b2bb0)]' : 'bg-[var(--blanc-surface-strong)] text-[var(--blanc-ink-2)] hover:text-[var(--blanc-ink-1)]'}`}
                        style={status !== t.id ? { boxShadow: '0 1px 2px rgba(25,25,25,.04)' } : undefined}>
                        {t.label}{status === t.id && q.data ? ` · ${q.data.total}` : ''}
                    </button>
                ))}
            </div>
            {q.isLoading ? (
                <p className="py-8 text-center text-sm text-[var(--blanc-ink-3)]">Loading reviews…</p>
            ) : q.isError ? (
                <p className="py-8 text-center text-sm text-[var(--blanc-danger,#F0503F)]">Could not load the review queue.</p>
            ) : reviews.length === 0 ? (
                <p className="py-8 text-center text-sm text-[var(--blanc-ink-3)]">No {status} reviews.</p>
            ) : (
                <div className="space-y-3">
                    {reviews.map(r => <ReviewTile key={r.id} r={r} busy={mod.isPending} onModerate={action => mod.mutate({ id: r.id, action })} />)}
                </div>
            )}
        </section>
    );
}
