/**
 * Existing mobile Schedule day-map shell.
 *
 * SCHEDULE-DESKTOP-MAP-001 moves grouping, coordinate gating, route ordering,
 * unique joint-job pins, and Google rendering onto the shared schedule-map
 * primitive. The mobile page's mount point, List/Map toggle, height, and error
 * behavior remain unchanged.
 */

import { useMemo } from 'react';
import type { ScheduleItem } from '../../services/scheduleApi';
import { ScheduleMapCanvas } from './ScheduleMapCanvas';
import { buildScheduleMapModel } from './scheduleMapModel';
import { useScheduleProviderColorRegistry } from './ScheduleProviderColorContext';

interface ScheduleJobsMapProps {
    jobs: ScheduleItem[];
    companyTz: string;
    selectedProviderIds?: string[];
}

export function ScheduleJobsMap({ jobs, companyTz, selectedProviderIds }: ScheduleJobsMapProps) {
    const registry = useScheduleProviderColorRegistry();
    const providerFilterKey = (selectedProviderIds || []).join('|');
    const model = useMemo(
        () => buildScheduleMapModel(jobs, selectedProviderIds || [], registry),
        // providerFilterKey prevents model churn for new-array/same-filter renders.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [jobs, providerFilterKey, registry],
    );

    return (
        <div
            className="relative overflow-hidden"
            style={{ height: 'calc(100dvh - 220px)', minHeight: 360, borderRadius: 16 }}
        >
            <ScheduleMapCanvas
                model={model}
                companyTz={companyTz}
                className="h-full w-full"
            />

            {model.notOnMap.length > 0 && (
                <div
                    className="absolute bottom-2 left-2 rounded-xl px-2.5 py-1.5 text-[12px]"
                    style={{
                        background: 'var(--blanc-surface-strong)',
                        border: '1px solid var(--blanc-line)',
                        color: 'var(--blanc-ink-3)',
                        boxShadow: 'var(--blanc-shadow-sm)',
                    }}
                >
                    {model.notOnMap.length} job{model.notOnMap.length === 1 ? '' : 's'} without a location
                </div>
            )}
        </div>
    );
}
