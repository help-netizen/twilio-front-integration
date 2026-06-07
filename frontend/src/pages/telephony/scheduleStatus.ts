interface ScheduleDay {
    day: string;
    open: string;
    close: string;
}

interface ScheduleLike {
    timezone?: string;
    hours?: ScheduleDay[];
}

const DAY_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function minutesFromTime(value: string): number | null {
    const match = /^(\d{1,2}):(\d{2})/.exec(value || '');
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
}

function formatTime(value: string): string {
    const mins = minutesFromTime(value);
    if (mins == null) return value;
    const hour24 = Math.floor(mins / 60);
    const minute = mins % 60;
    const suffix = hour24 < 12 ? 'AM' : 'PM';
    const hour12 = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24;
    return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function localParts(now: Date, timezone: string): { day: string; minutes: number } {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone || 'America/New_York',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
    const hour = parts.hour === '24' ? 0 : Number(parts.hour);
    const minute = Number(parts.minute);
    return {
        day: parts.weekday || 'Mon',
        minutes: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
    };
}

export function getScheduleStatus(schedule: ScheduleLike, now = new Date()) {
    const timezone = schedule.timezone || 'America/New_York';
    const hours = schedule.hours || [];
    const byDay = new Map(hours.map(day => [day.day, day]));
    const current = localParts(now, timezone);
    const today = byDay.get(current.day);
    const todayOpen = today && today.open !== 'Closed' ? minutesFromTime(today.open) : null;
    const todayClose = today && today.close ? minutesFromTime(today.close) : null;

    if (todayOpen != null && todayClose != null && current.minutes >= todayOpen && current.minutes < todayClose) {
        const closeTime = today?.close || '';
        return {
            isOpen: true,
            label: `Open now - closes ${formatTime(closeTime)}`,
            shortLabel: 'Open now',
        };
    }

    const todayIndex = DAY_ORDER.indexOf(current.day);
    for (let offset = 0; offset < 7; offset += 1) {
        const day = DAY_ORDER[(todayIndex + offset + DAY_ORDER.length) % DAY_ORDER.length];
        const row = byDay.get(day);
        if (!row || row.open === 'Closed') continue;
        const openMinutes = minutesFromTime(row.open);
        if (openMinutes == null) continue;
        if (offset === 0 && openMinutes <= current.minutes) continue;
        return {
            isOpen: false,
            label: `Closed - opens ${day} ${formatTime(row.open)}`,
            shortLabel: 'Closed',
        };
    }

    return {
        isOpen: false,
        label: 'Closed - no open hours',
        shortLabel: 'Closed',
    };
}
