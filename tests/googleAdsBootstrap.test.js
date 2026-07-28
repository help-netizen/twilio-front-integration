'use strict';

const {
    run,
} = require('../backend/src/cli/bootstrapGoogleAds');

const ENVIRONMENT = {
    GOOGLE_ADS_BOOTSTRAP_COMPANY_ID: '11111111-1111-1111-1111-111111111111',
    GOOGLE_ADS_BOOTSTRAP_CUSTOMER_ID: '123-456-7890',
    GOOGLE_ADS_BOOTSTRAP_REFRESH_TOKEN: 'bootstrap-refresh-private',
};

describe('Google Ads one-shot bootstrap CLI', () => {
    test('reads the three bootstrap values, delegates once, and prints no identifiers or secrets', async () => {
        const service = {
            connectCompany: jest.fn().mockResolvedValue({
                connected: true,
                status: 'connected',
            }),
        };
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            await expect(run(ENVIRONMENT, { service })).resolves.toMatchObject({
                connected: true,
                status: 'connected',
            });
            expect(service.connectCompany).toHaveBeenCalledWith({
                companyId: ENVIRONMENT.GOOGLE_ADS_BOOTSTRAP_COMPANY_ID,
                customerId: ENVIRONMENT.GOOGLE_ADS_BOOTSTRAP_CUSTOMER_ID,
                refreshToken: ENVIRONMENT.GOOGLE_ADS_BOOTSTRAP_REFRESH_TOKEN,
                actorId: null,
            });
            const output = JSON.stringify(log.mock.calls);
            expect(output).toContain('completed successfully');
            expect(output).not.toContain(
                ENVIRONMENT.GOOGLE_ADS_BOOTSTRAP_COMPANY_ID
            );
            expect(output).not.toContain(
                ENVIRONMENT.GOOGLE_ADS_BOOTSTRAP_CUSTOMER_ID
            );
            expect(output).not.toContain(
                ENVIRONMENT.GOOGLE_ADS_BOOTSTRAP_REFRESH_TOKEN
            );
        } finally {
            log.mockRestore();
        }
    });

    test('fails before service work when bootstrap environment is incomplete', async () => {
        const service = { connectCompany: jest.fn() };

        await expect(run({}, { service })).rejects.toMatchObject({
            code: 'GOOGLE_ADS_BOOTSTRAP_ENV_MISSING',
        });
        expect(service.connectCompany).not.toHaveBeenCalled();
    });
});
