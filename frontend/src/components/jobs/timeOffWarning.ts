/**
 * TECH-DAYOFF-001 S-12/S-13 — tiny shared helpers for the warning-only
 * day-off conflict hints in NewJobDialog (create-from-slot / new job) and
 * JobInfoSections (reschedule from the Job card).
 *
 * Warnings are best-effort and NEVER block: callers catch fetch failures and
 * simply skip the hint (consistent with the useScheduleData best-effort canon).
 */
import { fetchDispatchSettings, type TimeOffBlock } from '../../services/scheduleApi';
import { formatDateTimeInTZ } from '../../utils/companyTime';

// Company timezone, fetched once per page load (dispatch settings rarely
// change). Failure resolves to undefined → period formats in the browser tz
// (best-effort, warning still shows). A failed fetch is retried next call.
let tzPromise: Promise<string | undefined> | null = null;

export function getCompanyTimezone(): Promise<string | undefined> {
    if (!tzPromise) {
        tzPromise = fetchDispatchSettings()
            .then(s => s.timezone || undefined)
            .catch(() => { tzPromise = null; return undefined; });
    }
    return tzPromise;
}

/** "Mar 30, 2026 1:00 PM – Mar 31, 2026 9:00 AM" in the company tz. */
export function formatTimeOffPeriod(block: TimeOffBlock, tz?: string): string {
    return `${formatDateTimeInTZ(new Date(block.starts_at), tz)} – ${formatDateTimeInTZ(new Date(block.ends_at), tz)}`;
}
