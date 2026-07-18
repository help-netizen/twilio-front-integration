import { authedFetch } from './apiClient';

export interface Technician {
    tech_id: string;
    name: string | null;
    has_photo: boolean;
    base?: object | null;
    inherits_company_schedule: boolean;
    effective_schedule: TechnicianScheduleDay[];
    schedule_summary: string;
    exceeds_company_hours: boolean;
    degraded_to_company_schedule: boolean;
    service_area_mode?: 'list' | 'radius';
    service_area_summary?: string;
    service_area_wildcard?: boolean;
}

export interface TechnicianScheduleDay {
    day_of_week: number;
    is_working: boolean;
    work_start_time: string | null;
    work_end_time: string | null;
    company_closed?: boolean;
    source?: 'company' | 'work_schedule';
    exceeds_company_hours?: boolean;
}

export interface CompanyWorkSchedule {
    timezone: string;
    work_start_time: string;
    work_end_time: string;
    work_days: number[];
    days: TechnicianScheduleDay[];
}

export interface WiderScheduleDay {
    day_of_week: number;
    day_name: string;
    technician_interval: string;
    company_interval: string;
}

export interface TechnicianSettings {
    technician_id: string;
    technician_name: string;
    has_schedule: boolean;
    inherits_company_schedule: boolean;
    has_saved_custom_schedule: boolean;
    saved_week: TechnicianScheduleDay[];
    effective_week: TechnicianScheduleDay[];
    schedule_summary: string;
    exceeds_company_hours: boolean;
    wider_days: WiderScheduleDay[];
    degraded_to_company_schedule: boolean;
    company_schedule: CompanyWorkSchedule;
    service_areas: TechnicianServiceAreas;
}

export interface TechnicianDistrictTarget {
    id: string;
    name: string;
}

export interface TechnicianRadiusTarget {
    id: string;
    zip: string;
    radius_miles: number;
}

export interface TechnicianServiceAreas {
    active_mode: 'list' | 'radius';
    districts: TechnicianDistrictTarget[];
    radii: TechnicianRadiusTarget[];
    district_assignments: string[];
    radius_assignments: string[];
    wildcard_in_active_mode: boolean;
}

export interface UpdateTechnicianSchedule {
    inherits_company_schedule: boolean;
    days?: TechnicianScheduleDay[];
}

export function technicianScheduleDisplay(technician: Technician) {
    return {
        state: technician.inherits_company_schedule ? 'Company schedule' : 'Custom schedule',
        summary: technician.schedule_summary || 'Schedule unavailable',
        wider: technician.exceeds_company_hours,
        degraded: technician.degraded_to_company_schedule,
    };
}

async function technicianRequest<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await authedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error?.message || `Request failed: ${res.status}`);
    return json.data;
}

export const techniciansApi = {
    list: async (): Promise<Technician[]> => {
        return technicianRequest<Technician[]>('/api/settings/technicians');
    },
    getSettings: async (techId: string): Promise<TechnicianSettings> => {
        return technicianRequest<TechnicianSettings>(
            `/api/settings/technicians/${encodeURIComponent(techId)}/settings`,
        );
    },
    updateWorkSchedule: async (
        techId: string,
        payload: UpdateTechnicianSchedule,
    ): Promise<TechnicianSettings> => {
        return technicianRequest<TechnicianSettings>(
            `/api/settings/technicians/${encodeURIComponent(techId)}/work-schedule`,
            { method: 'PUT', body: JSON.stringify(payload) },
        );
    },
    updateServiceAreas: async (
        techId: string,
        mode: 'districts' | 'radii',
        assignments: string[],
    ): Promise<TechnicianServiceAreas> => {
        return technicianRequest<TechnicianServiceAreas>(
            `/api/settings/technicians/${encodeURIComponent(techId)}/service-areas/${mode}`,
            { method: 'PUT', body: JSON.stringify({ assignments }) },
        );
    },
    uploadPhoto: async (techId: string, file: File, name?: string): Promise<{ tech_id: string; has_photo: boolean }> => {
        const fd = new FormData();
        fd.append('photo', file);
        if (name) fd.append('name', name);
        // Note: do NOT set Content-Type — the browser sets the multipart boundary.
        const res = await authedFetch(`/api/settings/technicians/${encodeURIComponent(techId)}/photo`, { method: 'POST', body: fd });
        const json = await res.json();
        if (!res.ok || json.ok === false) throw new Error(json.error?.message || `Upload failed: ${res.status}`);
        return json.data;
    },
};
