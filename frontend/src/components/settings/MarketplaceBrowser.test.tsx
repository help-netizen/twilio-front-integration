import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MarketplaceApp } from '../../services/marketplaceApi';
import browserSource from './MarketplaceBrowser.tsx?raw';
import { MarketplaceCatalogSections } from './MarketplaceCatalogSections';
import { groupMarketplaceApps } from './marketplaceCatalog';

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

describe('MarketplaceBrowser', () => {
    it('renders app cards beneath grouped catalog headings, including Other', () => {
        const groups = groupMarketplaceApps([
            marketplaceApp('stripe-payments', 'Stripe Payments', 'payments'),
            marketplaceApp('unmapped-app', 'New Partner App', 'experimental'),
            marketplaceApp('smart-slot-engine', 'Smart Slot Engine', 'scheduling'),
        ]);
        const markup = renderToStaticMarkup(
            <MarketplaceCatalogSections
                groups={groups}
                renderApp={app => <article data-app-key={app.app_key}>{app.name}</article>}
            />,
        );

        expect(markup).toContain('Scheduling &amp; service areas');
        expect(markup).toContain('Payments');
        expect(markup).toContain('Other');
        expect(markup).toContain('Smart Slot Engine');
        expect(markup).toContain('Stripe Payments');
        expect(markup).toContain('New Partner App');
        expect(markup.indexOf('Scheduling &amp; service areas'))
            .toBeLessThan(markup.indexOf('Payments'));
        expect(markup.indexOf('Payments')).toBeLessThan(markup.indexOf('Other'));
    });

    it('uses the Jobs filter popover primitives and opens them from the search input', () => {
        expect(browserSource).toContain('<PopoverTrigger asChild>');
        expect(browserSource).toContain('<PopoverContent');
        expect(browserSource).toContain('<FilterColumn');
        expect(browserSource).toContain('<PopoverTrigger asChild>\n                        <Input');
        expect(browserSource).toContain('toggleMarketplaceCatalog(selectedCatalogs, catalog.id)');
    });
});
