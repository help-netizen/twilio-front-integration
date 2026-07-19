import { beforeEach, describe, expect, it, vi } from 'vitest';
import pageSource from './TechnicianPhotosPage.tsx?raw';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('../services/apiClient', () => ({ authedFetch }));

import { technicianScheduleDisplay, techniciansApi, type Technician } from '../services/techniciansApi';
import { mergeTechnicianRosterRows } from '../components/settings/technicianRosterModel';

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

    it('keeps canonical Zenbooker contact, skill, and territory data while attaching bases', () => {
        const enriched = technician({
            zenbooker: {
                name: 'Alex Rivera',
                phone: '+12125550123',
                email: 'alex@example.com',
                user_status: 'activated',
                assigned_territories: [{ id: 'territory-1', name: 'North' }],
                skill_tags: [{ id: 'skill-1', name: 'HVAC' }],
                calendar_color: '#7f42e1',
                avatar: '//cdn.example.com/alex.jpg',
            },
        });

        const [row] = mergeTechnicianRosterRows([enriched], []);
        expect(row).toMatchObject({
            tech_id: 'tech-1',
            schedule_summary: 'Mon–Fri 08:00–18:00 · Sat–Sun off',
            zenbooker: {
                name: 'Alex Rivera',
                phone: '+12125550123',
                email: 'alex@example.com',
                user_status: 'activated',
                assigned_territories: [{ id: 'territory-1', name: 'North' }],
                skill_tags: [{ id: 'skill-1', name: 'HVAC' }],
            },
        });
    });

    it('loads the enriched roster through the single canonical endpoint', async () => {
        const enriched = technician({
            zenbooker: {
                name: 'Alex Rivera',
                phone: '+12125550123',
                email: 'alex@example.com',
                user_status: 'activated',
                assigned_territories: [{ id: 'territory-1', name: 'North' }],
                skill_tags: [{ id: 'skill-1', name: 'HVAC' }],
                calendar_color: null,
                avatar: null,
            },
        });
        authedFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn(async () => ({ ok: true, data: [enriched] })),
        });
        await expect(techniciansApi.list()).resolves.toEqual([enriched]);
        expect(authedFetch).toHaveBeenCalledTimes(1);
        expect(authedFetch).toHaveBeenCalledWith(
            '/api/settings/technicians',
            expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
        );
    });

    it('keeps the merged Zenbooker fields visible on each technician card', () => {
        expect(pageSource).not.toContain('getTeamMembers');
        expect(pageSource).toContain('Zenbooker profile');
        expect(pageSource).toContain('zenbooker.phone');
        expect(pageSource).toContain('zenbooker.email');
        expect(pageSource).toContain('Zenbooker territories');
        expect(pageSource).toContain('zenbooker?.skill_tags');
        expect(pageSource).toContain('zenbooker.avatar');
        expect(pageSource).toContain('zenbooker.calendar_color');
        expect(pageSource).toContain('zenbooker?.user_status');
    });
});
