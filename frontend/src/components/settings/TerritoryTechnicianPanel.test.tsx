import { beforeEach, describe, expect, it, vi } from 'vitest';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('../../services/apiClient', () => ({ authedFetch }));

import {
    serviceTerritoryAssignmentsApi,
    type ServiceTerritoryAssignmentState,
} from '../../services/serviceTerritoryAssignmentsApi';
import panelSource from './TerritoryTechnicianPanel.tsx?raw';

const state = {
    active_mode: 'list', technicians: [], districts: [], radii: [],
    technician_assignments: [], wildcard_technicians: [],
} satisfies ServiceTerritoryAssignmentState;

beforeEach(() => {
    authedFetch.mockReset().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn(async () => ({ ok: true, data: state })),
    });
});

describe('territory-side technician assignment panel', () => {
    it('uses the canonical right panel and active-technician multi-select', () => {
        expect(panelSource).toContain('<DialogContent variant="panel">');
        expect(panelSource).toContain('technicians.map');
        expect(panelSource).toContain('<Checkbox');
        expect(panelSource).toContain('Save assignments');
    });

    it('replaces one district side and accepts an empty direct assignment', async () => {
        await serviceTerritoryAssignmentsApi.replaceDistrict('North', []);
        expect(authedFetch).toHaveBeenCalledWith(
            '/api/settings/service-territories/district-assignments',
            expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({ district_name: 'North', technician_ids: [] }),
            }),
        );
    });

    it('replaces one radius side without writing districts', async () => {
        const radiusId = '11111111-1111-4111-8111-111111111111';
        await serviceTerritoryAssignmentsApi.replaceRadius(radiusId, ['tech-1']);
        expect(authedFetch).toHaveBeenCalledWith(
            `/api/settings/service-territories/radii/${radiusId}/technicians`,
            expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({ technician_ids: ['tech-1'] }),
            }),
        );
    });
});
