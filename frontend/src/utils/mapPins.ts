/**
 * Shared Google Maps pin renderer.
 *
 * Produces a numbered teardrop marker as an SVG `data:` URI (28×40, white
 * stroke, centered white number) suitable for `google.maps.Marker.icon.url`.
 *
 * Pure — no React, no imports. Extracted verbatim from
 * `CustomTimeModal.JobMap.makePinSvg` so the slot-picker map and the mobile
 * schedule map share ONE pin definition. Output is byte-identical to the
 * previous inline version (same SVG string, same `encodeURIComponent` result).
 *
 * @param num   1-based stop number rendered inside the pin.
 * @param color Fill color (hex or CSS color string) for the pin body.
 * @returns An `image/svg+xml` data-URI string.
 */
export function makePinSvg(num: number, color: string): string {
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
            <svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40">
                <path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.27 21.73 0 14 0z" fill="${color}" stroke="#fff" stroke-width="1.5"/>
                <text x="14" y="19" text-anchor="middle" fill="#fff" font-size="12" font-weight="bold" font-family="Arial">${num}</text>
            </svg>
        `);
}

export interface SchedulePinSvgOptions {
    label: string;
    color: string;
    secondaryColor?: string;
    unassigned?: boolean;
    initials?: string;
}

function escapeSvgText(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Schedule map marker: one pin per job, optional joint-job secondary ring,
 * neutral outlined Unassigned state, and initials when a roster exceeds the
 * finite 16-colour palette.
 */
export function makeSchedulePinSvg({
    label,
    color,
    secondaryColor,
    unassigned = false,
    initials,
}: SchedulePinSvgOptions): string {
    const safeLabel = escapeSvgText(label);
    const safeInitials = initials ? escapeSvgText(initials.slice(0, 2)) : '';
    const fill = unassigned ? '#FFFFFF' : color;
    const text = unassigned ? color : '#FFFFFF';
    const outerStroke = secondaryColor || (unassigned ? color : '#FFFFFF');
    const outerWidth = secondaryColor ? 4 : 2;
    const initialsBadge = safeInitials
        ? `<rect x="5" y="20" width="24" height="9" rx="4.5" fill="#FFFFFF" fill-opacity="0.94"/>
           <text x="17" y="27" text-anchor="middle" fill="${color}" font-size="7" font-weight="700" font-family="Arial">${safeInitials}</text>`
        : '';

    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="34" height="48" viewBox="0 0 34 48">
            <path d="M17 1C8.72 1 2 7.72 2 16c0 11.25 15 28 15 28s15-16.75 15-28C32 7.72 25.28 1 17 1z" fill="${fill}" stroke="${outerStroke}" stroke-width="${outerWidth}"/>
            ${secondaryColor ? `<path d="M17 3.5C10.1 3.5 4.5 9.1 4.5 16c0 9.35 12.5 24.2 12.5 24.2S29.5 25.35 29.5 16C29.5 9.1 23.9 3.5 17 3.5z" fill="${fill}" stroke="#FFFFFF" stroke-width="1.4"/>` : ''}
            <text x="17" y="19" text-anchor="middle" fill="${text}" font-size="12" font-weight="700" font-family="Arial">${safeLabel}</text>
            ${initialsBadge}
        </svg>
    `);
}
