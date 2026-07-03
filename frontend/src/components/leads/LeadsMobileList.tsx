/**
 * LeadsMobileList — the date-grouped tile list for the mobile Leads page
 * (LEADS-MOBILE-001). Replaces the desktop table on phones.
 *
 * Groups `filteredLeads` by created date (date-key in the company timezone from
 * CreatedDate). Leads with no CreatedDate fall into a trailing "No date" group.
 * Groups are ordered by date descending (freshest first), matching the default
 * CreatedDate-desc client sort. Friendly headers: Today / Tomorrow / Yesterday,
 * else "EEE, MMM d". A "Load more" button appears at the end when there are more
 * pages.
 *
 * Rendered only on mobile (LeadsPage gates it behind useIsMobile); desktop uses
 * LeadsTable, untouched.
 */

import React, { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import type { Lead } from '../../types/lead';
import { dateKeyInTZ, todayInTZ } from '../../utils/companyTime';
import { LeadMobileCard } from './LeadMobileCard';

const NO_DATE_KEY = '__no_date__';

interface LeadsMobileListProps {
    filteredLeads: Lead[];
    loading: boolean;
    hasMore: boolean;
    onLoadMore: () => void;
    onSelectLead: (lead: Lead) => void;
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

export const LeadsMobileList: React.FC<LeadsMobileListProps> = ({
    filteredLeads, loading, hasMore, onLoadMore, onSelectLead, timezone,
}) => {
    const groups = useMemo(() => {
        const map = new Map<string, Lead[]>();
        for (const lead of filteredLeads) {
            const key = lead.CreatedDate ? dateKeyInTZ(lead.CreatedDate, timezone) : NO_DATE_KEY;
            const bucket = map.get(key);
            if (bucket) bucket.push(lead);
            else map.set(key, [lead]);
        }
        // Date groups descending; "No date" always trails.
        const keys = [...map.keys()];
        keys.sort((a, b) => {
            if (a === NO_DATE_KEY) return 1;
            if (b === NO_DATE_KEY) return -1;
            return a < b ? 1 : a > b ? -1 : 0;
        });
        return keys.map(key => ({ key, label: groupLabel(key, timezone), leads: map.get(key)! }));
    }, [filteredLeads, timezone]);

    if (loading && filteredLeads.length === 0) {
        return (
            <div className="mobile-list-page__empty" style={{ color: 'var(--blanc-ink-3)' }}>
                <span className="inline-flex items-center"><Loader2 className="size-5 animate-spin mr-2" /> Loading…</span>
            </div>
        );
    }

    if (filteredLeads.length === 0) {
        return (
            <div className="mobile-list-page__empty" style={{ color: 'var(--blanc-ink-3)' }}>
                <p className="text-sm">No leads</p>
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
                        {group.leads.map(lead => (
                            <LeadMobileCard
                                key={lead.UUID}
                                lead={lead}
                                onClick={onSelectLead}
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
