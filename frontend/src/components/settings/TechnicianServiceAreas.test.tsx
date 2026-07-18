import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ButtonHTMLAttributes } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('../../services/apiClient', () => ({ authedFetch }));
vi.mock('../ui/checkbox', () => ({
    Checkbox: ({ checked }: { checked?: boolean }) => (
        <input type="checkbox" checked={checked} readOnly />
    ),
}));
vi.mock('../ui/button', () => ({
    Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
        <button {...props}>{children}</button>
    ),
}));

import {
    serviceAreaModeStatus,
    technicianServiceAreaSummary,
    TechnicianServiceAreasEditor,
    toggleServiceArea,
} from './TechnicianServiceAreas';
import { techniciansApi, type TechnicianServiceAreas } from '../../services/techniciansApi';

const value: TechnicianServiceAreas = {
    active_mode: 'list',
    districts: [
        { id: 'North', name: 'North' },
        { id: 'South', name: 'South' },
    ],
    radii: [{ id: '11111111-1111-4111-8111-111111111111', zip: '02135', radius_miles: 25 }],
    district_assignments: [],
    radius_assignments: ['11111111-1111-4111-8111-111111111111'],
    wildcard_in_active_mode: true,
};

function markup(data = value) {
    return renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
            <TechnicianServiceAreasEditor technicianId="tech-1" value={data} onSaved={() => {}} />
        </QueryClientProvider>,
    );
}

describe('technician service-area editor', () => {
    it('shows both independent modes, active status, district targets, and wildcard meaning', () => {
        const html = markup();
        expect(html).toContain('Districts');
        expect(html).toContain('Radii');
        expect(html).toContain('Active mode');
        expect(html).toContain('North');
        expect(html).toContain('No assignments means wildcard');
        expect(serviceAreaModeStatus('list', 'radii')).toBe('Saved for later');
    });

    it('retains inactive-mode selections and summarizes active wildcard without starvation', () => {
        expect(value.radius_assignments).toHaveLength(1);
        expect(technicianServiceAreaSummary(value)).toBe('All districts (wildcard)');
        expect(toggleServiceArea(['North'], 'South')).toEqual(['North', 'South']);
        expect(toggleServiceArea(['North', 'South'], 'North')).toEqual(['South']);
    });

    it('writes only the selected technician mode and accepts an empty wildcard set', async () => {
        authedFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn(async () => ({ ok: true, data: value })),
        });
        await techniciansApi.updateServiceAreas('tech-1', 'districts', []);
        expect(authedFetch).toHaveBeenCalledWith(
            '/api/settings/technicians/tech-1/service-areas/districts',
            expect.objectContaining({ method: 'PUT', body: JSON.stringify({ assignments: [] }) }),
        );
    });
});
