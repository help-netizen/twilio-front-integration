import { describe, expect, it } from 'vitest';
import calendarControlsSource from '../components/schedule/CalendarControls.tsx?raw';
import desktopMapSource from '../components/schedule/ScheduleDesktopMapPanel.tsx?raw';
import mobileMapSource from '../components/schedule/ScheduleJobsMap.tsx?raw';
import mapCanvasSource from '../components/schedule/ScheduleMapCanvas.tsx?raw';
import mapModelSource from '../components/schedule/scheduleMapModel.ts?raw';
import scheduleCardSource from '../components/schedule/ScheduleItemCard.tsx?raw';
import dayViewSource from '../components/schedule/DayView.tsx?raw';
import timelineViewSource from '../components/schedule/TimelineView.tsx?raw';
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

    it('keeps linked selection frames without dimming neighboring schedule cards', () => {
        expect(scheduleCardSource).not.toContain('dimmed');
        expect(scheduleCardSource).toContain("opacity: isCanceled ? 0.6 : 1");
        expect(scheduleCardSource).toContain("'0 0 0 3px var(--blanc-accent), var(--sched-shadow-card)'");
        expect(dayViewSource).not.toContain('dimmed=');
        expect(timelineViewSource).not.toContain('dimmed=');
        expect(desktopMapSource).not.toContain('dimmed');
        expect(mapCanvasSource).not.toContain('marker.setOpacity');
        // Owner: the selected/hovered pin must NOT resize — no active-dependent
        // scaledSize. Selection is conveyed by z-order only (and the linked card).
        expect(mapCanvasSource).not.toContain('active ? 40');
        expect(mapCanvasSource).not.toMatch(/pinWidth\s*=\s*active/);
        expect(mapCanvasSource).toContain('marker.setZIndex(active ? 1000 : 100)');
        expect(dayViewSource).toContain('selected={selectedItemKey ===');
        expect(timelineViewSource).toContain('selected={selectedItemKey === itemKey}');
    });
});
