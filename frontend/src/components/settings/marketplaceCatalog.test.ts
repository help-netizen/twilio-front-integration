import { describe, expect, it } from 'vitest';
import type { MarketplaceApp } from '../../services/marketplaceApi';
import {
    filterMarketplaceApps,
    groupMarketplaceApps,
    MARKETPLACE_APP_CATALOG,
    MARKETPLACE_CATEGORY_CATALOG,
    marketplaceCatalogIdForApp,
    toggleMarketplaceCatalog,
    type MarketplaceCatalogId,
} from './marketplaceCatalog';

// Seed categories actually shipped in backend/db/migrations — the catalog must
// place every one of them without naming a single per-source lead app_key
// (MARKETPLACE-LEADGEN-SPLIT-001: adding a lead source is a data-only change).
const SEEDED_CATEGORY_CATALOGS: Record<string, MarketplaceCatalogId> = {
    lead_generation: 'jobs-leads',
    scheduling: 'scheduling',
    payments: 'payments',
    ai: 'communication-ai',
    telephony: 'communication-ai',
    communication: 'communication-ai',
};

function marketplaceApp(appKey: string, name: string, category: string): MarketplaceApp {
    return {
        id: 1,
        app_key: appKey,
        name,
        provider_name: 'Test Provider',
        category,
        app_type: 'internal',
        short_description: 'Test app',
        long_description: null,
        logo_url: null,
        docs_url: null,
        support_email: null,
        privacy_url: null,
        requested_scopes: [],
        access_summary: [],
        provisioning_mode: 'none',
        status: 'published',
        metadata: {},
        installation: null,
    };
}

const APPS = [
    marketplaceApp('smart-slot-engine', 'Smart Slot Engine', 'scheduling'),
    marketplaceApp('stripe-payments', 'Stripe Payments', 'payments'),
    marketplaceApp('call-qa-agent', 'Call QA Agent', 'ai'),
    marketplaceApp('website-leads', 'Website Leads', 'lead_generation'),
];

describe('marketplace catalog taxonomy', () => {
    it('derives the Settings group from the seed category, never from lead app keys', () => {
        expect(MARKETPLACE_CATEGORY_CATALOG).toEqual(SEEDED_CATEGORY_CATALOGS);

        for (const [category, catalogId] of Object.entries(SEEDED_CATEGORY_CATALOGS)) {
            const app = marketplaceApp('any-app', 'Any App', category);
            expect(marketplaceCatalogIdForApp(app)).toBe(catalogId);
        }
    });

    it('places a brand-new lead source with zero frontend changes', () => {
        // The MARKETPLACE-LEADGEN-SPLIT-001 guarantee: a source added purely by
        // seeding a `lead_generation` marketplace app groups correctly here.
        const newSource = marketplaceApp('acme-leads', 'Acme Leads', 'lead_generation');
        expect(marketplaceCatalogIdForApp(newSource)).toBe('jobs-leads');
        expect(Object.keys(MARKETPLACE_APP_CATALOG).some(key => key.endsWith('-leads'))).toBe(false);
    });

    it('keeps curated placement for the two singleton apps with broad categories', () => {
        expect(MARKETPLACE_APP_CATALOG).toEqual({
            'ai-repair-advisor': 'jobs-leads',
            'rate-me': 'jobs-leads',
        });
        expect(marketplaceCatalogIdForApp(
            marketplaceApp('ai-repair-advisor', 'AI Repair Advisor', 'operations'),
        )).toBe('jobs-leads');
        expect(marketplaceCatalogIdForApp(
            marketplaceApp('rate-me', 'Rate Me', 'customer_experience'),
        )).toBe('jobs-leads');
    });

    it('sends an unknown category to Other so an app can never disappear', () => {
        const unknown = marketplaceApp('new-unmapped-app', 'New App', 'not-a-category');
        expect(marketplaceCatalogIdForApp(unknown)).toBe('other');
        expect(groupMarketplaceApps([unknown]).map(group => group.catalog.id)).toEqual(['other']);
    });

    it('matches search by app name, Settings catalog, and legacy data category', () => {
        expect(filterMarketplaceApps(APPS, 'stripe', []).map(app => app.app_key))
            .toEqual(['stripe-payments']);
        expect(filterMarketplaceApps(APPS, 'communication', []).map(app => app.app_key))
            .toEqual(['call-qa-agent']);
        expect(filterMarketplaceApps(APPS, 'lead generation', []).map(app => app.app_key))
            .toEqual(['website-leads']);
    });

    it('supports the category popover multi-select and deselection behavior', () => {
        let selected: MarketplaceCatalogId[] = [];
        selected = toggleMarketplaceCatalog(selected, 'payments');
        selected = toggleMarketplaceCatalog(selected, 'communication-ai');

        expect(selected).toEqual(['payments', 'communication-ai']);
        expect(filterMarketplaceApps(APPS, '', selected).map(app => app.app_key))
            .toEqual(['stripe-payments', 'call-qa-agent']);

        selected = toggleMarketplaceCatalog(selected, 'payments');
        expect(selected).toEqual(['communication-ai']);
    });

    it('groups matching apps in the fixed Settings catalog order', () => {
        const groups = groupMarketplaceApps([...APPS].reverse());

        expect(groups.map(group => group.catalog.label)).toEqual([
            'Scheduling & service areas',
            'Jobs and Leads',
            'Communication and AI',
            'Payments',
        ]);
        expect(groups.flatMap(group => group.apps)).toHaveLength(APPS.length);
    });
});
