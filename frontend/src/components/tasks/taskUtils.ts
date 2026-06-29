import { serverDate } from '../../utils/serverClock';
import { dateInTZ, tomorrowAtInTZ, todayInTZ, dateKeyInTZ, formatTimeInTZ, formatDateTimeInTZ } from '../../utils/companyTime';
import type { Task } from './tasksApi';

/** Morning hour a snoozed-to-a-day task lands on. */
export const SNOOZE_MORNING_HOUR = 8;
/** Default deadline time for a new task (5 PM company TZ). */
export const DEFAULT_DUE_HOUR = 17;

export function isOverdue(task: Pick<Task, 'status' | 'due_at'>): boolean {
    if (task.status !== 'open' || !task.due_at) return false;
    return new Date(task.due_at).getTime() < serverDate().getTime();
}

/** Friendly deadline label: "Today 9:00 AM" / "Tomorrow 8:00 AM" / "Jun 30, 5:00 PM". */
export function formatDeadline(dueAt: string | null, tz: string): string {
    if (!dueAt) return 'No deadline';
    const key = dateKeyInTZ(dueAt, tz);
    const today = todayInTZ(tz);
    const [ty, tm, td] = today.split('-').map(Number);
    const tomorrow = dateKeyInTZ(dateInTZ(ty, tm, td + 1, 12, 0, tz).toISOString(), tz);
    const time = formatTimeInTZ(new Date(dueAt), tz);
    if (key === today) return `Today ${time}`;
    if (key === tomorrow) return `Tomorrow ${time}`;
    return formatDateTimeInTZ(new Date(dueAt), tz);
}

export interface SnoozePreset {
    key: string;
    label: string;
    dueIso: string;
}

/** The four relative/named snooze presets (custom date handled separately). */
export function snoozePresets(tz: string): SnoozePreset[] {
    const now = serverDate().getTime();
    const rel = (ms: number) => new Date(now + ms).toISOString();
    return [
        { key: '15m', label: 'In 15 minutes', dueIso: rel(15 * 60_000) },
        { key: '1h', label: 'In 1 hour', dueIso: rel(60 * 60_000) },
        { key: '3h', label: 'In 3 hours', dueIso: rel(3 * 60 * 60_000) },
        { key: 'tomorrow', label: `Tomorrow · ${SNOOZE_MORNING_HOUR}:00 AM`, dueIso: tomorrowAtInTZ(SNOOZE_MORNING_HOUR, 0, tz).toISOString() },
    ];
}

/** A picked "YYYY-MM-DD" → ISO at the morning hour in company TZ. */
export function customDateToDueIso(ymd: string, tz: string): string | null {
    const parts = ymd.split('-').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
    const [y, m, d] = parts;
    return dateInTZ(y, m, d, SNOOZE_MORNING_HOUR, 0, tz).toISOString();
}

/** Default due_at for a new task: today at DEFAULT_DUE_HOUR company TZ, as a date+time. */
export function defaultDueIso(tz: string): string {
    const [y, m, d] = todayInTZ(tz).split('-').map(Number);
    return dateInTZ(y, m, d, DEFAULT_DUE_HOUR, 0, tz).toISOString();
}

/** Split an ISO instant into the {date:"YYYY-MM-DD", time:"HH:MM"} wall-clock parts in tz, for form inputs. */
export function isoToLocalParts(iso: string | null, tz: string): { date: string; time: string } {
    if (!iso) return { date: '', time: '' };
    const d = new Date(iso);
    const date = dateKeyInTZ(iso, tz);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
    const hh = parts.find(p => p.type === 'hour')?.value ?? '00';
    const mm = parts.find(p => p.type === 'minute')?.value ?? '00';
    return { date, time: `${hh === '24' ? '00' : hh}:${mm}` };
}

/** Combine form {date,time} wall-clock parts in tz back to an ISO instant. */
export function localPartsToIso(date: string, time: string, tz: string): string | null {
    if (!date) return null;
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = (time || '00:00').split(':').map(Number);
    if ([y, m, d].some(Number.isNaN)) return null;
    return dateInTZ(y, m, d, hh || 0, mm || 0, tz).toISOString();
}
