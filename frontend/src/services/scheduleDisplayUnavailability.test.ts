import { describe, expect, it } from 'vitest';
import type { UnavailabilityBlock } from './scheduleApi';
import {
    projectMainScheduleUnavailabilityForDay,
    projectMobileAgendaUnavailabilityForDay,
} from './scheduleDisplayUnavailability';
import { dateInTZ } from '../utils/companyTime';

const TZ = 'America/New_York';

function block(overrides: Partial<UnavailabilityBlock> = {}): UnavailabilityBlock {
    return {
        id: 'gap',
        kind: 'schedule_gap',
        technician_id: 'tech-1',
        technician_name: 'Alex Rivera',
        starts_at: '2026-07-20T04:00:00.000Z',
        ends_at: '2026-07-21T04:00:00.000Z',
        source: 'work_schedule',
        mutable: false,
        ...overrides,
    };
}

const dayStart = dateInTZ(2026, 7, 20, 0, 0, TZ);
const dayEnd = dateInTZ(2026, 7, 21, 0, 0, TZ);

describe('main Schedule display projection', () => {
    it('SAFETY-PARTIAL-GAPS-HIDDEN: omits before/after schedule gaps', () => {
        const before = block({
            id: 'before',
            starts_at: dayStart.toISOString(),
            ends_at: dateInTZ(2026, 7, 20, 9, 0, TZ).toISOString(),
            source: 'company',
        });
        const after = block({
            id: 'after',
            starts_at: dateInTZ(2026, 7, 20, 18, 0, TZ).toISOString(),
            ends_at: dayEnd.toISOString(),
        });

        expect(projectMainScheduleUnavailabilityForDay([before, after], dayStart, dayEnd)).toEqual([]);
    });

    it('SAFETY-FULL-DAY-SIGNAL: distinguishes technician day off from company closure', () => {
        const technicianDayOff = block({ id: 'tech-day-off' });
        const companyClosed = block({
            id: 'company-closed',
            technician_id: 'tech-2',
            technician_name: 'Blair Chen',
            source: 'company',
        });

        expect(projectMainScheduleUnavailabilityForDay(
            [technicianDayOff, companyClosed], dayStart, dayEnd,
        )).toEqual([
            { displayKind: 'day_off', block: technicianDayOff },
            { displayKind: 'company_closed', block: companyClosed },
        ]);
    });

    it('aggregates company closure to one anonymous mobile row from scoped blocks', () => {
        const own = block({ id: 'closed-own', source: 'company' });
        const other = block({
            id: 'closed-other',
            technician_id: 'tech-2',
            technician_name: 'Blair Chen',
            source: 'company',
        });

        const result = projectMobileAgendaUnavailabilityForDay([own, other], dayStart, dayEnd);
        expect(result).toEqual([{
            displayKind: 'company_closed',
            block: null,
            key: `company-closed:${dayStart.toISOString()}`,
        }]);
        expect(JSON.stringify(result)).not.toContain('Alex Rivera');
        expect(JSON.stringify(result)).not.toContain('Blair Chen');
    });

    it('SAFETY-TIME-OFF-PASSTHROUGH: retains the exact explicit block reference and fields', () => {
        const explicit = block({
            id: 'explicit',
            kind: 'time_off',
            starts_at: dateInTZ(2026, 7, 20, 13, 0, TZ).toISOString(),
            ends_at: dateInTZ(2026, 7, 20, 15, 0, TZ).toISOString(),
            note: 'Appointment',
            source: 'individual',
            mutable: true,
        });

        const result = projectMainScheduleUnavailabilityForDay([explicit], dayStart, dayEnd);
        expect(result).toEqual([{ displayKind: 'time_off', block: explicit }]);
        expect(result[0].block).toBe(explicit);
    });

    it.each([
        [2026, 3, 8, 23],
        [2026, 11, 1, 25],
    ])('recognizes a full local day across DST: %i-%i-%i (%i hours)', (year, month, day, hours) => {
        const start = dateInTZ(year, month, day, 0, 0, TZ);
        const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
        const end = dateInTZ(
            nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, nextDate.getUTCDate(), 0, 0, TZ,
        );
        expect((end.getTime() - start.getTime()) / 3_600_000).toBe(hours);
        expect(projectMainScheduleUnavailabilityForDay([
            block({ starts_at: start.toISOString(), ends_at: end.toISOString() }),
        ], start, end)).toHaveLength(1);
    });

    it('does not mutate the operational collection used by warnings and slots', () => {
        const partial = block({ ends_at: dateInTZ(2026, 7, 20, 9, 0, TZ).toISOString() });
        const input = [partial];
        projectMainScheduleUnavailabilityForDay(input, dayStart, dayEnd);
        expect(input).toEqual([partial]);
    });
});

