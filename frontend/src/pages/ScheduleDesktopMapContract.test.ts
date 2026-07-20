import { describe, expect, it } from 'vitest';
import calendarControlsSource from '../components/schedule/CalendarControls.tsx?raw';
import desktopMapSource from '../components/schedule/ScheduleDesktopMapPanel.tsx?raw';
import mobileMapSource from '../components/schedule/ScheduleJobsMap.tsx?raw';
import mapCanvasSource from '../components/schedule/ScheduleMapCanvas.tsx?raw';
import mapModelSource from '../components/schedule/scheduleMapModel.ts?raw';
import schedulePageSource from './SchedulePage.tsx?raw';

describe('Schedule desktop map composition contract', () => {
    it('keeps the responsive map switch inside the recomposed action row', () => {
        const actionsStart = calendarControlsSource.indexOf('schedule-controls-actions');
        const mapControl = calendarControlsSource.indexOf('{showMapControl && onToggleMap && (');
        const filters = calendarControlsSource.indexOf('setFilterDropdownOpen', mapControl);
        expect(actionsStart).toBeGreaterThan(-1);
        expect(mapControl).toBeGreaterThan(actionsStart);
        expect(filters).toBeGreaterThan(mapControl);
        expect(schedulePageSource).toContain('const isBelowMapSplit = useIsMobile(1280)');
        expect(schedulePageSource).toContain("schedule.viewMode === 'day' || schedule.viewMode === 'timeline'");
        expect(schedulePageSource).toContain('showMapControl={desktopMapEligible}');
    });

    it('uses one shared renderer for mobile and desktop map surfaces', () => {
        expect(mobileMapSource).toContain('<ScheduleMapCanvas');
        expect(desktopMapSource).toContain('<ScheduleMapCanvas');
        expect(mapCanvasSource).toContain('export const ScheduleMapCanvas = memo');
    });

    it('conditionally renders the Not on the map panel and wires no-pan selection copy', () => {
        expect(desktopMapSource).toContain('{showNotOnMapPanel(model) && (');
        expect(mapModelSource).toContain("'Address not on the map yet'");
        expect(desktopMapSource).toContain('The map does not pan without coordinates.');
        expect(desktopMapSource).toContain('onClick={() => onSelectJob(entry.job)}');
    });

    it('memoizes model geometry independently of grid tick rendering', () => {
        expect(desktopMapSource).toContain('const model = useMemo(');
        expect(desktopMapSource).toContain('export const ScheduleDesktopMapPanel = memo');
        expect(mapCanvasSource).toContain('[status, model, companyTz]');
        expect(mapCanvasSource).toContain('[selectedJobKey, hoveredJobKey, model]');
    });
});
