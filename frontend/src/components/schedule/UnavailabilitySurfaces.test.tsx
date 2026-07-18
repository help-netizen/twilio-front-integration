import { describe, expect, it } from 'vitest';
import { filterUnavailabilityByProviders } from '../../services/scheduleFilters';
import type { UnavailabilityBlock } from '../../services/scheduleApi';
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
            expect(source).toContain('unavailabilityLabel');
        }
        expect(customTimeSource).toContain('unavailabilityLabel');
        expect(customTimeSource).toContain('tech-timeline__timeoff');
    });

    it('does not add the composite collection to generic Week', () => {
        expect(weekSource).not.toContain('UnavailabilityBlock');
        expect(weekSource).not.toContain('schedule_gap');
    });

    it('retains provider privacy filtering for the combined collection', () => {
        const blocks: UnavailabilityBlock[] = [
            { id: 'a', kind: 'schedule_gap', technician_id: 'a', technician_name: 'Alex', starts_at: '2026-07-20T00:00:00Z', ends_at: '2026-07-21T00:00:00Z', source: 'company', mutable: false },
            { id: 'b', kind: 'time_off', technician_id: 'b', technician_name: 'Blair', starts_at: '2026-07-20T00:00:00Z', ends_at: '2026-07-21T00:00:00Z', source: 'individual', mutable: true },
        ];
        expect(filterUnavailabilityByProviders(blocks, ['a'])).toEqual([blocks[0]]);
    });
});
