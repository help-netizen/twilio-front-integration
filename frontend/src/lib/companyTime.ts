import { useCallback } from 'react';
import { useAuth } from '../auth/AuthProvider';

export const DEFAULT_COMPANY_TIME_ZONE = 'America/New_York';

export type CompanyTimeValue = Date | string | number;

export function resolveCompanyTimeZone(timeZone?: string | null): string {
    return timeZone?.trim() || DEFAULT_COMPANY_TIME_ZONE;
}

function dateOnlyInTimeZone(value: string, timeZone: string): Date {
    const [year, month, day] = value.split('-').map(Number);
    // Noon avoids midnight DST gaps. Shift the nominal UTC wall time by the
    // company's offset so Intl sees the same calendar date in that company.
    const utcGuess = new Date(Date.UTC(year, month - 1, day, 12));
    const offsetPart = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: 'longOffset',
    }).formatToParts(utcGuess).find(part => part.type === 'timeZoneName')?.value || 'GMT';
    const match = offsetPart.match(/^GMT([+-])(\d{2}):(\d{2})$/);
    const offsetMinutes = match
        ? (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3]))
        : 0;
    return new Date(utcGuess.getTime() - offsetMinutes * 60_000);
}

export function formatCompanyTime(
    value: CompanyTimeValue,
    options: Intl.DateTimeFormatOptions,
    timeZone?: string | null,
    locales: Intl.LocalesArgument = 'en-US',
): string {
    const resolvedTimeZone = resolveCompanyTimeZone(timeZone);
    const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? dateOnlyInTimeZone(value, resolvedTimeZone)
        : value instanceof Date ? value : new Date(value);
    return new Intl.DateTimeFormat(locales, {
        ...options,
        timeZone: resolvedTimeZone,
    }).format(date);
}

export function useCompanyTime() {
    const { company } = useAuth();
    const timeZone = resolveCompanyTimeZone(company?.timezone);
    const format = useCallback((
        value: CompanyTimeValue,
        options: Intl.DateTimeFormatOptions,
        locales: Intl.LocalesArgument = 'en-US',
    ) => formatCompanyTime(value, options, timeZone, locales), [timeZone]);

    return { timeZone, format };
}
