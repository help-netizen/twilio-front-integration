/**
 * TECH-SCHEDULE-001 real-component harness. It mounts the production
 * TechnicianPhotosPage (including its real list row) and the real
 * TechnicianSettingsPanel while intercepting only this fixture's API calls.
 * No backend, auth session, database, or Zenbooker access is required.
 *
 * Run: npx vite --host 127.0.0.1 --port 3001
 * Open: http://127.0.0.1:3001/technician-schedule-harness.html
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import TechnicianPhotosPage from '../pages/TechnicianPhotosPage';
import {
    type Technician,
    type TechnicianScheduleDay,
    type TechnicianSettings,
    type TechnicianServiceAreas,
    type UpdateTechnicianSchedule,
} from '../services/techniciansApi';

const technicianId = 'harness-tech-1';
const technicianName = 'Alex Rivera';
const queryClient = new QueryClient();

const companyDays: TechnicianScheduleDay[] = Array.from({ length: 7 }, (_, day) => {
    const isWorking = day >= 1 && day <= 5;
    return {
        day_of_week: day,
        is_working: isWorking,
        work_start_time: isWorking ? '08:00' : null,
        work_end_time: isWorking ? '18:00' : null,
        company_closed: !isWorking,
        source: 'company',
        exceeds_company_hours: false,
    };
});

let savedCustomWeek: TechnicianScheduleDay[] = companyDays.map(day => {
    if (day.day_of_week === 1) {
        return {
            ...day,
            work_start_time: '07:00',
            work_end_time: '19:00',
            source: 'work_schedule',
            exceeds_company_hours: true,
        };
    }
    if (day.day_of_week === 2) {
        return {
            ...day,
            is_working: false,
            work_start_time: null,
            work_end_time: null,
            source: 'work_schedule',
        };
    }
    if (day.is_working) {
        return {
            ...day,
            work_start_time: '09:00',
            work_end_time: '17:00',
            source: 'work_schedule',
        };
    }
    return { ...day };
});

let currentServiceAreas: TechnicianServiceAreas = {
    active_mode: 'list',
    districts: [
        { id: 'North Shore', name: 'North Shore' },
        { id: 'Metro West', name: 'Metro West' },
        { id: 'South Shore', name: 'South Shore' },
    ],
    radii: [
        { id: '11111111-1111-4111-8111-111111111111', zip: '02135', radius_miles: 25 },
        { id: '22222222-2222-4222-8222-222222222222', zip: '02461', radius_miles: 12 },
    ],
    district_assignments: [],
    radius_assignments: ['11111111-1111-4111-8111-111111111111'],
    wildcard_in_active_mode: true,
};

function effectiveCustomWeek(days: TechnicianScheduleDay[]): TechnicianScheduleDay[] {
    const customByDay = new Map(days.map(day => [day.day_of_week, day]));
    return companyDays.map(companyDay => {
        if (companyDay.company_closed) return { ...companyDay };
        return {
            ...(customByDay.get(companyDay.day_of_week) || companyDay),
            company_closed: false,
        };
    });
}

function makeSettings(inherits: boolean): TechnicianSettings {
    const effective = inherits ? companyDays.map(day => ({ ...day })) : effectiveCustomWeek(savedCustomWeek);
    return {
        technician_id: technicianId,
        technician_name: technicianName,
        has_schedule: true,
        inherits_company_schedule: inherits,
        has_saved_custom_schedule: true,
        saved_week: savedCustomWeek.map(day => ({ ...day })),
        effective_week: effective,
        schedule_summary: inherits
            ? 'Mon–Fri 08:00–18:00 · Sat–Sun off'
            : 'Mon 07:00–19:00 · Tue off · Wed–Fri 09:00–17:00 · Sat–Sun off',
        exceeds_company_hours: !inherits,
        wider_days: inherits ? [] : [{
            day_of_week: 1,
            day_name: 'Mon',
            technician_interval: '07:00–19:00',
            company_interval: '08:00–18:00',
        }],
        degraded_to_company_schedule: false,
        company_schedule: {
            timezone: 'America/New_York',
            work_start_time: '08:00',
            work_end_time: '18:00',
            work_days: [1, 2, 3, 4, 5],
            days: companyDays.map(day => ({ ...day })),
        },
        service_areas: {
            ...currentServiceAreas,
            districts: currentServiceAreas.districts.map(item => ({ ...item })),
            radii: currentServiceAreas.radii.map(item => ({ ...item })),
            district_assignments: [...currentServiceAreas.district_assignments],
            radius_assignments: [...currentServiceAreas.radius_assignments],
        },
    };
}

let currentSettings = makeSettings(true);

function rosterRow(): Technician {
    return {
        tech_id: technicianId,
        name: technicianName,
        has_photo: false,
        base: null,
        inherits_company_schedule: currentSettings.inherits_company_schedule,
        effective_schedule: currentSettings.effective_week,
        schedule_summary: currentSettings.schedule_summary,
        exceeds_company_hours: currentSettings.exceeds_company_hours,
        degraded_to_company_schedule: false,
        service_area_mode: currentServiceAreas.active_mode,
        service_area_summary: currentServiceAreas.district_assignments.length === 0
            ? 'All districts (wildcard)'
            : currentServiceAreas.district_assignments.join(', '),
        service_area_wildcard: currentServiceAreas.district_assignments.length === 0,
    };
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string'
        ? input
        : input instanceof URL
            ? input.toString()
            : input.url;
    const url = new URL(raw, window.location.origin);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

    if (url.pathname === '/api/settings/technicians' && method === 'GET') {
        return json({ ok: true, data: [rosterRow()] });
    }
    if (url.pathname === `/api/settings/technicians/${technicianId}/settings` && method === 'GET') {
        return json({ ok: true, data: currentSettings });
    }
    if (url.pathname === `/api/settings/technicians/${technicianId}/work-schedule` && method === 'PUT') {
        const payload = JSON.parse(String(init?.body || '{}')) as UpdateTechnicianSchedule;
        if (!payload.inherits_company_schedule && payload.days) {
            savedCustomWeek = payload.days.map(day => ({ ...day }));
        }
        currentSettings = makeSettings(payload.inherits_company_schedule);
        return json({ ok: true, data: currentSettings });
    }
    const serviceAreaMatch = url.pathname.match(new RegExp(`^/api/settings/technicians/${technicianId}/service-areas/(districts|radii)$`));
    if (serviceAreaMatch && method === 'PUT') {
        const payload = JSON.parse(String(init?.body || '{}')) as { assignments?: string[] };
        if (serviceAreaMatch[1] === 'districts') {
            currentServiceAreas = {
                ...currentServiceAreas,
                district_assignments: payload.assignments || [],
                wildcard_in_active_mode: currentServiceAreas.active_mode === 'list'
                    ? (payload.assignments || []).length === 0
                    : currentServiceAreas.radius_assignments.length === 0,
            };
        } else {
            currentServiceAreas = {
                ...currentServiceAreas,
                radius_assignments: payload.assignments || [],
                wildcard_in_active_mode: currentServiceAreas.active_mode === 'radius'
                    ? (payload.assignments || []).length === 0
                    : currentServiceAreas.district_assignments.length === 0,
            };
        }
        currentSettings = makeSettings(currentSettings.inherits_company_schedule);
        return json({ ok: true, data: currentSettings.service_areas });
    }
    if (url.pathname === '/api/settings/technician-base-locations' && method === 'GET') {
        return json({ ok: true, data: [] });
    }
    if (url.pathname === '/api/settings/slot-engine-settings' && method === 'GET') {
        return json({
            ok: true,
            data: {
                max_distance_miles: 10,
                overlap_minutes: 0,
                min_buffer_minutes: 15,
                horizon_days: 3,
                recommendations_shown: 3,
            },
        });
    }
    return json({ ok: false, error: { code: 'HARNESS_UNSTUBBED', message: `Unstubbed harness request: ${method} ${url.pathname}` } }, 404);
};

function Harness() {
    return (
        <div>
            <div
                className="sticky top-0 z-50 px-4 py-3 text-sm"
                style={{ background: 'var(--blanc-accent-soft)', color: 'var(--blanc-ink-1)' }}
            >
                <strong>Review fixture:</strong> open Alex Rivera. Inheritance starts ON with read-only company hours.
                Turn it OFF to see editable hours, Tuesday off, the company-closed weekend, and Monday 07:00–19:00 wider than company hours.
            </div>
            <TechnicianPhotosPage />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <MemoryRouter>
            <Harness />
        </MemoryRouter>
    </QueryClientProvider>,
);
