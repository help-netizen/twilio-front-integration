import { beforeEach, describe, expect, it, vi } from 'vitest';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('../services/apiClient', () => ({ authedFetch }));

import { technicianScheduleDisplay, techniciansApi, type Technician } from '../services/techniciansApi';

function technician(overrides: Partial<Technician> = {}): Technician {
    return {
        tech_id: 'tech-1',
        name: 'Alex Rivera',
        has_photo: false,
        inherits_company_schedule: true,
        effective_schedule: [],
        schedule_summary: 'Mon–Fri 08:00–18:00 · Sat–Sun off',
        exceeds_company_hours: false,
        degraded_to_company_schedule: false,
        ...overrides,
    };
}

beforeEach(() => authedFetch.mockReset());

describe('canonical technician list schedule display', () => {
    it('shows inherited hours on every active-roster row', () => {
        expect(technicianScheduleDisplay(technician())).toEqual({
            state: 'Company schedule',
            summary: 'Mon–Fri 08:00–18:00 · Sat–Sun off',
            wider: false,
            degraded: false,
        });
    });

    it('discloses custom, wider, and company-fallback states', () => {
        expect(technicianScheduleDisplay(technician({
            inherits_company_schedule: false,
            exceeds_company_hours: true,
            degraded_to_company_schedule: true,
        }))).toMatchObject({ state: 'Custom schedule', wider: true, degraded: true });
    });

    it('reads the canonical settings roster endpoint without a job-history parameter', async () => {
        authedFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn(async () => ({ ok: true, data: [technician()] })),
        });
        await expect(techniciansApi.list()).resolves.toEqual([technician()]);
        expect(authedFetch).toHaveBeenCalledWith(
            '/api/settings/technicians',
            expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
        );
    });
});
