import { expect, test } from '../fixtures/test';
import { hasAdmin } from '../fixtures/env';
import { AnalyticsPage } from '../pages/AnalyticsPage';

test.describe('@suite:analytics', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');

    test('@p0 ANALYTICS-01 page loads with channel comparison', async ({ page }) => {
        const analytics = new AnalyticsPage(page);
        await analytics.goto();

        test.skip(
            await analytics.channelComparisonHeading.count() === 0,
            'requires populated ad-channel analytics on staging',
        );
        await expect(analytics.heading).toBeVisible();
        await expect(analytics.channelComparisonHeading).toBeVisible();
        await expect(analytics.channelComparisonTable).toBeVisible();
    });

    test('@p0 ANALYTICS-02 both ad channels are compared', async ({ page }) => {
        const analytics = new AnalyticsPage(page);
        await analytics.goto();

        const google = analytics.channelRow('google');
        const elocal = analytics.channelRow('elocal');
        test.skip(
            await google.count() === 0 || await elocal.count() === 0,
            'requires both Google LSA and eLocal analytics on staging',
        );
        await expect(google).toBeVisible();
        await expect(elocal).toBeVisible();
        await expect(analytics.channelTotal).toBeVisible();
    });

    test('@p1 ANALYTICS-03 conversion basis toggles', async ({ page }) => {
        const analytics = new AnalyticsPage(page);
        await analytics.goto();

        const booked = analytics.basis('booked');
        const completed = analytics.basis('completed');
        test.skip(
            await booked.count() === 0 || await completed.count() === 0,
            'requires populated ad-channel analytics on staging',
        );
        await expect(completed).toHaveAttribute('aria-pressed', 'true');
        await expect(booked).toHaveAttribute('aria-pressed', 'false');

        await booked.click();
        await expect(booked).toHaveAttribute('aria-pressed', 'true');
        await expect(completed).toHaveAttribute('aria-pressed', 'false');
        await expect(analytics.channelComparisonTable).toBeVisible();

        await completed.click();
        await expect(completed).toHaveAttribute('aria-pressed', 'true');
        await expect(booked).toHaveAttribute('aria-pressed', 'false');
        await expect(analytics.channelComparisonTable).toBeVisible();
    });

    test('@p1 ANALYTICS-04 both channel detail cards render', async ({ page }) => {
        const analytics = new AnalyticsPage(page);
        await analytics.goto();

        test.skip(
            await analytics.googleDetail.count() === 0 || await analytics.elocalDetail.count() === 0,
            'requires both Google LSA and eLocal analytics on staging',
        );
        await expect(analytics.googleDetail).toBeVisible();
        await expect(analytics.elocalDetail).toBeVisible();
    });

    test('@p0 ANALYTICS-05 funnel filters by channel', async ({ page }) => {
        const analytics = new AnalyticsPage(page);
        await analytics.goto();
        await expect(analytics.funnelChannel).toBeVisible();

        const options = await analytics.funnelChannelOptions();
        const channel = options.find(option => option.value !== '');
        if (!channel) {
            test.skip(true, 'requires at least one funnel channel on staging');
            return;
        }
        expect(options.length).toBeGreaterThanOrEqual(2);

        await analytics.selectFunnelChannel(channel.value);
        await expect(analytics.funnelChannel).toHaveValue(channel.value);
        await expect(analytics.funnelRow('leads')).toBeVisible();

        await analytics.selectFunnelChannel('');
        await expect(analytics.funnelChannel).toHaveValue('');
        await expect(analytics.funnelRow('leads')).toBeVisible();
    });

    test('@p0 ANALYTICS-06 geo shows ZIPs by default', async ({ page }) => {
        const analytics = new AnalyticsPage(page);
        await analytics.goto();
        await expect(analytics.geoHeatmap).toBeVisible();
        await analytics.waitForGeo();

        const zipCount = await analytics.geoTopZipRows.count();
        if (zipCount === 0) {
            const noPeriodData = await analytics.geoEmpty
                .filter({ hasText: 'No booked jobs from ad channels in this period.' })
                .count() > 0;
            test.skip(noPeriodData, 'requires mapped ad-channel ZIPs on staging');
        }
        await expect(analytics.geoTopZips).toBeVisible();
        expect(zipCount).toBeGreaterThanOrEqual(1);
        await expect(analytics.geoEmpty).toBeHidden();
        await expect(analytics.geoTotal).not.toHaveText('0');
    });

    test('@p1 ANALYTICS-07 geo mode, channel, and ZIP selection interact', async ({ page }) => {
        const analytics = new AnalyticsPage(page);
        await analytics.goto();
        await analytics.waitForGeo();

        test.skip(await analytics.geoTopZipRows.count() === 0, 'requires mapped ad-channel ZIPs on staging');
        await analytics.setGeoMode('cpa');
        await analytics.setGeoChannel('google');

        const firstZip = await analytics.firstTopZip();
        if (!firstZip) {
            test.skip(true, 'requires a mapped Google LSA ZIP on staging');
            return;
        }
        await firstZip.row.click();

        await expect(firstZip.row).toHaveClass(/is-selected/);
        await expect(analytics.zipDetail(firstZip.zip)).toBeVisible();
        await expect(analytics.geoTopZips).toBeVisible();
        expect(await analytics.geoTopZipRows.count()).toBeGreaterThanOrEqual(1);
    });
});
