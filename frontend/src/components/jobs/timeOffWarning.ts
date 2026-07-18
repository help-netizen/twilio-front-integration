/**
 * Shared company-time formatter for warning-only availability conflicts in
 * NewJobDialog and JobInfoSections. Warnings never disable manual actions.
 */
import { fetchDispatchSettings, type UnavailabilityBlock } from '../../services/scheduleApi';
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
export function formatUnavailabilityPeriod(block: UnavailabilityBlock, tz?: string): string {
    return `${formatDateTimeInTZ(new Date(block.starts_at), tz)} – ${formatDateTimeInTZ(new Date(block.ends_at), tz)}`;
}
