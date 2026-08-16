import { expect, type Locator, type Page } from '@playwright/test';

type GeoChannel = 'all' | 'google' | 'elocal';
type GeoMode = 'count' | 'cpa' | 'avg' | 'roas';

export class AnalyticsPage {
    constructor(private readonly page: Page) {}

    get heading(): Locator {
        return this.page.getByRole('heading', { name: 'Analytics', exact: true });
    }

    get channelComparisonHeading(): Locator {
        return this.page.getByRole('heading', { name: 'Channel comparison', exact: true });
    }

    get channelComparisonTable(): Locator {
        return this.page.getByRole('table').filter({
            has: this.page.getByRole('columnheader', { name: 'Lifetime value', exact: true }),
        });
    }

    channelRow(channel: 'google' | 'elocal'): Locator {
        return this.page.getByTestId(`analytics-channel-row-${channel}`);
    }

    get channelTotal(): Locator {
        return this.page.getByTestId('analytics-channel-total');
    }

    basis(basis: 'completed' | 'booked'): Locator {
        return this.page.getByTestId(`analytics-basis-${basis}`);
    }

    get googleDetail(): Locator {
        return this.page.getByTestId('analytics-google-detail');
    }

    get elocalDetail(): Locator {
        return this.page.getByTestId('analytics-elocal-detail');
    }

    get funnelChannel(): Locator {
        return this.page.getByTestId('analytics-funnel-channel');
    }

    funnelRow(stage: 'leads' | 'converted' | 'visit_completed' | 'job_is_done'): Locator {
        return this.page.getByTestId(`analytics-funnel-row-${stage}`);
    }

    get geoHeatmap(): Locator {
        return this.page.getByTestId('geo-heatmap');
    }

    get geoMap(): Locator {
        return this.page.getByTestId('geo-heatmap-map');
    }

    get geoTotal(): Locator {
        return this.page.getByTestId('geo-heatmap-total');
    }

    get geoTopZips(): Locator {
        return this.page.getByTestId('geo-heatmap-topzips');
    }

    get geoTopZipRows(): Locator {
        return this.page.getByTestId(/^geo-heatmap-topzip-/);
    }

    get geoEmpty(): Locator {
        return this.page.getByTestId('geo-heatmap-empty');
    }

    geoMode(mode: GeoMode): Locator {
        return this.page.getByTestId(`geo-mode-${mode}`);
    }

    geoChannel(channel: GeoChannel): Locator {
        return this.page.getByTestId(`geo-channel-${channel}`);
    }

    zipDetail(zip: string): Locator {
        return this.page.locator('aside.geo-heatmap__detail').filter({
            has: this.page.getByRole('heading', { name: zip, exact: true }),
        });
    }

    async goto(): Promise<void> {
        await this.page.goto('/settings/analytics');
        await expect(this.heading).toBeVisible();
        await expect(this.page.getByText('Loading analytics…', { exact: true })).toHaveCount(0);
    }

    async selectFunnelChannel(value: string): Promise<void> {
        await this.funnelChannel.selectOption(value);
    }

    async funnelChannelOptions(): Promise<Array<{ label: string; value: string }>> {
        return this.funnelChannel.locator('option').evaluateAll(options => options.map(option => ({
            label: option.textContent?.trim() ?? '',
            value: (option as HTMLOptionElement).value,
        })));
    }

    async setGeoMode(mode: GeoMode): Promise<void> {
        const button = this.geoMode(mode);
        await button.click();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
    }

    async setGeoChannel(channel: GeoChannel): Promise<void> {
        const button = this.geoChannel(channel);
        await button.click();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
    }

    async waitForGeo(): Promise<void> {
        await expect(this.geoHeatmap.getByText('Loading geographic performance…', { exact: true }))
            .toHaveCount(0);
    }

    async firstTopZip(): Promise<{ row: Locator; zip: string } | null> {
        const row = this.geoTopZipRows.first();
        if (await row.count() === 0) return null;
        const testId = await row.getAttribute('data-testid');
        const prefix = 'geo-heatmap-topzip-';
        if (!testId?.startsWith(prefix)) return null;
        return { row, zip: testId.slice(prefix.length) };
    }
}
