'use strict';

jest.mock('axios', () => ({ post: jest.fn() }));

const axios = require('axios');
const {
    API_BASE_URL,
    TOKEN_URL,
    executeQuery,
    fetchAccountMetadata,
    fetchCampaignPerformance,
    refreshAccessToken,
} = require('../backend/src/services/googleAdsAdapter');

const CREDS = {
    clientId: 'oauth-client',
    clientSecret: 'oauth-secret',
    refreshToken: 'refresh-secret',
    developerToken: 'developer-secret',
    customerId: '1234567890',
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('Google Ads v23 adapter', () => {
    test('OAuth refresh uses the form-encoded token exchange shape', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'access-private' } });

        await expect(refreshAccessToken(CREDS)).resolves.toBe('access-private');

        expect(axios.post).toHaveBeenCalledWith(
            TOKEN_URL,
            expect.stringContaining('grant_type=refresh_token'),
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10_000,
            }
        );
        const body = axios.post.mock.calls[0][1];
        expect(new URLSearchParams(body).get('client_id')).toBe(CREDS.clientId);
        expect(new URLSearchParams(body).get('client_secret')).toBe(CREDS.clientSecret);
        expect(new URLSearchParams(body).get('refresh_token')).toBe(CREDS.refreshToken);
    });

    test('daily GAQL includes segments.date, v23 headers, pagination, and exact micros', async () => {
        axios.post
            .mockResolvedValueOnce({ data: { access_token: 'access-private' } })
            .mockResolvedValueOnce({
                data: {
                    results: [{
                        segments: { date: '2026-07-26' },
                        campaign: { id: '44', name: 'Search' },
                        metrics: {
                            costMicros: '9007199254740993',
                            impressions: '20',
                            clicks: '3',
                            conversions: '1.5',
                            conversionsValue: '225.75',
                        },
                    }],
                    nextPageToken: 'next-private',
                },
            })
            .mockResolvedValueOnce({
                data: {
                    results: [{
                        segments: { date: '2026-07-27' },
                        campaign: { id: '45', name: 'Local' },
                        metrics: { costMicros: '1000000' },
                    }],
                },
            });

        const rows = await fetchCampaignPerformance({
            ...CREDS,
            startDate: '2026-07-26',
            endDate: '2026-07-27',
        });

        expect(rows).toEqual([
            {
                external_campaign_id: '44',
                external_campaign_name: 'Search',
                performance_date: '2026-07-26',
                cost_micros: '9007199254740993',
                impressions: '20',
                clicks: '3',
                conversions: '1.5',
                conversions_value: '225.75',
            },
            {
                external_campaign_id: '45',
                external_campaign_name: 'Local',
                performance_date: '2026-07-27',
                cost_micros: '1000000',
                impressions: '0',
                clicks: '0',
                conversions: '0',
                conversions_value: '0',
            },
        ]);

        const firstQueryCall = axios.post.mock.calls[1];
        expect(firstQueryCall[0]).toBe(
            `${API_BASE_URL}/customers/${CREDS.customerId}/googleAds:search`
        );
        expect(firstQueryCall[1].query).toContain('segments.date');
        expect(firstQueryCall[1].query).toContain(
            "segments.date BETWEEN '2026-07-26' AND '2026-07-27'"
        );
        expect(firstQueryCall[2].headers).toEqual({
            Authorization: 'Bearer access-private',
            'developer-token': CREDS.developerToken,
            'Content-Type': 'application/json',
        });
        expect(axios.post.mock.calls[2][1]).toEqual({
            query: firstQueryCall[1].query,
            pageToken: 'next-private',
        });
    });

    test('account query accepts USD and rejects non-USD', async () => {
        axios.post.mockResolvedValueOnce({
            data: {
                results: [{
                    customer: {
                        currencyCode: 'USD',
                        timeZone: 'America/New_York',
                    },
                }],
            },
        });
        await expect(fetchAccountMetadata({
            ...CREDS,
            accessToken: 'access-private',
        })).resolves.toEqual({
            currency_code: 'USD',
            account_timezone: 'America/New_York',
        });
        expect(axios.post.mock.calls[0][1].query).toBe(
            'SELECT customer.currency_code, customer.time_zone FROM customer'
        );

        axios.post.mockResolvedValueOnce({
            data: {
                results: [{
                    customer: {
                        currencyCode: 'CAD',
                        timeZone: 'America/Toronto',
                    },
                }],
            },
        });
        await expect(fetchAccountMetadata({
            ...CREDS,
            accessToken: 'access-private',
        })).rejects.toMatchObject({
            code: 'UNSUPPORTED_CURRENCY',
            httpStatus: 422,
        });
    });

    test('invalid server-generated date is rejected before GAQL is sent', async () => {
        await expect(fetchCampaignPerformance({
            ...CREDS,
            accessToken: 'access-private',
            startDate: '2026-02-30',
            endDate: '2026-03-01',
        })).rejects.toMatchObject({ code: 'GOOGLE_ADS_QUERY_FAILED' });
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('provider failures map to sanitized stable errors', async () => {
        axios.post.mockRejectedValueOnce({
            message: 'refresh-secret',
            config: { data: 'client_secret=oauth-secret&refresh_token=refresh-secret' },
            response: { data: { error: 'provider-secret-body' } },
        });
        let refreshError;
        try {
            await refreshAccessToken(CREDS);
        } catch (error) {
            refreshError = error;
        }
        expect(refreshError).toMatchObject({
            code: 'AUTH_REFRESH_FAILED',
            httpStatus: 401,
        });
        expect(JSON.stringify(refreshError)).not.toMatch(
            /refresh-secret|oauth-secret|provider-secret-body/
        );

        axios.post.mockRejectedValueOnce({
            response: {
                status: 403,
                data: { error: { message: 'full-provider-secret' } },
            },
        });
        await expect(executeQuery({
            ...CREDS,
            accessToken: 'access-private',
            query: 'SELECT customer.id FROM customer',
        })).rejects.toMatchObject({
            code: 'ACCOUNT_ACCESS_DENIED',
            httpStatus: 403,
            message: 'Google Ads account access was denied.',
        });

        axios.post.mockRejectedValueOnce({
            response: {
                status: 500,
                data: { error: { message: 'full-provider-secret' } },
            },
        });
        let queryError;
        try {
            await executeQuery({
                ...CREDS,
                accessToken: 'access-private',
                query: 'SELECT customer.id FROM customer',
            });
        } catch (error) {
            queryError = error;
        }
        expect(queryError).toMatchObject({
            code: 'GOOGLE_ADS_QUERY_FAILED',
            message: 'Google Ads could not complete the requested query.',
        });
        expect(JSON.stringify(queryError)).not.toContain('full-provider-secret');
    });
});
