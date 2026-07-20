import type { ScheduleItem } from '../../services/scheduleApi';
import {
    UNASSIGNED_TECHNICIAN_COLOR,
    registeredTechnician,
    technicianInitials,
    technicianKey,
    type RegisteredTechnician,
    type TechnicianColorRegistry,
} from '../../utils/scheduleProviderColors';

export const UNASSIGNED_PROVIDER_ID = '__unassigned__';

export interface ScheduleMapStop {
    job: ScheduleItem;
    jobKey: string;
    lat: number;
    lng: number;
    order: number;
}

export interface ScheduleMapRoute {
    technicianId: string;
    technicianName: string;
    initials: string;
    color: string;
    stops: ScheduleMapStop[];
    /** Coordinate-less visits split runs so no false shortcut crosses them. */
    runs: ScheduleMapStop[][];
}

export interface ScheduleMapPin {
    job: ScheduleItem;
    jobKey: string;
    lat: number;
    lng: number;
    label: string;
    primaryColor: string;
    secondaryColor?: string;
    initials?: string;
    technicianNames: string[];
    routeOrders: Array<{ technicianName: string; order: number }>;
    unassigned: boolean;
}

export type NotOnMapReason = 'Address not on the map yet' | 'No address';

export interface NotOnMapJob {
    job: ScheduleItem;
    jobKey: string;
    reason: NotOnMapReason;
    technicianName: string;
    technicianColor?: string;
}

export interface ScheduleMapLegendItem {
    id: string;
    name: string;
    initials: string;
    color: string;
    unassigned: boolean;
}

export interface ScheduleMapModel {
    pins: ScheduleMapPin[];
    routes: ScheduleMapRoute[];
    notOnMap: NotOnMapJob[];
    legend: ScheduleMapLegendItem[];
    totalJobs: number;
}

export function scheduleJobKey(job: Pick<ScheduleItem, 'entity_type' | 'entity_id'>): string {
    return `${job.entity_type}:${job.entity_id}`;
}

/** Coordinate presence is the only map gate; geocoding_status is not trusted. */
export function hasScheduleMapCoordinates(
    job: Pick<ScheduleItem, 'lat' | 'lng'>,
): job is Pick<ScheduleItem, 'lat' | 'lng'> & { lat: number; lng: number } {
    return typeof job.lat === 'number'
        && Number.isFinite(job.lat)
        && typeof job.lng === 'number'
        && Number.isFinite(job.lng);
}

function startTime(job: ScheduleItem): number {
    if (!job.start_at) return 0;
    const value = new Date(job.start_at).getTime();
    return Number.isFinite(value) ? value : 0;
}

function visibleAssignments(
    job: ScheduleItem,
    selectedProviderIds: readonly string[],
): NonNullable<ScheduleItem['assigned_techs']> {
    const assigned = job.assigned_techs || [];
    if (selectedProviderIds.length === 0) return assigned;
    const selected = selectedProviderIds.filter(id => id && id !== UNASSIGNED_PROVIDER_ID);
    if (selected.length === 0) return [];
    const selectedSet = new Set(selected);
    return assigned.filter(technician => (
        selectedSet.has(technician.id) || selectedSet.has(technician.name)
    ));
}

function isVisibleForProviderChips(
    job: ScheduleItem,
    selectedProviderIds: readonly string[],
): boolean {
    if (selectedProviderIds.length === 0) return true;
    const assigned = job.assigned_techs || [];
    if (assigned.length === 0) return selectedProviderIds.includes(UNASSIGNED_PROVIDER_ID);
    return visibleAssignments(job, selectedProviderIds).length > 0;
}

function resolveTechnician(
    registry: TechnicianColorRegistry,
    technician: NonNullable<ScheduleItem['assigned_techs']>[number],
): RegisteredTechnician {
    const found = registeredTechnician(registry, technician.id)
        || registeredTechnician(registry, technician.name);
    if (found) return found;
    // SchedulePage builds the registry from the complete roster plus every
    // assignment in the fetched range. This fallback keeps pure callers safe
    // without inventing a technician colour.
    return {
        key: technicianKey(technician),
        id: technician.id || technician.name,
        name: technician.name || technician.id || 'Technician',
        initials: technicianInitials(technician.name || technician.id),
        colorIndex: -1,
        color: UNASSIGNED_TECHNICIAN_COLOR,
    };
}

export function notOnMapReason(job: Pick<ScheduleItem, 'address_summary'>): NotOnMapReason {
    return job.address_summary?.trim() ? 'Address not on the map yet' : 'No address';
}

export function showNotOnMapPanel(model: Pick<ScheduleMapModel, 'notOnMap'>): boolean {
    return model.notOnMap.length > 0;
}

export function scheduleMapCountsReconcile(
    model: Pick<ScheduleMapModel, 'pins' | 'notOnMap' | 'totalJobs'>,
): boolean {
    return model.pins.length + model.notOnMap.length === model.totalJobs;
}

export function buildScheduleMapModel(
    items: readonly ScheduleItem[],
    selectedProviderIds: readonly string[],
    registry: TechnicianColorRegistry,
): ScheduleMapModel {
    // Callers define the surface's entity set. Desktop passes filtered jobs
    // only; the existing mobile wrapper passes its already-filtered agenda set
    // so extracting the primitive does not change the mobile shell's scope.
    const jobs = items.filter(item => isVisibleForProviderChips(item, selectedProviderIds));

    const buckets = new Map<string, {
        technician: RegisteredTechnician;
        jobs: ScheduleItem[];
    }>();

    for (const job of jobs) {
        for (const assignment of visibleAssignments(job, selectedProviderIds)) {
            const technician = resolveTechnician(registry, assignment);
            const bucket = buckets.get(technician.key);
            if (bucket) bucket.jobs.push(job);
            else buckets.set(technician.key, { technician, jobs: [job] });
        }
    }

    const routes = [...buckets.values()]
        .sort((left, right) => {
            if (left.technician.colorIndex !== right.technician.colorIndex) {
                return left.technician.colorIndex - right.technician.colorIndex;
            }
            return left.technician.key < right.technician.key ? -1 : 1;
        })
        .map(({ technician, jobs: technicianJobs }): ScheduleMapRoute => {
            const ordered = [...technicianJobs].sort((left, right) => (
                startTime(left) - startTime(right)
                || left.entity_id - right.entity_id
            ));
            const stops: ScheduleMapStop[] = [];
            const runs: ScheduleMapStop[][] = [];
            let run: ScheduleMapStop[] = [];

            ordered.forEach((job, index) => {
                if (!hasScheduleMapCoordinates(job)) {
                    if (run.length > 0) runs.push(run);
                    run = [];
                    return;
                }
                const stop: ScheduleMapStop = {
                    job,
                    jobKey: scheduleJobKey(job),
                    lat: job.lat,
                    lng: job.lng,
                    order: index + 1,
                };
                stops.push(stop);
                run.push(stop);
            });
            if (run.length > 0) runs.push(run);

            return {
                technicianId: technician.id,
                technicianName: technician.name,
                initials: technician.initials,
                color: technician.color.accent,
                stops,
                runs: runs.filter(candidate => candidate.length >= 2),
            };
        });

    const routeByTechnician = new Map(routes.map(route => [route.technicianId, route]));
    const pinByJob = new Map<string, ScheduleMapPin>();
    const notOnMap: NotOnMapJob[] = [];

    for (const job of jobs) {
        const jobKey = scheduleJobKey(job);
        const assignments = visibleAssignments(job, selectedProviderIds);
        const technicians = assignments.map(assignment => resolveTechnician(registry, assignment));
        const primary = technicians[0];

        if (!hasScheduleMapCoordinates(job)) {
            notOnMap.push({
                job,
                jobKey,
                reason: notOnMapReason(job),
                technicianName: technicians.length > 0
                    ? technicians.map(technician => technician.name).join(' + ')
                    : 'Unassigned',
                technicianColor: primary?.color.accent,
            });
            continue;
        }

        const routeOrders = technicians.flatMap(technician => {
            const route = routeByTechnician.get(technician.id);
            const stop = route?.stops.find(candidate => candidate.jobKey === jobKey);
            return stop ? [{ technicianName: technician.name, order: stop.order }] : [];
        });
        const primaryOrder = routeOrders[0]?.order;
        pinByJob.set(jobKey, {
            job,
            jobKey,
            lat: job.lat,
            lng: job.lng,
            label: technicians.length === 0 ? 'U' : String(primaryOrder || ''),
            primaryColor: primary?.color.accent || UNASSIGNED_TECHNICIAN_COLOR.accent,
            secondaryColor: technicians[1]?.color.accent,
            initials: registry.showInitialsOnPins && primary ? primary.initials : undefined,
            technicianNames: technicians.map(technician => technician.name),
            routeOrders,
            unassigned: technicians.length === 0,
        });
    }

    const pins = [...pinByJob.values()];
    const legend: ScheduleMapLegendItem[] = routes
        .filter(route => route.stops.length > 0)
        .map(route => ({
            id: route.technicianId,
            name: route.technicianName,
            initials: route.initials,
            color: route.color,
            unassigned: false,
        }));
    if (pins.some(pin => pin.unassigned)) {
        legend.push({
            id: UNASSIGNED_PROVIDER_ID,
            name: 'Unassigned · no route',
            initials: 'U',
            color: UNASSIGNED_TECHNICIAN_COLOR.accent,
            unassigned: true,
        });
    }

    const model = { pins, routes, notOnMap, legend, totalJobs: jobs.length };
    if (!scheduleMapCountsReconcile(model)) {
        throw new Error('Schedule map reconciliation invariant failed');
    }
    return model;
}
