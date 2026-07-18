/**
 * Pure client-side schedule filters.
 *
 * Provider + tag filtering is applied on the client (the server fetch is by
 * date-range + the coarse server filters). Extracted from useScheduleData so the
 * day-agenda and the mobile week-strip counts filter items the SAME way — the
 * count under each day must equal what the agenda shows when that day is tapped.
 */

import type { ScheduleItem, ScheduleFilters, UnavailabilityBlock } from './scheduleApi';

const UNASSIGNED = '__unassigned__';

/**
 * Keep only items that match the selected providers and tags.
 * - `providerIds` matches a tech by id OR name; the sentinel `__unassigned__`
 *   keeps items with no assigned techs.
 * - `tags` keeps items sharing at least one selected tag.
 * Empty/absent filters are a passthrough.
 */
export function filterItemsByProviderTags(
    items: ScheduleItem[],
    filters: Partial<ScheduleFilters>,
): ScheduleItem[] {
    let result = items;

    if (filters.providerIds?.length) {
        const wantUnassigned = filters.providerIds.includes(UNASSIGNED);
        result = result.filter((item) => {
            const techs = item.assigned_techs;
            if (!techs?.length) return wantUnassigned;
            return techs.some((t) => filters.providerIds!.includes(t.id || t.name));
        });
    }

    if (filters.tags?.length) {
        result = result.filter((item) =>
            item.tags?.some((t) => filters.tags!.includes(t)),
        );
    }

    return result;
}

/**
 * TECH-DAYOFF-002: time-off blocks RENDERED on the schedule respect the
 * provider filter — with a tech filter active, colleagues' time off (its note
 * can carry a private reason) must not appear. Matches by id OR name,
 * mirroring filterItemsByProviderTags. Empty/absent filter is a passthrough.
 * DnD conflict checks keep the UNFILTERED list — dropping a
 * job onto a filtered-out tech must still warn about their day off.
 */
export function filterUnavailabilityByProviders(
    blocks: UnavailabilityBlock[],
    providerIds?: string[],
): UnavailabilityBlock[] {
    if (!providerIds?.length) return blocks;
    return blocks.filter(
        (b) => providerIds.includes(b.technician_id) || providerIds.includes(b.technician_name),
    );
}
