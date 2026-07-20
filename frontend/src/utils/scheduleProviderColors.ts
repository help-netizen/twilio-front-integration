/**
 * Collision-free technician colour assignment for Schedule surfaces.
 *
 * The complete roster is normalized, de-duplicated, and sorted by stable key
 * before palette indices are assigned. This deliberately follows the ZIP
 * polygon registry precedent: input order and active filters cannot move a
 * technician to a different colour, and no hash collisions are possible while
 * the roster fits in the 16-colour PALETTE-V2 map palette.
 */

export interface TechnicianRosterEntry {
    id?: string | null;
    name?: string | null;
}

export interface TechnicianColor {
    bg: string;
    border: string;
    accent: string;
    text: string;
}

export interface RegisteredTechnician {
    key: string;
    id: string;
    name: string;
    initials: string;
    colorIndex: number;
    color: TechnicianColor;
}

export interface TechnicianColorRegistry {
    roster: readonly RegisteredTechnician[];
    byKey: ReadonlyMap<string, RegisteredTechnician>;
    paletteSize: number;
    showInitialsOnPins: boolean;
}

// Exact values of --blanc-map-area-1..16 in design-system.css. Google Maps
// requires resolved colours rather than CSS var() expressions for markers and
// polylines, so the shared registry exposes the concrete PALETTE-V2 values.
export const SCHEDULE_TECHNICIAN_PALETTE = [
    '#7F42E1', '#4F5BA8', '#2F63D8', '#147A9C',
    '#087E8B', '#1B8B63', '#5F7A1F', '#B26A1D',
    '#D56A1F', '#D85A3F', '#C74646', '#A43A78',
    '#B5415C', '#7B4D9D', '#466B9E', '#8A5A32',
] as const;

export const UNASSIGNED_TECHNICIAN_COLOR: TechnicianColor = {
    bg: 'rgba(107, 114, 128, 0.10)',
    border: 'rgba(107, 114, 128, 0.38)',
    accent: '#6B7280',
    text: '#4B5563',
};

function normalize(value: string | null | undefined): string {
    return value?.trim().normalize('NFC') || '';
}

function compareCodepoints(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

function hexToRgba(hex: string, alpha: number): string {
    const value = hex.replace('#', '');
    const red = Number.parseInt(value.slice(0, 2), 16);
    const green = Number.parseInt(value.slice(2, 4), 16);
    const blue = Number.parseInt(value.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function technicianColor(accent: string): TechnicianColor {
    return {
        bg: hexToRgba(accent, 0.11),
        border: hexToRgba(accent, 0.32),
        accent,
        text: accent,
    };
}

export function technicianKey(entry: TechnicianRosterEntry | null | undefined): string {
    return normalize(entry?.id) || normalize(entry?.name);
}

export function technicianInitials(name: string): string {
    const parts = normalize(name).split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    return parts.slice(0, 2).map(part => part[0]).join('').toUpperCase();
}

export function buildTechnicianColorRegistry(
    completeRoster: readonly TechnicianRosterEntry[],
): TechnicianColorRegistry {
    const unique = new Map<string, { id: string; name: string }>();
    for (const entry of completeRoster) {
        const key = technicianKey(entry);
        if (!key) continue;
        const id = normalize(entry.id) || key;
        const name = normalize(entry.name) || id;
        const current = unique.get(key);
        if (!current || (current.name === current.id && name !== id)) {
            unique.set(key, { id, name });
        }
    }

    const sorted = [...unique.entries()].sort(([left], [right]) => compareCodepoints(left, right));
    const roster = sorted.map(([key, entry], colorIndex): RegisteredTechnician => ({
        key,
        id: entry.id,
        name: entry.name,
        initials: technicianInitials(entry.name),
        colorIndex,
        color: technicianColor(SCHEDULE_TECHNICIAN_PALETTE[colorIndex % SCHEDULE_TECHNICIAN_PALETTE.length]),
    }));

    const byKey = new Map<string, RegisteredTechnician>();
    for (const technician of roster) {
        // id and name are both accepted because schedule filtering already
        // supports both forms for imported/legacy assignments.
        for (const alias of [technician.key, technician.id, technician.name]) {
            const normalized = normalize(alias);
            if (normalized && !byKey.has(normalized)) byKey.set(normalized, technician);
        }
    }

    return {
        roster,
        byKey,
        paletteSize: SCHEDULE_TECHNICIAN_PALETTE.length,
        showInitialsOnPins: roster.length > SCHEDULE_TECHNICIAN_PALETTE.length,
    };
}

export function registeredTechnician(
    registry: TechnicianColorRegistry,
    key: string | null | undefined,
): RegisteredTechnician | undefined {
    return registry.byKey.get(normalize(key));
}

export function colorForTechnician(
    registry: TechnicianColorRegistry,
    key: string | null | undefined,
): TechnicianColor {
    return registeredTechnician(registry, key)?.color || UNASSIGNED_TECHNICIAN_COLOR;
}
