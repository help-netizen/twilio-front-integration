/**
 * Provider color palette — each provider gets a unique, deterministic color
 * based on a hash of their ID. Used for card backgrounds and filter chips.
 */

export interface ProviderColor {
    bg: string;
    border: string;
    accent: string;
    text: string;
}

export const PROVIDER_PALETTE: ProviderColor[] = [
    { bg: 'rgba(219, 234, 254, 0.52)', border: 'rgba(59, 130, 246, 0.28)', accent: '#3b82f6', text: '#1e40af' },   // blue
    { bg: 'rgba(220, 252, 231, 0.52)', border: 'rgba(34, 197, 94, 0.28)', accent: '#16a34a', text: '#166534' },    // green
    { bg: 'rgba(254, 243, 199, 0.52)', border: 'rgba(245, 158, 11, 0.28)', accent: '#d97706', text: '#92400e' },   // amber
    { bg: 'rgba(237, 233, 254, 0.52)', border: 'rgba(139, 92, 246, 0.28)', accent: '#7c3aed', text: '#5b21b6' },   // violet
    { bg: 'rgba(254, 226, 226, 0.52)', border: 'rgba(239, 68, 68, 0.28)', accent: '#dc2626', text: '#991b1b' },    // red
    { bg: 'rgba(204, 251, 241, 0.52)', border: 'rgba(20, 184, 166, 0.28)', accent: '#0d9488', text: '#0f766e' },   // teal
    { bg: 'rgba(255, 237, 213, 0.52)', border: 'rgba(249, 115, 22, 0.28)', accent: '#ea580c', text: '#9a3412' },   // orange
    { bg: 'rgba(252, 231, 243, 0.52)', border: 'rgba(236, 72, 153, 0.28)', accent: '#db2777', text: '#9d174d' },   // pink
    { bg: 'rgba(224, 242, 254, 0.52)', border: 'rgba(14, 165, 233, 0.28)', accent: '#0284c7', text: '#075985' },   // sky
    { bg: 'rgba(236, 252, 203, 0.52)', border: 'rgba(132, 204, 22, 0.28)', accent: '#65a30d', text: '#3f6212' },   // lime
];

/** Deterministic color index from provider ID string */
function hashIndex(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
        h = Math.imul(31, h) + id.charCodeAt(i) | 0;
    }
    return Math.abs(h) % PROVIDER_PALETTE.length;
}

export function getProviderColor(providerId: string): ProviderColor {
    return PROVIDER_PALETTE[hashIndex(providerId)];
}

/** Gradient string for card background using provider color */
export function providerCardGradient(providerId: string): string {
    const c = getProviderColor(providerId);
    return `linear-gradient(180deg, ${c.bg}, ${c.bg})`;
}
