export const LEAD_REVIEW_COLOR = '#b44d3d';

// UI-QA-001: pill text = full color on a 10% tint — 500-tier hues sat below AA.
// Same hues one step deeper; Submitted = system job-blue, Contacted stays the
// system success token. Mirrors jobs BLANC_STATUS_COLORS treatment.
export const LEAD_STATUS_COLORS: Record<string, string> = {
    'Review': LEAD_REVIEW_COLOR,
    'Submitted': '#2F63D8',
    'New': '#7C3AED',
    'Contacted': '#1B8B63',
    'Qualified': '#15803D',
    'Proposal Sent': '#B45309',
    'Negotiation': '#C2410C',
    'Lost': '#DC2626',
    'Converted': '#6B7280',
};

export function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

export function getLeadStatusPillStyle(status: string): { bg: string; color: string; border: string } {
    const color = LEAD_STATUS_COLORS[status] || '#6B7280';
    const isReview = status === 'Review';

    return {
        bg: hexToRgba(color, isReview ? 0.14 : 0.1),
        color,
        border: isReview ? hexToRgba(color, 0.24) : 'transparent',
    };
}
