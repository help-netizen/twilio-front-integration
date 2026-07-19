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
 * Settings groups derive from the seed `category` column, never from app_key:
 * per-source lead apps are interchangeable data (MARKETPLACE-LEADGEN-SPLIT-001),
 * so a new lead source seeded with `lead_generation` lands in Jobs and Leads
 * with no frontend change. Unknown categories intentionally fall back to Other
 * so an app can never disappear.
 */
export const MARKETPLACE_CATEGORY_CATALOG: Readonly<Record<string, MarketplaceCatalogId>> = {
    lead_generation: 'jobs-leads',
    scheduling: 'scheduling',
    payments: 'payments',
    ai: 'communication-ai',
    telephony: 'communication-ai',
    communication: 'communication-ai',
};

/**
 * Curated placement for singleton apps whose seed category (`operations`,
 * `customer_experience`) is broader than the Settings IA. Per-source lead apps
 * must never appear here — they flow through the `lead_generation` rule above.
 */
export const MARKETPLACE_APP_CATALOG: Readonly<Record<string, MarketplaceCatalogId>> = {
    'ai-repair-advisor': 'jobs-leads',
    'rate-me': 'jobs-leads',
};

const MARKETPLACE_CATALOG_BY_ID = new Map(
    MARKETPLACE_CATALOGS.map(catalog => [catalog.id, catalog]),
);

type MarketplaceCatalogSource = Pick<MarketplaceApp, 'app_key' | 'category'>;

export function marketplaceCatalogIdForApp(app: MarketplaceCatalogSource): MarketplaceCatalogId {
    return MARKETPLACE_APP_CATALOG[app.app_key]
        ?? MARKETPLACE_CATEGORY_CATALOG[app.category]
        ?? 'other';
}

export function marketplaceCatalogForApp(app: MarketplaceCatalogSource): MarketplaceCatalogDefinition {
    return MARKETPLACE_CATALOG_BY_ID.get(marketplaceCatalogIdForApp(app))!;
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
        const catalog = marketplaceCatalogForApp(app);
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
            app => marketplaceCatalogIdForApp(app) === catalog.id,
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
