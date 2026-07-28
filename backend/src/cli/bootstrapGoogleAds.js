'use strict';

const db = require('../db/connection');
const googleAdsConnectionService = require('../services/googleAdsConnectionService');

const REQUIRED_ENV = [
    'GOOGLE_ADS_BOOTSTRAP_COMPANY_ID',
    'GOOGLE_ADS_BOOTSTRAP_CUSTOMER_ID',
    'GOOGLE_ADS_BOOTSTRAP_REFRESH_TOKEN',
];

async function run(environment = process.env, dependencies = {}) {
    const missing = REQUIRED_ENV.filter(key => !environment[key]);
    if (missing.length > 0) {
        const error = new Error(`Missing required environment: ${missing.join(', ')}`);
        error.code = 'GOOGLE_ADS_BOOTSTRAP_ENV_MISSING';
        throw error;
    }
    const service = dependencies.service || googleAdsConnectionService;
    const result = await service.connectCompany({
        companyId: environment.GOOGLE_ADS_BOOTSTRAP_COMPANY_ID,
        customerId: environment.GOOGLE_ADS_BOOTSTRAP_CUSTOMER_ID,
        refreshToken: environment.GOOGLE_ADS_BOOTSTRAP_REFRESH_TOKEN,
        actorId: null,
    });
    console.log('Google Ads bootstrap completed successfully.');
    return result;
}

if (require.main === module) {
    run()
        .catch((error) => {
            console.error(`Google Ads bootstrap failed. code=${error.code || 'BOOTSTRAP_FAILED'}`);
            process.exitCode = 1;
        })
        .finally(async () => {
            await db.pool.end();
        });
}

module.exports = { REQUIRED_ENV, run };
