import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../ui/checkbox', () => ({
    Checkbox: ({ checked, disabled, ...props }: { checked?: boolean; disabled?: boolean }) => (
        <input type="checkbox" checked={checked} disabled={disabled} readOnly {...props} />
    ),
}));

import { findWiderScheduleDays, TechnicianWeekEditor, updateScheduleDay } from './TechnicianWeekEditor';
import type { TechnicianScheduleDay } from '../../services/techniciansApi';

const companyDays: TechnicianScheduleDay[] = Array.from({ length: 7 }, (_, day) => ({
    day_of_week: day,
    is_working: day >= 1 && day <= 5,
    work_start_time: day >= 1 && day <= 5 ? '08:00' : null,
    work_end_time: day >= 1 && day <= 5 ? '18:00' : null,
    company_closed: day === 0 || day === 6,
    source: 'company',
}));

describe('technician weekly schedule editor', () => {
    it('renders inherited company hours visibly but disabled, including company-closed text', () => {
        const markup = renderToStaticMarkup(
            <TechnicianWeekEditor
                days={companyDays}
                companyDays={companyDays}
                inherited
                onChange={() => {}}
            />,
        );
        expect(markup).toContain('Monday');
        expect(markup).toContain('value="08:00"');
        expect(markup).toContain('disabled=""');
        expect(markup).toContain('Company closed');
    });

    it('never lets an editor patch open a company-closed weekday', () => {
        const result = updateScheduleDay(companyDays, companyDays, 0, {
            is_working: true,
            work_start_time: '10:00',
            work_end_time: '14:00',
        });
        expect(result).toBe(companyDays);
        expect(result.find(day => day.day_of_week === 0)?.is_working).toBe(false);
    });

    it('allows wider hours on an open weekday and names the non-blocking notice', () => {
        const custom = companyDays.map(day => day.day_of_week === 1
            ? { ...day, work_start_time: '07:00', work_end_time: '19:00' }
            : { ...day });
        expect(findWiderScheduleDays(custom, companyDays)).toEqual([{
            day_of_week: 1,
            day_name: 'Mon',
            technician_interval: '07:00–19:00',
            company_interval: '08:00–18:00',
        }]);
    });
});
