import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { FloatingField } from '../ui/floating-field';
import { FloatingSelect } from '../ui/floating-select';
import { SelectItem } from '../ui/select';
import type { AppSchedule as Schedule, Cadence, CostForecast } from '../../services/appViewsApi';

/**
 * When an app runs on its own (APP-VIEW-001 §5). Cadence is a closed set rather
 * than a cron string, and the screen states the cost before the choice is made:
 * every minute is allowed, so the honest number is what keeps it a decision
 * rather than a surprise.
 */

const KINDS: { kind: Cadence['kind']; label: string }[] = [
    { kind: 'every_minutes', label: 'Every N minutes' },
    { kind: 'hourly', label: 'Hourly' },
    { kind: 'daily', label: 'Daily' },
    { kind: 'weekly', label: 'Days of week' },
    { kind: 'monthly', label: 'Day of month' },
];

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function defaultsFor(kind: Cadence['kind']): Cadence {
    if (kind === 'every_minutes') return { kind, n: 15 };
    if (kind === 'hourly') return { kind, minute: 5 };
    if (kind === 'weekly') return { kind, dow: 1, at: '07:00' };
    if (kind === 'monthly') return { kind, dom: 1, at: '07:00' };
    return { kind: 'daily', at: '07:00' };
}

function compact(value: number): string {
    return value.toLocaleString('en-US');
}

function minutes(ms: number): string {
    const total = Math.round(ms / 60000);
    if (total < 60) return `${total} min`;
    return `${(total / 60).toFixed(1)} h`;
}

function Forecast({ forecast }: { forecast: CostForecast }) {
    return (
        <div className="rounded-2xl px-4 py-3.5" style={{ background: 'var(--blanc-surface-muted)' }}>
            <div className="text-sm font-semibold">What this cadence costs</div>
            <div className="mt-2.5 flex flex-wrap gap-x-7 gap-y-3">
                {[
                    [compact(forecast.runs_per_day), 'runs per day'],
                    [compact(forecast.runs_per_month), 'runs per month'],
                    [compact(forecast.maximum_data_reads_per_month), 'data reads per month'],
                    [minutes(forecast.maximum_compute_ms_per_day), 'of compute per day'],
                ].map(([value, label]) => (
                    <div key={label} className="text-[12.5px]" style={{ color: 'var(--blanc-ink-2)' }}>
                        <b
                            className="block text-[17px] tabular-nums tracking-tight"
                            style={{ color: 'var(--blanc-ink-1)' }}
                        >
                            {value}
                        </b>
                        {label}
                    </div>
                ))}
            </div>
            {forecast.warnings.map(warning => (
                <p key={warning} className="mt-2.5 text-[13px]" style={{ color: 'var(--blanc-danger)' }}>
                    {warning}
                </p>
            ))}
        </div>
    );
}

export interface AppScheduleEditorProps {
    schedule: Schedule;
    saving: boolean;
    onSave: (next: { enabled: boolean; cadence: Cadence | null }) => void;
}

export function AppScheduleEditor({ schedule, saving, onSave }: AppScheduleEditorProps) {
    const [enabled, setEnabled] = useState(schedule.enabled);
    const [cadence, setCadence] = useState<Cadence>(schedule.cadence || defaultsFor('daily'));

    useEffect(() => {
        setEnabled(schedule.enabled);
        if (schedule.cadence) setCadence(schedule.cadence);
    }, [schedule]);

    const patch = (next: Partial<Cadence>) => setCadence(current => ({ ...current, ...next } as Cadence));

    return (
        <div className="space-y-6">
            {schedule.suspended_reason && (
                <div
                    className="rounded-2xl px-4 py-3 text-sm"
                    style={{ background: 'rgba(240, 80, 63, 0.08)', color: 'var(--blanc-danger)' }}
                >
                    {schedule.suspended_reason}
                </div>
            )}

            <div className="flex items-center gap-2.5">
                <Checkbox
                    id="app-schedule-enabled"
                    checked={enabled}
                    onCheckedChange={value => setEnabled(value === true)}
                />
                <label htmlFor="app-schedule-enabled" className="text-sm font-medium">
                    Run this app automatically
                </label>
            </div>

            <div className={enabled ? '' : 'pointer-events-none opacity-50'}>
                <div className="blanc-eyebrow mb-3">When to run</div>
                <div className="flex flex-wrap gap-2">
                    {KINDS.map(option => {
                        const active = cadence.kind === option.kind;
                        return (
                            <button
                                key={option.kind}
                                type="button"
                                onClick={() => setCadence(defaultsFor(option.kind))}
                                className="rounded-xl px-3.5 py-2.5 text-[13px] font-medium"
                                style={{
                                    background: active ? 'var(--blanc-accent)' : 'var(--blanc-field)',
                                    color: active ? '#fff' : 'var(--blanc-ink-2)',
                                }}
                            >
                                {option.label}
                            </button>
                        );
                    })}
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                    {cadence.kind === 'every_minutes' && (
                        <FloatingField
                            id="app-schedule-minutes"
                            label="Every (minutes)"
                            type="number"
                            value={String(cadence.n)}
                            onChange={event => patch({ n: Math.max(1, Number(event.target.value) || 1) })}
                        />
                    )}
                    {cadence.kind === 'hourly' && (
                        <FloatingField
                            id="app-schedule-minute"
                            label="At minute"
                            type="number"
                            value={String(cadence.minute)}
                            onChange={event => patch({ minute: Math.min(59, Math.max(0, Number(event.target.value) || 0)) })}
                        />
                    )}
                    {cadence.kind === 'weekly' && (
                        <FloatingSelect
                            id="app-schedule-dow"
                            label="Day"
                            value={String(cadence.dow)}
                            onValueChange={value => patch({ dow: Number(value) })}
                        >
                            {DAYS.map((day, index) => (
                                <SelectItem key={day} value={String(index)}>{day}</SelectItem>
                            ))}
                        </FloatingSelect>
                    )}
                    {cadence.kind === 'monthly' && (
                        <FloatingField
                            id="app-schedule-dom"
                            label="Day of month"
                            type="number"
                            value={String(cadence.dom)}
                            onChange={event => patch({ dom: Math.min(31, Math.max(1, Number(event.target.value) || 1)) })}
                        />
                    )}
                    {'at' in cadence && (
                        <FloatingField
                            id="app-schedule-at"
                            label="Time"
                            type="time"
                            value={cadence.at}
                            onChange={event => patch({ at: event.target.value })}
                        />
                    )}
                </div>

                <p className="mt-3 text-[13px]" style={{ color: 'var(--blanc-ink-2)' }}>
                    Company time — {schedule.timezone}. Handled correctly on daylight-saving days.
                </p>

                {schedule.cost_forecast && (
                    <div className="mt-4">
                        <Forecast forecast={schedule.cost_forecast} />
                    </div>
                )}
            </div>

            {schedule.next_run_at && enabled && (
                <p className="text-[13px]" style={{ color: 'var(--blanc-ink-3)' }}>
                    Next run {new Date(schedule.next_run_at).toLocaleString('en-US', {
                        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                    })}
                </p>
            )}

            <Button onClick={() => onSave({ enabled, cadence: enabled ? cadence : null })} disabled={saving}>
                {saving && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Save schedule
            </Button>
        </div>
    );
}
