import { afterEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_COMPANY_TIME_ZONE,
    formatCompanyTime,
    resolveCompanyTimeZone,
} from './companyTime';

const originalTimeZone = process.env.TZ;

afterEach(() => {
    process.env.TZ = originalTimeZone;
});

describe('company time formatting', () => {
    it('renders one instant identically in UTC+5 and America/New_York browsers', () => {
        const instant = '2026-08-14T16:20:00.000Z';
        const options: Intl.DateTimeFormatOptions = {
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        };

        process.env.TZ = 'Etc/GMT-5';
        const remoteBrowser = formatCompanyTime(instant, options, 'America/New_York');
        process.env.TZ = 'America/New_York';
        const companyBrowser = formatCompanyTime(instant, options, 'America/New_York');

        expect(remoteBrowser).toBe(companyBrowser);
        expect(remoteBrowser).toBe('Aug 14, 12:20 PM');
    });

    it('falls back to America/New_York for an empty company timezone', () => {
        expect(resolveCompanyTimeZone('  ')).toBe(DEFAULT_COMPANY_TIME_ZONE);
        expect(formatCompanyTime('2026-08-14T16:20:00.000Z', {
            hour: 'numeric', minute: '2-digit',
        }, '')).toBe('12:20 PM');
    });

    it('keeps date-only values on their company calendar date', () => {
        process.env.TZ = 'Etc/GMT-5';
        const remoteBrowser = formatCompanyTime('2026-08-14', {
            month: 'short', day: 'numeric', year: 'numeric',
        }, 'America/New_York');
        process.env.TZ = 'America/New_York';
        const companyBrowser = formatCompanyTime('2026-08-14', {
            month: 'short', day: 'numeric', year: 'numeric',
        }, 'America/New_York');

        expect(remoteBrowser).toBe('Aug 14, 2026');
        expect(companyBrowser).toBe(remoteBrowser);
    });
});
