/**
 * JobsMobileList — the date-grouped tile list for the mobile Jobs page
 * (JOBS-MOBILE-001). Replaces the desktop table on phones.
 *
 * Groups `filteredJobs` by scheduled date (date-key in the company timezone from
 * start_date). Jobs with no start_date fall into a trailing "No date" group.
 * Groups are ordered by date descending (most recent first); WITHIN a day the
 * jobs read earliest scheduled time first (top-down). Friendly headers: Today /
 * Tomorrow / Yesterday, else "EEE, MMM d". A "Load more" button appears at the
 * end when there are more pages.
 *
 * Rendered only on mobile (JobsPage gates it behind useIsMobile); desktop uses
 * JobsTable, untouched.
 */

import React, { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import type { LocalJob } from '../../services/jobsApi';
import { dateKeyInTZ, todayInTZ } from '../../utils/companyTime';
import { useAuthz } from '../../hooks/useAuthz';
import { JobMobileCard } from './JobMobileCard';

const NO_DATE_KEY = '__no_date__';

interface JobsMobileListProps {
    filteredJobs: LocalJob[];
    loading: boolean;
    hasMore: boolean;
    onLoadMore: () => void;
    onSelectJob: (job: LocalJob) => void;
    timezone?: string;
}

/** Friendly group label from a "YYYY-MM-DD" date-key (or the No-date sentinel). */
function groupLabel(key: string, timezone?: string): string {
    if (key === NO_DATE_KEY) return 'No date';
    const today = todayInTZ(timezone);
    // today/tomorrow/yesterday in calendar terms (parse keys at local noon to
    // avoid any TZ-boundary drift when we only care about the date).
    const toDate = (k: string) => new Date(k + 'T12:00:00');
    const todayDate = toDate(today);
    const oneDay = 24 * 60 * 60 * 1000;
    const diffDays = Math.round((toDate(key).getTime() - todayDate.getTime()) / oneDay);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    if (diffDays === -1) return 'Yesterday';
    return format(toDate(key), 'EEE, MMM d');
}

export const JobsMobileList: React.FC<JobsMobileListProps> = ({
    filteredJobs, loading, hasMore, onLoadMore, onSelectJob, timezone,
}) => {
    const { hasPermission } = useAuthz();
    // Same finance gate JobDetailPanel uses (financial_data.view, fall back to
    // invoices.view) — resolved once here and threaded into every card.
    const canViewFinance = hasPermission('financial_data.view') || hasPermission('invoices.view');

    const groups = useMemo(() => {
        const map = new Map<string, LocalJob[]>();
        for (const job of filteredJobs) {
            const key = job.start_date ? dateKeyInTZ(job.start_date, timezone) : NO_DATE_KEY;
            const bucket = map.get(key);
            if (bucket) bucket.push(job);
            else map.set(key, [job]);
        }
        // Date groups descending; "No date" always trails.
        const keys = [...map.keys()];
        keys.sort((a, b) => {
            if (a === NO_DATE_KEY) return 1;
            if (b === NO_DATE_KEY) return -1;
            return a < b ? 1 : a > b ? -1 : 0;
        });
        // Within a day, show jobs EARLIEST scheduled time first. `filteredJobs` is
        // start_date DESC (for coherent date-grouped paging), which would otherwise
        // render each day bottom-up; sort each dated bucket ascending so the day reads
        // top-down. The "No date" bucket has no times — leave its order untouched.
        return keys.map(key => {
            const jobs = map.get(key)!;
            const ordered = key === NO_DATE_KEY
                ? jobs
                : [...jobs].sort((a, b) =>
                    new Date(a.start_date!).getTime() - new Date(b.start_date!).getTime());
            return { key, label: groupLabel(key, timezone), jobs: ordered };
        });
    }, [filteredJobs, timezone]);

    if (loading && filteredJobs.length === 0) {
        return (
            <div className="mobile-list-page__empty" style={{ color: 'var(--blanc-ink-3)' }}>
                <span className="inline-flex items-center"><Loader2 className="size-5 animate-spin mr-2" /> Loading…</span>
            </div>
        );
    }

    if (filteredJobs.length === 0) {
        return (
            <div className="mobile-list-page__empty" style={{ color: 'var(--blanc-ink-3)' }}>
                <p className="text-sm">No jobs</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-5 pb-6">
            {groups.map(group => (
                <div key={group.key} className="flex flex-col gap-2">
                    {/* Заголовок дня — sticky, но фон ПРОЗРАЧНЫЙ: текст на канвасе,
                        заливка запрещена (фидбек владельца, LAYOUT-CANON п.7) */}
                    <div className="blanc-eyebrow sticky top-0 z-[1] py-1">
                        {group.label}
                    </div>
                    <div className="flex flex-col gap-2.5">
                        {group.jobs.map(job => (
                            <JobMobileCard
                                key={job.id}
                                job={job}
                                timezone={timezone}
                                canViewFinance={canViewFinance}
                                onClick={onSelectJob}
                            />
                        ))}
                    </div>
                </div>
            ))}

            {hasMore && (
                <button
                    type="button"
                    onClick={onLoadMore}
                    disabled={loading}
                    className="flex items-center justify-center gap-2 w-full min-h-[46px] text-[14px] font-medium transition-opacity hover:opacity-70 disabled:opacity-50"
                    style={{ color: 'var(--blanc-ink-2)', background: 'transparent', border: '1px solid var(--blanc-line)', borderRadius: '14px' }}
                >
                    {loading ? <Loader2 className="size-4 animate-spin" /> : null}
                    {loading ? 'Loading…' : 'Load more'}
                </button>
            )}
        </div>
    );
};
