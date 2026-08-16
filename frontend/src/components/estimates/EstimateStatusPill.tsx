import type { Estimate } from '../../services/estimatesApi';

/**
 * ONE status vocabulary for estimates — the list and the detail must not tell
 * the customer's story with different words.
 *
 * The label carries the AGE, because how long a proposal has been waiting is the
 * reason to act on it: "Sent yesterday" is a decision, "sent" is trivia. Past a
 * week the age stops helping and goes quiet rather than shouting "43 days ago"
 * at someone who already knows.
 */

export function ago(value: string | null | undefined): string {
    if (!value) return '';
    const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
    if (!Number.isFinite(days) || days < 0) return '';
    if (days === 0) return ' today';
    if (days === 1) return ' yesterday';
    if (days <= 7) return ` ${days} days ago`;
    return '';
}

const TONE: Record<string, { background: string; color: string }> = {
    draft: { background: 'rgba(25,25,25,.06)', color: 'var(--blanc-ink-2)' },
    sent: { background: 'rgba(47,99,216,.10)', color: 'var(--blanc-job)' },
    viewed: { background: 'var(--blanc-accent-soft)', color: 'var(--blanc-accent)' },
    approved: { background: 'rgba(27,139,99,.10)', color: 'var(--blanc-success)' },
    declined: { background: 'rgba(240,80,63,.10)', color: 'var(--blanc-danger)' },
};

export function estimateStatusLabel(estimate: Estimate): string {
    switch (estimate.status) {
        case 'draft': return 'Draft · not sent';
        case 'sent': return `Sent${ago(estimate.sent_at)}`;
        // `viewed_at` is when the CUSTOMER opened it; `updated_at` moves for
        // reasons that have nothing to do with them.
        case 'viewed': return `Opened${ago(estimate.viewed_at || estimate.updated_at)}`;
        case 'approved': return 'Approved';
        case 'declined': return 'Declined';
        default: return estimate.status;
    }
}

export function StatusPill({ estimate }: { estimate: Estimate }) {
    const tone = TONE[estimate.status] || TONE.draft;
    return (
        <span
            className="blanc-l2 inline-flex items-center px-2.5"
            style={{ ...tone, minHeight: 26, borderRadius: 8 }}
            data-testid="estimate-status"
        >
            {estimateStatusLabel(estimate)}
        </span>
    );
}
