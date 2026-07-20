import type { UnavailabilityBlock } from './scheduleApi';

export type MainScheduleDisplayKind = 'time_off' | 'day_off' | 'company_closed';

export interface MainScheduleDisplayBlock {
    displayKind: MainScheduleDisplayKind;
    block: UnavailabilityBlock;
}

export type MobileAgendaAvailabilityItem =
    | MainScheduleDisplayBlock
    | { displayKind: 'company_closed'; block: null; key: string };

/**
 * Display-only projection for the three technician-aware Schedule surfaces.
 * The operational collection stays untouched for warnings, the slot picker,
 * and smart-slot suppression.
 */
export function projectMainScheduleUnavailabilityForDay(
    blocks: UnavailabilityBlock[],
    dayStart: Date,
    dayEnd: Date,
): MainScheduleDisplayBlock[] {
    const start = dayStart.getTime();
    const end = dayEnd.getTime();

    return blocks.flatMap<MainScheduleDisplayBlock>((block) => {
        const blockStart = Date.parse(block.starts_at);
        const blockEnd = Date.parse(block.ends_at);
        if (!Number.isFinite(blockStart) || !Number.isFinite(blockEnd)
            || blockStart >= end || start >= blockEnd) {
            return [];
        }

        if (block.kind === 'time_off') {
            return [{ displayKind: 'time_off' as const, block }];
        }

        // A technician can work entirely outside the visible grid, so covering
        // grid hours is not enough. A derived day off must cover the complete
        // company-local calendar day, including 23/25-hour DST days.
        if (blockStart > start || blockEnd < end) return [];

        return [{
            displayKind: block.source === 'company' ? 'company_closed' as const : 'day_off' as const,
            block,
        }];
    });
}

/** Mobile has no technician lanes, so N company-derived closure blocks collapse
 * to one anonymous row. Input blocks have already been server/provider scoped. */
export function projectMobileAgendaUnavailabilityForDay(
    blocks: UnavailabilityBlock[],
    dayStart: Date,
    dayEnd: Date,
): MobileAgendaAvailabilityItem[] {
    const projected = projectMainScheduleUnavailabilityForDay(blocks, dayStart, dayEnd);
    const companyClosed = projected.some(item => item.displayKind === 'company_closed');
    return [
        ...(companyClosed ? [{
            displayKind: 'company_closed' as const,
            block: null,
            key: `company-closed:${dayStart.toISOString()}`,
        }] : []),
        ...projected.filter(item => item.displayKind !== 'company_closed'),
    ];
}
