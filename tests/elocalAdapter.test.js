'use strict';

const {
    ElocalAdapterError,
    fetchCampaignResults,
} = require('../backend/src/services/elocalAdapter');

const CAMPAIGN_A = '3ffa28e6-f186-4301-abd6-5ec39d6e866b';
const CAMPAIGN_B = '24e83932-12ce-4b13-9066-846f99f76c19';

function providerCall(overrides = {}) {
    return {
        call_id: 'shared-call',
        caller_phone_number: '+1 (617) 555-0101',
        cost: '65.25',
        call_date_time: '2026-08-10T14:00:00.000Z',
        supply_event_status: 'BILLABLE',
        supply_event_status_reason: 'qualified',
        service_zip_code: '02108',
        service_city: 'Boston',
        service_state_abbr: 'MA',
        campaign_name: 'Boston - CALL',
        category_name: 'Plumbing',
        call_duration_in_seconds: 90,
        call_quality_tags: ['answered'],
        forwarding_number: '+16175550199',
        external_campaign_id: 'campaign-external',
        lead_source_id: 'source-external',
        ...overrides,
    };
}

describe('eLocal adapter', () => {
    test('uses X-API-Key, explicit dates, fetches web leads, and dedups campaigns by call_id', async () => {
        const httpClient = {
            get: jest.fn(async (url) => {
                if (url.endsWith('/calls.json')) {
                    return { data: { calls: [providerCall()] } };
                }
                return { data: { web_leads: [] } };
            }),
        };

        const result = await fetchCampaignResults({
            campaignIds: [CAMPAIGN_A, CAMPAIGN_B, CAMPAIGN_A],
            apiKey: 'private-api-key',
            startDate: '2026-05-14',
            endDate: '2026-08-11',
            httpClient,
        });

        expect(result.calls).toHaveLength(1);
        expect(result.webLeads).toEqual([]);
        expect(result.calls[0]).toMatchObject({
            external_call_id: 'shared-call',
            caller_phone_e164: '+16175550101',
            normalized_phone: '6175550101',
            cost_cents: 6525,
            supply_event_status: 'BILLABLE',
            billable: true,
        });
        expect(httpClient.get).toHaveBeenCalledTimes(4);
        for (const [, options] of httpClient.get.mock.calls) {
            expect(options).toMatchObject({
                headers: { 'X-API-Key': 'private-api-key' },
                params: {
                    start_date: '2026-05-14',
                    end_date: '2026-08-11',
                },
            });
            expect(options.headers).not.toHaveProperty('Authorization');
        }
    });

    test('stores UNBILLABLE calls for audit without marking them billable', async () => {
        const httpClient = {
            get: jest.fn(async (url) => (
                url.endsWith('/calls.json')
                    ? {
                        data: {
                            calls: [providerCall({
                                call_id: 'refunded-call',
                                supply_event_status: 'UNBILLABLE',
                                cost: 40,
                            })],
                        },
                    }
                    : { data: { web_leads: [] } }
            )),
        };

        const result = await fetchCampaignResults({
            campaignIds: [CAMPAIGN_A],
            apiKey: 'private-api-key',
            startDate: '2026-08-01',
            endDate: '2026-08-11',
            httpClient,
        });

        expect(result.calls[0]).toMatchObject({
            cost_cents: 4000,
            supply_event_status: 'UNBILLABLE',
            billable: false,
        });
    });

    test('provider failures expose no API key or caller phone', async () => {
        const httpClient = {
            get: jest.fn().mockRejectedValue(Object.assign(
                new Error('private-api-key +16175550101'),
                { response: { status: 403 } }
            )),
        };

        await expect(fetchCampaignResults({
            campaignIds: [CAMPAIGN_A],
            apiKey: 'private-api-key',
            startDate: '2026-08-01',
            endDate: '2026-08-11',
            httpClient,
        })).rejects.toEqual(expect.objectContaining({
            code: 'ELOCAL_ACCESS_DENIED',
            message: 'eLocal API access was denied.',
        }));
        await expect(fetchCampaignResults({
            campaignIds: [CAMPAIGN_A],
            apiKey: 'private-api-key',
            startDate: '2026-08-12',
            endDate: '2026-08-11',
            httpClient,
        })).rejects.toBeInstanceOf(ElocalAdapterError);
    });
});
