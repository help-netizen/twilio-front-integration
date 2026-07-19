/**
 * JobsMobileList — the date-grouped tile list for the mobile Jobs page
 * (JOBS-MOBILE-001). Replaces the desktop table on phones.
 *
 * Groups `jobs` by scheduled date (date-key in the company timezone from
 * start_date). Jobs with no start_date fall into a trailing "No date" group.
 * Groups and jobs retain the shared server order (`start_date DESC, id DESC`).
 * Friendly headers: Today / Tomorrow / Yesterday, else "EEE, MMM d". The
 * shared manual pagination footer follows the groups.
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
import { LoadMoreFooter, type LoadMoreFooterProps } from '../lists/LoadMoreFooter';

const NO_DATE_KEY = '__no_date__';

interface JobsMobileListProps {
    jobs: LocalJob[];
    loading: boolean;
    footerProps: LoadMoreFooterProps;
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
    jobs, loading, footerProps, onSelectJob, timezone,
}) => {
    const { hasPermission } = useAuthz();
    // Same finance gate JobDetailPanel uses (financial_data.view, fall back to
    // invoices.view) — resolved once here and threaded into every card.
    const canViewFinance = hasPermission('financial_data.view') || hasPermission('invoices.view');

    const groups = useMemo(() => {
        const map = new Map<string, LocalJob[]>();
        for (const job of jobs) {
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
        return keys.map(key => ({ key, label: groupLabel(key, timezone), jobs: map.get(key)! }));
    }, [jobs, timezone]);

    if (loading && jobs.length === 0) {
        return (
            <div className="mobile-list-page__empty" style={{ color: 'var(--blanc-ink-3)' }}>
                <span className="inline-flex items-center"><Loader2 className="size-5 animate-spin mr-2" /> Loading…</span>
            </div>
        );
    }

    if (jobs.length === 0) {
        if (footerProps.state === 'error+retry') {
            return <LoadMoreFooter {...footerProps} />;
        }
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
                    {/* Заголовок дня — текст на канвасе: без заливки И без sticky
                        (финал владельца: прозрачный sticky сливается с плитками) */}
                    <div className="blanc-eyebrow py-1">
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

            <LoadMoreFooter {...footerProps} />
        </div>
    );
};
