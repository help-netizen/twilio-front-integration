import { describe, expect, it } from 'vitest';
import type { ScheduleItem } from '../../services/scheduleApi';
import { filterItemsByProviderTags } from '../../services/scheduleFilters';
import { buildTechnicianColorRegistry } from '../../utils/scheduleProviderColors';
import {
    buildScheduleMapModel,
    hasScheduleMapCoordinates,
    scheduleMapCountsReconcile,
    showNotOnMapPanel,
    UNASSIGNED_PROVIDER_ID,
} from './scheduleMapModel';

const TECHNICIANS = [
    { id: 'ali', name: 'Ali Hassan' },
    { id: 'robert', name: 'Robert Chen' },
];
const REGISTRY = buildTechnicianColorRegistry(TECHNICIANS);

function job(id: number, overrides: Partial<ScheduleItem> = {}): ScheduleItem {
    return {
        entity_type: 'job',
        entity_id: id,
        title: `Job ${id}`,
        subtitle: '',
        status: 'scheduled',
        start_at: `2026-07-20T${String(8 + id).padStart(2, '0')}:00:00.000Z`,
        end_at: null,
        address_summary: `${id} Main St`,
        lat: 42 + id / 100,
        lng: -71 - id / 100,
        normalized_address: null,
        geocoding_status: 'success',
        google_maps_url: null,
        customer_name: `Customer ${id}`,
        customer_phone: '',
        customer_email: '',
        assigned_techs: [TECHNICIANS[0]],
        job_type: null,
        job_source: null,
        tags: null,
        ...overrides,
    };
}

describe('buildScheduleMapModel', () => {
    it('reconciles unique joint pins plus missing-coordinate rows to the filtered total', () => {
        const items = [
            job(1),
            job(2, { assigned_techs: TECHNICIANS }),
            job(3, { assigned_techs: null }),
            job(4, { lat: null, lng: null }),
            job(5, { lat: null, lng: null, address_summary: '' }),
        ];
        const model = buildScheduleMapModel(items, [], REGISTRY);

        expect(model.totalJobs).toBe(5);
        expect(model.pins).toHaveLength(3);
        expect(model.notOnMap).toHaveLength(2);
        expect(scheduleMapCountsReconcile(model)).toBe(true);
        expect(new Set(model.pins.map(pin => pin.jobKey)).size).toBe(model.pins.length);
        expect(model.pins.find(pin => pin.job.entity_id === 2)?.secondaryColor).toBeTruthy();
        expect(model.routes.filter(route => route.stops.some(stop => stop.job.entity_id === 2))).toHaveLength(2);
        expect(model.notOnMap.map(entry => entry.reason)).toEqual([
            'Address not on the map yet',
            'No address',
        ]);

        // Minimum sabotage: one duplicate joint-job pin must trip reconciliation.
        expect(scheduleMapCountsReconcile({
            ...model,
            pins: [...model.pins, model.pins[1]],
        })).toBe(false);
    });

    it('uses coordinate presence, not geocoding status, as the gate', () => {
        const mappedAtZero = job(1, {
            lat: 0,
            lng: 0,
            geocoding_status: 'not_geocoded',
        });
        const partialCoordinate = job(2, { lat: 42, lng: null });
        const model = buildScheduleMapModel([mappedAtZero, partialCoordinate], [], REGISTRY);

        expect(hasScheduleMapCoordinates(mappedAtZero)).toBe(true);
        expect(hasScheduleMapCoordinates(partialCoordinate)).toBe(false);
        expect(model.pins.map(pin => pin.job.entity_id)).toEqual([1]);
        expect(model.notOnMap.map(entry => entry.job.entity_id)).toEqual([2]);
    });

    it('renders neutral Unassigned pins without creating an Unassigned route', () => {
        const items = [
            job(1, { assigned_techs: null }),
            job(2, { assigned_techs: [] }),
        ];
        const model = buildScheduleMapModel(items, [UNASSIGNED_PROVIDER_ID], REGISTRY);

        expect(model.pins).toHaveLength(2);
        expect(model.pins.every(pin => pin.unassigned && pin.label === 'U')).toBe(true);
        expect(model.routes).toHaveLength(0);
        expect(model.legend).toEqual([
            expect.objectContaining({ id: UNASSIGNED_PROVIDER_ID, unassigned: true }),
        ]);
    });

    it('hides the Not on the map panel when every filtered job has coordinates', () => {
        const complete = buildScheduleMapModel([job(1)], [], REGISTRY);
        const missing = buildScheduleMapModel([job(2, { lat: null, lng: null })], [], REGISTRY);
        expect(showNotOnMapPanel(complete)).toBe(false);
        expect(showNotOnMapPanel(missing)).toBe(true);
    });

    it('matches the provider-chip filter, including Unassigned and joint jobs', () => {
        const items = [
            job(1, { assigned_techs: [TECHNICIANS[0]] }),
            job(2, { assigned_techs: [TECHNICIANS[1]] }),
            job(3, { assigned_techs: TECHNICIANS }),
            job(4, { assigned_techs: null }),
        ];
        const providerIds = ['robert', UNASSIGNED_PROVIDER_ID];
        const filtered = filterItemsByProviderTags(items, { providerIds });
        const model = buildScheduleMapModel(items, providerIds, REGISTRY);

        expect(model.pins.map(pin => pin.job.entity_id).sort()).toEqual(
            filtered.map(item => item.entity_id).sort(),
        );
        expect(model.routes.map(route => route.technicianId)).toEqual(['robert']);
        expect(model.pins.find(pin => pin.job.entity_id === 3)?.secondaryColor).toBeUndefined();

        const unassignedOnly = buildScheduleMapModel(items, [UNASSIGNED_PROVIDER_ID], REGISTRY);
        expect(unassignedOnly.pins.map(pin => pin.job.entity_id)).toEqual([4]);
        expect(unassignedOnly.routes).toHaveLength(0);
    });

    it('breaks a route at an unmapped visit instead of drawing a false shortcut', () => {
        const model = buildScheduleMapModel([
            job(1),
            job(2, { lat: null, lng: null }),
            job(3),
        ], [], REGISTRY);
        expect(model.routes[0].stops.map(stop => stop.order)).toEqual([1, 3]);
        expect(model.routes[0].runs).toHaveLength(0);
    });
});
