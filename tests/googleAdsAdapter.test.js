'use strict';

jest.mock('axios', () => ({ post: jest.fn() }));

const axios = require('axios');
const {
    API_BASE_URL,
    TOKEN_URL,
    executeQuery,
    fetchAccountMetadata,
    fetchCampaignPerformance,
    fetchLocalServicesLeads,
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

    test('LSA query maps single-object phone details, pagination, and local timestamps', async () => {
        axios.post
            .mockResolvedValueOnce({
                data: {
                    results: [{
                        localServicesLead: {
                            resourceName: 'customers/1234567890/localServicesLeads/lead-1',
                            leadType: 'PHONE_CALL',
                            contactDetails: { phoneNumber: '(617) 555-0101' },
                            leadStatus: 'ACTIVE',
                            creationDateTime: '2026-08-10 09:30:15.123456',
                            leadCharged: true,
                        },
                    }],
                    nextPageToken: 'lsa-page-2',
                },
            })
            .mockResolvedValueOnce({
                data: {
                    results: [{
                        localServicesLead: {
                            resourceName: 'customers/1234567890/localServicesLeads/lead-2',
                            leadType: 'MESSAGE',
                            contactDetails: {},
                            leadStatus: 'NEW',
                            creationDateTime: '2026-08-10 10:00:00',
                            leadCharged: false,
                        },
                    }],
                },
            });

        await expect(fetchLocalServicesLeads({
            ...CREDS,
            accessToken: 'access-private',
            accountTimezone: 'America/New_York',
        })).resolves.toEqual([
            {
                external_account_id: '1234567890',
                external_lead_id: 'lead-1',
                resource_name: 'customers/1234567890/localServicesLeads/lead-1',
                lead_type: 'PHONE_CALL',
                phone_e164: '+16175550101',
                normalized_phone: '6175550101',
                provider_created_at: new Date('2026-08-10T13:30:15.123Z'),
                provider_creation_date_time: '2026-08-10 09:30:15.123456',
                lead_charged: true,
                lead_status: 'ACTIVE',
            },
            {
                external_account_id: '1234567890',
                external_lead_id: 'lead-2',
                resource_name: 'customers/1234567890/localServicesLeads/lead-2',
                lead_type: 'MESSAGE',
                phone_e164: null,
                normalized_phone: null,
                provider_created_at: new Date('2026-08-10T14:00:00.000Z'),
                provider_creation_date_time: '2026-08-10 10:00:00',
                lead_charged: false,
                lead_status: 'NEW',
            },
        ]);

        const query = axios.post.mock.calls[0][1].query;
        expect(query).toContain('local_services_lead.contact_details');
        expect(query).toContain('local_services_lead.lead_charged');
        expect(axios.post.mock.calls[1][1]).toEqual({
            query,
            pageToken: 'lsa-page-2',
        });
    });

    test('LSA query rejects a nonexistent local timestamp without exposing payload data', async () => {
        axios.post.mockResolvedValueOnce({
            data: {
                results: [{
                    localServicesLead: {
                        resourceName: 'customers/1234567890/localServicesLeads/private-id',
                        leadType: 'PHONE_CALL',
                        contactDetails: { phoneNumber: '+16175559999' },
                        creationDateTime: '2026-03-08 02:30:00',
                    },
                }],
            },
        });

        let error;
        try {
            await fetchLocalServicesLeads({
                ...CREDS,
                accessToken: 'access-private',
                accountTimezone: 'America/New_York',
            });
        } catch (caught) {
            error = caught;
        }
        expect(error).toMatchObject({
            code: 'GOOGLE_ADS_QUERY_FAILED',
            message: 'Google Ads returned an invalid Local Services Ads creation time.',
        });
        expect(JSON.stringify(error)).not.toMatch(/private-id|6175559999/);
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
