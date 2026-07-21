import { memo, useMemo } from 'react';
import type { ScheduleItem } from '../../services/scheduleApi';
import { formatTimeInTZ } from '../../utils/companyTime';
import { ScheduleMapCanvas } from './ScheduleMapCanvas';
import {
    buildScheduleMapModel,
    showNotOnMapPanel,
} from './scheduleMapModel';
import { useScheduleProviderColorRegistry } from './ScheduleProviderColorContext';

interface ScheduleDesktopMapPanelProps {
    jobs: ScheduleItem[];
    companyTz: string;
    selectedProviderIds?: string[];
    selectedJobKey?: string | null;
    hoveredJobKey?: string | null;
    onSelectJob: (job: ScheduleItem) => void;
    onHoverJob: (jobKey: string | null) => void;
    split: boolean;
}

export const ScheduleDesktopMapPanel = memo(function ScheduleDesktopMapPanel({
    jobs,
    companyTz,
    selectedProviderIds,
    selectedJobKey,
    hoveredJobKey,
    onSelectJob,
    onHoverJob,
    split,
}: ScheduleDesktopMapPanelProps) {
    const registry = useScheduleProviderColorRegistry();
    const providerFilterKey = (selectedProviderIds || []).join('|');
    const filteredJobs = useMemo(
        () => jobs.filter(job => job.entity_type === 'job'),
        [jobs],
    );
    const model = useMemo(
        () => buildScheduleMapModel(filteredJobs, selectedProviderIds || [], registry),
        // The string key avoids rebuilding geometry for equivalent filter arrays.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [filteredJobs, providerFilterKey, registry],
    );
    const panelVisible = showNotOnMapPanel(model);
    const arithmetic = panelVisible
        ? `+ ${model.notOnMap.length} not on map = ${model.totalJobs} filtered jobs`
        : `= ${model.totalJobs} filtered ${model.totalJobs === 1 ? 'job' : 'jobs'}`;

    return (
        <section
            aria-label="Filtered technician routes"
            className={`flex min-h-[560px] flex-col overflow-hidden ${split ? 'xl:sticky xl:top-3 xl:h-[min(720px,calc(100vh-120px))]' : 'h-[min(720px,calc(100vh-150px))]'}`}
            style={{
                background: 'var(--blanc-surface-strong)',
                border: '1px solid var(--sched-line)',
                borderRadius: 'var(--sched-radius-md)',
            }}
        >
            <header className="flex shrink-0 items-start justify-between gap-3 px-4 py-3.5" style={{ borderBottom: '1px solid var(--sched-line)' }}>
                <div className="min-w-0">
                    <h2 className="truncate text-[15px] font-semibold" style={{ color: 'var(--sched-ink-1)' }}>
                        Filtered technician routes
                    </h2>
                    <p className="mt-0.5 text-[11px]" style={{ color: 'var(--sched-ink-3)' }}>
                        Visible toolbar chips · straight visit order
                    </p>
                </div>
                <div
                    className="shrink-0 rounded-xl px-2.5 py-1.5 text-right"
                    style={{ background: 'var(--blanc-bg-deep)' }}
                >
                    <strong className="block text-[11px]" style={{ color: 'var(--sched-ink-1)' }}>
                        {model.pins.length} {model.pins.length === 1 ? 'pin' : 'pins'}
                    </strong>
                    <span className="block whitespace-nowrap text-[9px]" style={{ color: 'var(--sched-ink-2)' }}>
                        {arithmetic}
                    </span>
                </div>
            </header>

            <ScheduleMapCanvas
                model={model}
                companyTz={companyTz}
                selectedJobKey={selectedJobKey}
                hoveredJobKey={hoveredJobKey}
                onSelectJob={onSelectJob}
                onHoverJob={onHoverJob}
                className="min-h-[330px] flex-1"
            />

            {showNotOnMapPanel(model) && (
                <section aria-label="Not on the map" className="shrink-0 px-3 pb-3 pt-2.5" style={{ borderTop: '1px solid var(--sched-line)' }}>
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <h3 className="text-[13px] font-semibold" style={{ color: 'var(--sched-ink-1)' }}>
                            Not on the map
                        </h3>
                        <span className="rounded-full px-2 py-1 text-[10px] font-semibold" style={{ background: 'var(--blanc-bg-deep)', color: 'var(--sched-ink-2)' }}>
                            {model.notOnMap.length} {model.notOnMap.length === 1 ? 'job' : 'jobs'}
                        </span>
                    </div>
                    <div className="max-h-[164px] space-y-1 overflow-y-auto">
                        {model.notOnMap.map(entry => {
                            const selected = selectedJobKey === entry.jobKey;
                            const hot = hoveredJobKey === entry.jobKey;
                            const time = entry.job.start_at
                                ? formatTimeInTZ(new Date(entry.job.start_at), companyTz)
                                : '';
                            return (
                                <button
                                    key={entry.jobKey}
                                    type="button"
                                    onClick={() => onSelectJob(entry.job)}
                                    onMouseEnter={() => onHoverJob(entry.jobKey)}
                                    onMouseLeave={() => onHoverJob(null)}
                                    className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left"
                                    style={{
                                        background: selected || hot ? 'var(--blanc-accent-soft)' : 'var(--blanc-bg-deep)',
                                        boxShadow: selected ? 'inset 0 0 0 2px var(--blanc-accent)' : undefined,
                                    }}
                                >
                                    <span className="min-w-0">
                                        <strong className="block truncate text-[12px]" style={{ color: 'var(--sched-ink-1)' }}>
                                            {entry.job.title}
                                        </strong>
                                        <span className="mt-0.5 flex items-center gap-1.5 truncate text-[10px]" style={{ color: 'var(--sched-ink-2)' }}>
                                            {entry.technicianColor && (
                                                <span className="size-2 shrink-0 rounded-full" style={{ background: entry.technicianColor }} />
                                            )}
                                            <span className="truncate">{entry.technicianName}</span>
                                        </span>
                                    </span>
                                    <span className="shrink-0 text-right">
                                        {time && <span className="block text-[10px] font-semibold" style={{ color: 'var(--sched-ink-1)' }}>{time}</span>}
                                        <span className="block text-[10px]" style={{ color: 'var(--sched-ink-3)' }}>{entry.reason}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    <p className="mt-2 text-[10px]" style={{ color: 'var(--sched-ink-3)' }}>
                        Click a row to select and highlight its grid job. The map does not pan without coordinates.
                    </p>
                </section>
            )}
        </section>
    );
});
