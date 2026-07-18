import { Checkbox } from '../ui/checkbox';
import { FloatingField } from '../ui/floating-field';
import type { TechnicianScheduleDay, WiderScheduleDay } from '../../services/techniciansApi';

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function minutes(value: string | null) {
    if (!value) return NaN;
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
}

export function findWiderScheduleDays(
    days: TechnicianScheduleDay[],
    companyDays: TechnicianScheduleDay[],
): WiderScheduleDay[] {
    const companyByDay = new Map(companyDays.map(day => [day.day_of_week, day]));
    return days.flatMap(day => {
        const company = companyByDay.get(day.day_of_week);
        if (!day.is_working || !company?.is_working
            || !day.work_start_time || !day.work_end_time
            || !company.work_start_time || !company.work_end_time) return [];
        if (minutes(day.work_start_time) >= minutes(company.work_start_time)
            && minutes(day.work_end_time) <= minutes(company.work_end_time)) return [];
        return [{
            day_of_week: day.day_of_week,
            day_name: DAY_NAMES[day.day_of_week].slice(0, 3),
            technician_interval: `${day.work_start_time}–${day.work_end_time}`,
            company_interval: `${company.work_start_time}–${company.work_end_time}`,
        }];
    });
}

interface TechnicianWeekEditorProps {
    days: TechnicianScheduleDay[];
    companyDays: TechnicianScheduleDay[];
    inherited: boolean;
    onChange: (days: TechnicianScheduleDay[]) => void;
}

export function updateScheduleDay(
    days: TechnicianScheduleDay[],
    companyDays: TechnicianScheduleDay[],
    dayOfWeek: number,
    patch: Partial<TechnicianScheduleDay>,
): TechnicianScheduleDay[] {
    const companyDay = companyDays.find(day => day.day_of_week === dayOfWeek);
    if (companyDay?.company_closed || companyDay?.is_working === false) return days;
    return days.map(day => day.day_of_week === dayOfWeek ? { ...day, ...patch } : day);
}

export function TechnicianWeekEditor({
    days,
    companyDays,
    inherited,
    onChange,
}: TechnicianWeekEditorProps) {
    const byDay = new Map(days.map(day => [day.day_of_week, day]));
    const companyByDay = new Map(companyDays.map(day => [day.day_of_week, day]));

    const toggleWorking = (day: TechnicianScheduleDay, companyDay: TechnicianScheduleDay) => {
        const isWorking = !day.is_working;
        onChange(updateScheduleDay(days, companyDays, day.day_of_week, {
            is_working: isWorking,
            work_start_time: isWorking
                ? (day.work_start_time || companyDay.work_start_time || '08:00')
                : null,
            work_end_time: isWorking
                ? (day.work_end_time || companyDay.work_end_time || '17:00')
                : null,
        }));
    };

    return (
        <div className="space-y-3.5">
            {DAY_ORDER.map(dayOfWeek => {
                const companyDay = companyByDay.get(dayOfWeek);
                const day = byDay.get(dayOfWeek) || companyDay;
                if (!day || !companyDay) return null;
                const companyClosed = companyDay.company_closed || !companyDay.is_working;
                const disabled = inherited || companyClosed;
                return (
                    <div
                        key={dayOfWeek}
                        className="grid grid-cols-[112px_1fr] items-start gap-3 sm:grid-cols-[112px_120px_1fr]"
                    >
                        <div className="pt-3 text-sm font-medium" style={{ color: 'var(--blanc-ink-1)' }}>
                            {DAY_NAMES[dayOfWeek]}
                        </div>
                        <label className="flex min-h-11 items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                            <Checkbox
                                checked={companyClosed ? false : day.is_working}
                                disabled={disabled}
                                aria-label={`${DAY_NAMES[dayOfWeek]} working`}
                                onCheckedChange={() => toggleWorking(day, companyDay)}
                            />
                            {companyClosed ? 'Day off' : day.is_working ? 'Working' : 'Day off'}
                        </label>

                        {companyClosed ? (
                            <div className="col-start-2 pt-1 text-xs sm:col-start-3 sm:pt-3" style={{ color: 'var(--blanc-ink-3)' }}>
                                Company closed
                            </div>
                        ) : day.is_working ? (
                            <div className="col-span-2 grid grid-cols-2 gap-3.5 sm:col-span-1">
                                <FloatingField
                                    id={`technician-schedule-${dayOfWeek}-start`}
                                    label="Start"
                                    type="time"
                                    value={day.work_start_time || ''}
                                    disabled={inherited}
                                    onChange={event => onChange(updateScheduleDay(
                                        days,
                                        companyDays,
                                        dayOfWeek,
                                        { work_start_time: event.target.value },
                                    ))}
                                />
                                <FloatingField
                                    id={`technician-schedule-${dayOfWeek}-end`}
                                    label="End"
                                    type="time"
                                    value={day.work_end_time || ''}
                                    disabled={inherited}
                                    onChange={event => onChange(updateScheduleDay(
                                        days,
                                        companyDays,
                                        dayOfWeek,
                                        { work_end_time: event.target.value },
                                    ))}
                                />
                            </div>
                        ) : (
                            <div className="col-start-2 pt-1 text-xs sm:col-start-3 sm:pt-3" style={{ color: 'var(--blanc-ink-3)' }}>
                                No recurring hours
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
