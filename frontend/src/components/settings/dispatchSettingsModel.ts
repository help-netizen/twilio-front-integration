import type { DispatchSettings } from '../../services/scheduleApi';

export function dispatchSettingsValidationError(settings: DispatchSettings): string | null {
    if (settings.work_end_time <= settings.work_start_time) return 'End time must be after start time';
    if (settings.work_days.length === 0) return 'Select at least one work day';
    return null;
}
