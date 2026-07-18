import { authedFetch } from './apiClient';

const API = '/api/settings/service-territories';

export interface TerritoryAssignmentTechnician {
    id: string;
    name: string;
}

export interface TerritoryDistrictAssignmentTarget {
    id: string;
    name: string;
    technician_ids: string[];
}

export interface TerritoryRadiusAssignmentTarget {
    id: string;
    zip: string;
    radius_miles: number;
    technician_ids: string[];
}

export interface TerritoryTechnicianAssignment {
    technician_id: string;
    technician_name: string;
    district_names: string[];
    radius_ids: string[];
    wildcard_in_active_mode: boolean;
}

export interface ServiceTerritoryAssignmentState {
    active_mode: 'list' | 'radius';
    technicians: TerritoryAssignmentTechnician[];
    districts: TerritoryDistrictAssignmentTarget[];
    radii: TerritoryRadiusAssignmentTarget[];
    technician_assignments: TerritoryTechnicianAssignment[];
    wildcard_technicians: TerritoryAssignmentTechnician[];
}

export function wildcardTechniciansForMode(
    state: ServiceTerritoryAssignmentState,
    mode: ServiceTerritoryAssignmentState['active_mode'],
): TerritoryAssignmentTechnician[] {
    const byTechnician = new Map(
        state.technician_assignments.map(item => [item.technician_id, item])
    );
    return state.technicians.filter(technician => {
        const assignments = byTechnician.get(technician.id);
        return mode === 'radius'
            ? !assignments || assignments.radius_ids.length === 0
            : !assignments || assignments.district_names.length === 0;
    });
}

async function assignmentRequest<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await authedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    const json = await response.json();
    if (!response.ok || json.ok === false) {
        throw new Error(json.error?.message || `Request failed: ${response.status}`);
    }
    return json.data as T;
}

export const serviceTerritoryAssignmentsApi = {
    get: (): Promise<ServiceTerritoryAssignmentState> =>
        assignmentRequest<ServiceTerritoryAssignmentState>(`${API}/assignments`),

    replaceDistrict: (
        districtName: string,
        technicianIds: string[],
    ): Promise<ServiceTerritoryAssignmentState> =>
        assignmentRequest<ServiceTerritoryAssignmentState>(`${API}/district-assignments`, {
            method: 'PUT',
            body: JSON.stringify({ district_name: districtName, technician_ids: technicianIds }),
        }),

    replaceRadius: (
        radiusId: string,
        technicianIds: string[],
    ): Promise<ServiceTerritoryAssignmentState> =>
        assignmentRequest<ServiceTerritoryAssignmentState>(
            `${API}/radii/${encodeURIComponent(radiusId)}/technicians`,
            { method: 'PUT', body: JSON.stringify({ technician_ids: technicianIds }) },
        ),
};
