import type { MarketplaceApp } from '../../../services/marketplaceApi';

/**
 * MARKETPLACE-RATINGS-001 shared UI helpers — category labels/order, star
 * rendering, monogram gradients and pricing, used by the card, grid and detail.
 * Design tokens only (--blanc-*); gold #E0A72C is the sole rating exception.
 */

export const GOLD = '#E0A72C';
export const GOLD_EMPTY = '#D8D8D5';

/** Human labels for the raw `category` values seeded on apps. */
export const CATEGORY_LABEL: Record<string, string> = {
    lead_generation: 'Lead Generation',
    ai: 'AI & Automation',
    telephony: 'Telephony',
    payments: 'Payments',
    scheduling: 'Scheduling',
    communication: 'Communication',
    operations: 'Operations',
    customer_experience: 'Customer Experience',
};

/** Display order of category sections in the grid. */
export const CATEGORY_ORDER = [
    'lead_generation', 'ai', 'telephony', 'payments',
    'scheduling', 'communication', 'operations', 'customer_experience',
];

export function categoryLabel(raw: string): string {
    return CATEGORY_LABEL[raw] ?? raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Tasteful monogram gradient per category (logo tiles — brand color, not the action accent). */
const CATEGORY_GRAD: Record<string, [string, string]> = {
    lead_generation: ['#b26a1d', '#d98a3a'],
    ai: ['#4f46e5', '#7c6ff0'],
    telephony: ['#2f63d8', '#4f83e8'],
    payments: ['#1b8b63', '#29a878'],
    scheduling: ['#0d9488', '#22b8a6'],
    communication: ['#0284c7', '#38bdf8'],
    operations: ['#475569', '#64748b'],
    customer_experience: ['#db2777', '#ec4899'],
};

/** Avatars gets its flagship violet tile; everything else is category-coded. */
export function appGradient(app: Pick<MarketplaceApp, 'app_key' | 'category'>): string {
    if (app.app_key === 'chatgpt-crm-mcp') return 'linear-gradient(135deg,#7F42E1,#a37bec)';
    const g = CATEGORY_GRAD[app.category] ?? ['#64748b', '#94a3b8'];
    return `linear-gradient(135deg,${g[0]},${g[1]})`;
}

export function appMonogram(name: string): string {
    return (name.trim()[0] || '?').toUpperCase();
}

export interface Pricing { paid: boolean; label: string; text: string }

export function appPricing(app: MarketplaceApp): Pricing {
    const p = app.metadata?.pricing;
    if (p && typeof p === 'object') {
        return {
            paid: p.paid === true,
            label: p.label || (p.paid ? 'Paid' : 'Free'),
            text: p.text || '',
        };
    }
    return { paid: false, label: 'Free', text: 'Free with your Albusto plan.' };
}

/** Five star glyphs (gold filled to `filled`, grey empty). Rounds to nearest. */
export function Stars({ value, size = 13 }: { value: number; size?: number }) {
    const filled = Math.round(value);
    return (
        <span aria-hidden style={{ letterSpacing: 1, fontSize: size, lineHeight: 1, whiteSpace: 'nowrap' }}>
            {[1, 2, 3, 4, 5].map(i => (
                <span key={i} style={{ color: i <= filled ? GOLD : GOLD_EMPTY }}>★</span>
            ))}
        </span>
    );
}

/** Whether an app currently counts as connected/enabled (green state). */
export function isAppConnected(app: MarketplaceApp): boolean {
    return app.installation?.status === 'connected';
}
