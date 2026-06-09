export const LEAD_REVIEW_COLOR = '#b44d3d';

export const LEAD_STATUS_COLORS: Record<string, string> = {
    'Review': LEAD_REVIEW_COLOR,
    'Submitted': '#3B82F6',
    'New': '#8B5CF6',
    'Contacted': '#1B8B63',
    'Qualified': '#22C55E',
    'Proposal Sent': '#F59E0B',
    'Negotiation': '#F97316',
    'Lost': '#EF4444',
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
