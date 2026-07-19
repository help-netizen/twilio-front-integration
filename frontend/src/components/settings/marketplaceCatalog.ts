import type { MarketplaceApp } from '../../services/marketplaceApi';

export type MarketplaceCatalogId =
    | 'scheduling'
    | 'jobs-leads'
    | 'communication-ai'
    | 'payments'
    | 'other';

export interface MarketplaceCatalogDefinition {
    id: MarketplaceCatalogId;
    label: string;
}

export interface MarketplaceCatalogGroup {
    catalog: MarketplaceCatalogDefinition;
    apps: MarketplaceApp[];
}

export const MARKETPLACE_CATALOGS: readonly MarketplaceCatalogDefinition[] = [
    { id: 'scheduling', label: 'Scheduling & service areas' },
    { id: 'jobs-leads', label: 'Jobs and Leads' },
    { id: 'communication-ai', label: 'Communication and AI' },
    { id: 'payments', label: 'Payments' },
    { id: 'other', label: 'Other' },
];

/**
 * Marketplace seed categories predate the current Settings IA and are too broad
 * to derive these catalogs reliably (for example, `ai` spans calls, email, and
 * outbound leads). Keep the presentation taxonomy explicit by stable app_key.
 * Unknown/new apps intentionally fall back to Other so they can never disappear.
 */
export const MARKETPLACE_APP_CATALOG: Readonly<Record<string, MarketplaceCatalogId>> = {
    'call-qa-agent': 'communication-ai',
    'lead-generator': 'jobs-leads',
    'mail-secretary': 'communication-ai',
    'vapi-ai': 'communication-ai',
    'stripe-payments': 'payments',
    'smart-slot-engine': 'scheduling',
    'google-email': 'communication-ai',
    'telephony-twilio': 'communication-ai',
    'ai-repair-advisor': 'jobs-leads',
    'pro-referral-leads': 'jobs-leads',
    'rely-leads': 'jobs-leads',
    'nsa-leads': 'jobs-leads',
    'lhg-leads': 'jobs-leads',
    'outbound-lead-caller': 'communication-ai',
    'rate-me': 'jobs-leads',
};

const MARKETPLACE_CATALOG_BY_ID = new Map(
    MARKETPLACE_CATALOGS.map(catalog => [catalog.id, catalog]),
);

export function marketplaceCatalogIdForApp(appKey: string): MarketplaceCatalogId {
    return MARKETPLACE_APP_CATALOG[appKey] ?? 'other';
}

export function marketplaceCatalogForApp(appKey: string): MarketplaceCatalogDefinition {
    return MARKETPLACE_CATALOG_BY_ID.get(marketplaceCatalogIdForApp(appKey))!;
}

function normalizeSearchValue(value: string): string {
    return value
        .toLocaleLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function filterMarketplaceApps(
    apps: MarketplaceApp[],
    searchQuery: string,
    selectedCatalogs: MarketplaceCatalogId[],
): MarketplaceApp[] {
    const query = normalizeSearchValue(searchQuery);

    return apps.filter(app => {
        const catalog = marketplaceCatalogForApp(app.app_key);
        const matchesCatalog = selectedCatalogs.length === 0
            || selectedCatalogs.includes(catalog.id);
        const matchesSearch = query.length === 0 || [app.name, catalog.label, app.category]
            .some(value => normalizeSearchValue(value).includes(query));

        return matchesCatalog && matchesSearch;
    });
}

export function groupMarketplaceApps(apps: MarketplaceApp[]): MarketplaceCatalogGroup[] {
    return MARKETPLACE_CATALOGS.flatMap(catalog => {
        const catalogApps = apps.filter(
            app => marketplaceCatalogIdForApp(app.app_key) === catalog.id,
        );

        return catalogApps.length > 0 ? [{ catalog, apps: catalogApps }] : [];
    });
}

export function toggleMarketplaceCatalog(
    selectedCatalogs: MarketplaceCatalogId[],
    catalogId: MarketplaceCatalogId,
): MarketplaceCatalogId[] {
    return selectedCatalogs.includes(catalogId)
        ? selectedCatalogs.filter(id => id !== catalogId)
        : [...selectedCatalogs, catalogId];
}
