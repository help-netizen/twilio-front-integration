import { describe, expect, it } from 'vitest';
import type { MarketplaceApp } from '../../services/marketplaceApi';
import {
    filterMarketplaceApps,
    groupMarketplaceApps,
    MARKETPLACE_APP_CATALOG,
    marketplaceCatalogIdForApp,
    toggleMarketplaceCatalog,
    type MarketplaceCatalogId,
} from './marketplaceCatalog';

const SEEDED_APP_CATALOGS: Record<string, MarketplaceCatalogId> = {
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
    marketplaceApp('lead-generator', 'Website Leads', 'lead_generation'),
];

describe('marketplace catalog taxonomy', () => {
    it('assigns every seeded app_key and sends an unknown app to Other', () => {
        expect(MARKETPLACE_APP_CATALOG).toEqual(SEEDED_APP_CATALOGS);

        for (const [appKey, catalogId] of Object.entries(SEEDED_APP_CATALOGS)) {
            expect(marketplaceCatalogIdForApp(appKey)).toBe(catalogId);
            expect(marketplaceCatalogIdForApp(appKey)).not.toBe('other');
        }

        expect(marketplaceCatalogIdForApp('new-unmapped-app')).toBe('other');
    });

    it('matches search by app name, Settings catalog, and legacy data category', () => {
        expect(filterMarketplaceApps(APPS, 'stripe', []).map(app => app.app_key))
            .toEqual(['stripe-payments']);
        expect(filterMarketplaceApps(APPS, 'communication', []).map(app => app.app_key))
            .toEqual(['call-qa-agent']);
        expect(filterMarketplaceApps(APPS, 'lead generation', []).map(app => app.app_key))
            .toEqual(['lead-generator']);
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
