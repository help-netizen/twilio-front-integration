import { describe, expect, it } from 'vitest';
import { integrationTabFromSearchParams } from './integrationSettingsTabs';
import pageSource from './IntegrationsPage.tsx?raw';

describe('addressable Integrations tabs', () => {
    it('resolves every supported tab and defaults missing/invalid values to Marketplace', () => {
        expect(integrationTabFromSearchParams(new URLSearchParams())).toBe('marketplace');
        expect(integrationTabFromSearchParams(new URLSearchParams('tab=marketplace'))).toBe('marketplace');
        expect(integrationTabFromSearchParams(new URLSearchParams('tab=api-keys'))).toBe('api-keys');
        expect(integrationTabFromSearchParams(new URLSearchParams('tab=zenbooker'))).toBe('zenbooker');
        expect(integrationTabFromSearchParams(new URLSearchParams('tab=unknown'))).toBe('marketplace');
    });

    it('controls Tabs from the URL and preserves other search parameters on change', () => {
        expect(pageSource).toContain('value={activeTab}');
        expect(pageSource).toContain('new URLSearchParams(searchParams)');
        expect(pageSource).toContain("next.set('tab', value)");
        expect(pageSource).toContain("navigate('/settings/api-docs')");
    });

    it('renders published Marketplace apps through the grouped catalog browser', () => {
        expect(pageSource).toContain('<MarketplaceBrowser');
        expect(pageSource).toContain('apps={apps}');
        expect(pageSource).toContain('renderApp={app => (');
    });

    it('keeps Inspector settings addressable within the Marketplace URL', () => {
        expect(pageSource).toContain("searchParams.get('app') === 'inspector'");
        expect(pageSource).toContain("next.set('app', 'inspector')");
        expect(pageSource).toContain("next.delete('app')");
        expect(pageSource).toContain("app.app_key === 'inspector' ? 'Settings' : 'Setup'");
    });
});
