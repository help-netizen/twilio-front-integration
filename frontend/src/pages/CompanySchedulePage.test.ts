import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchSettingsValidationError } from '../components/settings/dispatchSettingsModel';
import type { DispatchSettings } from '../services/scheduleApi';
import pageSource from './CompanySchedulePage.tsx?raw';
import scheduleSource from './SchedulePage.tsx?raw';
import technicianSource from './TechnicianPhotosPage.tsx?raw';
import appSource from '../App.tsx?raw';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('../services/apiClient', () => ({ authedFetch }));

import { fetchDispatchSettings, updateDispatchSettings } from '../services/scheduleApi';

const settings: DispatchSettings = {
    timezone: 'America/New_York',
    work_start_time: '08:00',
    work_end_time: '18:00',
    work_days: [1, 2, 3, 4, 5],
    slot_duration: 30,
    distance_unit: 'mi',
};

beforeEach(() => authedFetch.mockReset());

describe('Company schedule page', () => {
    it('loads and saves through /api/schedule/settings', async () => {
        authedFetch
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: vi.fn(async () => ({ ok: true, data: settings })),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: vi.fn(async () => ({ ok: true, data: { ...settings, slot_duration: 60 } })),
            });

        await expect(fetchDispatchSettings()).resolves.toEqual(settings);
        await expect(updateDispatchSettings({ slot_duration: 60 })).resolves.toMatchObject({ slot_duration: 60 });
        expect(authedFetch).toHaveBeenNthCalledWith(1, '/api/schedule/settings', {
            headers: { 'Content-Type': 'application/json' },
        });
        expect(authedFetch).toHaveBeenNthCalledWith(2, '/api/schedule/settings', {
            headers: { 'Content-Type': 'application/json' },
            method: 'PATCH',
            body: JSON.stringify({ slot_duration: 60 }),
        });
    });

    it('validates company hours and working days before save', () => {
        expect(dispatchSettingsValidationError({ ...settings, work_end_time: '07:00' }))
            .toBe('End time must be after start time');
        expect(dispatchSettingsValidationError({ ...settings, work_days: [] }))
            .toBe('Select at least one work day');
        expect(dispatchSettingsValidationError(settings)).toBeNull();
    });

    it('embeds recommendations with their existing permission and moves the gear to a deep link', () => {
        expect(pageSource).toContain('<RecommendationSettings />');
        expect(pageSource).toContain("hasPermission('tenant.company.manage')");
        expect(technicianSource).not.toContain('<RecommendationSettings />');
        expect(scheduleSource).toContain("navigate('/settings/scheduling/company-schedule')");
        expect(scheduleSource).not.toContain('<DispatchSettingsDialog');
        expect(scheduleSource).toContain('<TimeOffDialog');
        expect(appSource).toContain('path="/settings/scheduling/company-schedule"');
        expect(appSource).toContain("permissions={['schedule.dispatch', 'tenant.company.manage']}><CompanySchedulePage");
    });
});
