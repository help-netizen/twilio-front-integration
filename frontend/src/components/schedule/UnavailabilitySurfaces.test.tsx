import { describe, expect, it } from 'vitest';
import { filterUnavailabilityByProviders } from '../../services/scheduleFilters';
import {
    projectMainScheduleUnavailabilityForDay,
    projectMobileAgendaUnavailabilityForDay,
} from '../../services/scheduleDisplayUnavailability';
import type { UnavailabilityBlock } from '../../services/scheduleApi';
import { dateInTZ } from '../../utils/companyTime';
import timelineSource from './TimelineView.tsx?raw';
import timelineWeekSource from './TimelineWeekView.tsx?raw';
import daySource from './DayView.tsx?raw';
import weekSource from './WeekView.tsx?raw';
import customTimeSource from '../conversations/CustomTimeModal.tsx?raw';

const HATCH = 'repeating-linear-gradient(135deg, rgba(25, 25, 25, 0.04) 0 10px, rgba(25, 25, 25, 0.08) 10px 20px)';

describe('approved technician-aware unavailability surfaces', () => {
    it('keeps the exact existing hatch on Timeline, Team Week, mobile Day, and Custom Time', () => {
        for (const source of [timelineSource, timelineWeekSource, daySource]) {
            expect(source).toContain(HATCH);
            expect(source).toContain('filterUnavailabilityByProviders');
        }
        expect(timelineSource).toContain('projectMainScheduleUnavailabilityForDay');
        expect(timelineWeekSource).toContain('projectMainScheduleUnavailabilityForDay');
        expect(daySource).toContain('projectMobileAgendaUnavailabilityForDay');
        expect(customTimeSource).toContain('unavailabilityLabel');
        expect(customTimeSource).toContain('tech-timeline__timeoff');
        expect(customTimeSource).not.toContain('scheduleDisplayUnavailability');
    });

    it('does not add the composite collection to generic Week', () => {
        expect(weekSource).not.toContain('UnavailabilityBlock');
        expect(weekSource).not.toContain('schedule_gap');
    });

    it('retains provider privacy filtering for the combined collection', () => {
        const dayStart = dateInTZ(2026, 7, 20, 0, 0, 'America/New_York');
        const dayEnd = dateInTZ(2026, 7, 21, 0, 0, 'America/New_York');
        const blocks: UnavailabilityBlock[] = [
            { id: 'a', kind: 'schedule_gap', technician_id: 'a', technician_name: 'Alex', starts_at: dayStart.toISOString(), ends_at: dayEnd.toISOString(), source: 'company', mutable: false },
            { id: 'b', kind: 'time_off', technician_id: 'b', technician_name: 'Blair', starts_at: dayStart.toISOString(), ends_at: dayEnd.toISOString(), source: 'individual', mutable: true },
        ];
        const providerScoped = filterUnavailabilityByProviders(blocks, ['a']);
        expect(providerScoped).toEqual([blocks[0]]);
        expect(projectMainScheduleUnavailabilityForDay(providerScoped, dayStart, dayEnd))
            .toEqual([{ displayKind: 'company_closed', block: blocks[0] }]);
        const mobile = projectMobileAgendaUnavailabilityForDay(providerScoped, dayStart, dayEnd);
        expect(JSON.stringify(mobile)).not.toContain('Blair');
    });
});
