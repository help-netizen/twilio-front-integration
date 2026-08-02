import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppScheduleEditor } from './AppSchedule';
import type { AppSchedule } from '../../services/appViewsApi';

const schedule: AppSchedule = {
    enabled: true,
    cadence: { kind: 'every_minutes', n: 1 },
    next_run_at: '2026-08-02T12:00:00.000Z',
    last_run_at: null,
    last_status: null,
    failure_count: 0,
    suspended_reason: null,
    timezone: 'America/New_York',
    cost_forecast: {
        runs_per_day: 1440,
        runs_per_month: 43800,
        maximum_data_reads_per_month: 219000,
        maximum_compute_ms_per_day: 1740000,
        warnings: ['Maximum projected data reads exceed the daily limit.'],
    },
};

describe('APP-VIEW-001 phase B schedule editor', () => {
    it('states the cost of the chosen cadence instead of leaving it to be discovered', () => {
        const markup = renderToStaticMarkup(
            <AppScheduleEditor schedule={schedule} saving={false} onSave={vi.fn()} />
        );

        expect(markup).toContain('1,440');
        expect(markup).toContain('43,800');
        expect(markup).toContain('219,000');
        expect(markup).toContain('runs per day');
        expect(markup).toContain('Maximum projected data reads exceed the daily limit.');
        expect(markup).toContain('America/New_York');
    });

    it('surfaces a suspended schedule rather than looking merely switched off', () => {
        const markup = renderToStaticMarkup(
            <AppScheduleEditor
                schedule={{
                    ...schedule,
                    enabled: false,
                    suspended_reason: 'The installer no longer holds the permissions this app needs.',
                }}
                saving={false}
                onSave={vi.fn()}
            />
        );
        expect(markup).toContain('no longer holds the permissions');
    });
});
