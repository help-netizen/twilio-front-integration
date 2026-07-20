import { describe, expect, it } from 'vitest';
import calendarControlsSource from '../components/schedule/CalendarControls.tsx?raw';
import mobileScheduleBarSource from '../components/schedule/MobileScheduleBar.tsx?raw';
import scheduleToolbarSource from '../components/schedule/ScheduleToolbar.tsx?raw';
import schedulePageSource from './SchedulePage.tsx?raw';

describe('Schedule header composition contract', () => {
    it('uses the shared desktop title and ghost-search composition', () => {
        expect(scheduleToolbarSource).toContain('className="blanc-unified-header"');
        expect(scheduleToolbarSource).toContain('className="blanc-header-title">Schedule');
        expect(scheduleToolbarSource).toContain('className="blanc-search-wrapper"');
        expect(scheduleToolbarSource).toContain('placeholder="type to find anything..."');
        expect(scheduleToolbarSource).toContain('className="blanc-search-input"');
        expect(schedulePageSource).toContain("searchValue={schedule.filters.search || ''}");
    });

    it('keeps every desktop calendar action in one non-shrinking wrapping row', () => {
        expect(calendarControlsSource).toContain('schedule-controls-row flex flex-wrap items-center');
        expect(calendarControlsSource).toContain('flex shrink-0 items-center gap-2');
        expect(calendarControlsSource).toContain('schedule-controls-actions ml-auto flex shrink-0 flex-wrap');
        expect(calendarControlsSource).toContain('onClick={onTimeOff}');
        expect(calendarControlsSource).toContain('Time off');
        expect(schedulePageSource).toContain('onTimeOff={canDispatch ? () => setTimeOffOpen(true) : undefined}');
        expect(schedulePageSource).not.toContain("import { CalendarOff } from 'lucide-react'");
    });

    it('keeps mobile search in View options and removes the AI placeholder everywhere', () => {
        expect(mobileScheduleBarSource).toContain('title="View options"');
        expect(mobileScheduleBarSource).toContain('placeholder="Search..."');

        const scheduleSources = [
            schedulePageSource,
            scheduleToolbarSource,
            calendarControlsSource,
            mobileScheduleBarSource,
        ].join('\n');
        expect(scheduleSources).not.toMatch(/AI Assistant|AIAssistant|onToggleAIAssistant/);
    });
});
