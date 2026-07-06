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
