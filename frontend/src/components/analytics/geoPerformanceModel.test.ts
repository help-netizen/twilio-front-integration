import { describe, expect, it } from 'vitest';
import type { GeoRow } from '../../services/leadChannelAnalyticsApi';
import {
    GREEN_HEAT_RAMP,
    NEUTRAL_HEAT,
    WARM_HEAT_RAMP,
    heatColor,
    metricsForGeoRow,
    qualityForChannel,
} from './geoPerformanceModel';

const row: GeoRow = {
    zip: '02118',
    area: 'Boston Core',
    in_configured_area: true,
    geometry: {
        google_place_id: 'postal-place-02118',
        lat: 42.337,
        lon: -71.071,
        status: 'resolved',
    },
    google_lsa: {
        converted_count: 2,
        ad_spend_cents: 500,
        revenue_net_cents: 1_500,
        cpa_cents: 250,
        avg_revenue_cents: 750,
        roas: 3,
        spend_is_modeled: true,
    },
    elocal: {
        converted_count: 3,
        ad_spend_cents: 700,
        revenue_net_cents: 2_500,
        cpa_cents: 233,
        avg_revenue_cents: 833,
        roas: 3.57,
        spend_is_modeled: false,
    },
};

describe('geo performance client model', () => {
    it('recomputes combined metrics from summed count, spend, and revenue', () => {
        expect(metricsForGeoRow(row, 'all')).toEqual({
            count: 5,
            spend: 1_200,
            revenue: 4_000,
            cpa: 240,
            avg: 800,
            roas: 4_000 / 1_200,
        });
        expect(metricsForGeoRow(row, 'google')).toMatchObject({
            count: 2,
            spend: 500,
            revenue: 1_500,
        });
        expect(metricsForGeoRow(row, 'elocal')).toMatchObject({
            count: 3,
            spend: 700,
            revenue: 2_500,
        });
    });

    it('uses the approved five linear heat buckets and neutral null color', () => {
        const values = [10, 20, 30, 40, 50];
        expect(values.map(value => heatColor(value, values, GREEN_HEAT_RAMP))).toEqual(GREEN_HEAT_RAMP);
        expect(heatColor(30, [30], WARM_HEAT_RAMP)).toBe(WARM_HEAT_RAMP[4]);
        expect(heatColor(null, values, GREEN_HEAT_RAMP)).toBe(NEUTRAL_HEAT);
    });

    it('labels spend quality by channel', () => {
        expect(qualityForChannel('google')).toMatchObject({ tag: 'EST', label: 'Modeled spend' });
        expect(qualityForChannel('elocal')).toMatchObject({ tag: 'Exact', label: 'Exact spend' });
        expect(qualityForChannel('all')).toMatchObject({ tag: 'Mixed', label: 'Mixed spend' });
    });
});
