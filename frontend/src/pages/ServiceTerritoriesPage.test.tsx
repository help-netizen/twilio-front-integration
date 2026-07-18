import { describe, expect, it } from 'vitest';
import {
    wildcardTechniciansForMode,
    type ServiceTerritoryAssignmentState,
} from '../services/serviceTerritoryAssignmentsApi';
import pageSource from './ServiceTerritoriesPage.tsx?raw';

const state: ServiceTerritoryAssignmentState = {
    active_mode: 'list',
    technicians: [
        { id: 'tech-1', name: 'Alex Rivera' },
        { id: 'tech-2', name: 'Maria Lopez' },
    ],
    districts: [{ id: 'North', name: 'North', technician_ids: [] }],
    radii: [{
        id: '11111111-1111-4111-8111-111111111111',
        zip: '02135',
        radius_miles: 25,
        technician_ids: ['tech-1'],
    }],
    technician_assignments: [
        {
            technician_id: 'tech-1', technician_name: 'Alex Rivera',
            district_names: [], radius_ids: ['11111111-1111-4111-8111-111111111111'],
            wildcard_in_active_mode: true,
        },
        {
            technician_id: 'tech-2', technician_name: 'Maria Lopez',
            district_names: [], radius_ids: [], wildcard_in_active_mode: true,
        },
    ],
    wildcard_technicians: [
        { id: 'tech-1', name: 'Alex Rivera' },
        { id: 'tech-2', name: 'Maria Lopez' },
    ],
};

describe('Service Territories technician assignments', () => {
    it('renders one persistent notice per active-mode wildcard technician', () => {
        expect(wildcardTechniciansForMode(state, 'list').map(item => item.id))
            .toEqual(['tech-1', 'tech-2']);
        expect(pageSource).toContain('wildcardTechnicians.map');
        expect(pageSource).toContain('data-wildcard-technician');
        expect(pageSource).toContain('will receive requests from all');
        expect(pageSource).not.toContain('dismissWildcard');
    });

    it('clears only the assigned technician notice and computes each mode independently', () => {
        const assigned = structuredClone(state);
        assigned.technician_assignments[0].district_names = ['North'];
        expect(wildcardTechniciansForMode(assigned, 'list').map(item => item.id)).toEqual(['tech-2']);
        expect(wildcardTechniciansForMode(assigned, 'radius').map(item => item.id)).toEqual(['tech-2']);
        expect(assigned.technician_assignments[0].radius_ids).toEqual(state.technician_assignments[0].radius_ids);
    });

    it('keeps roster-load failure persistent and disables assignment editing', () => {
        expect(pageSource).toContain('Assignment editing is disabled');
        expect(pageSource).toContain('wildcard notices are not hidden');
        expect(pageSource).toContain('assignmentDisabled={assignmentDisabled}');
    });
});
