#!/usr/bin/env node
'use strict';

const db = require('../src/db/connection');
const provisioning = require('../src/services/vapiAgencyProvisioningService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class VapiAgencyCliError extends Error {
    constructor(code) {
        super(code);
        this.name = 'VapiAgencyCliError';
        this.code = code;
    }
}

function parseArgs(argv) {
    const args = { apply: false, adoptExisting: false };
    let explicitDryRun = false;
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--company-id') {
            args.companyId = argv[index + 1];
            index += 1;
        } else if (token.startsWith('--company-id=')) {
            args.companyId = token.slice('--company-id='.length);
        } else if (token === '--greeting') {
            args.greeting = argv[index + 1];
            index += 1;
        } else if (token.startsWith('--greeting=')) {
            args.greeting = token.slice('--greeting='.length);
        } else if (token === '--apply') {
            args.apply = true;
        } else if (token === '--adopt-existing') {
            args.adoptExisting = true;
        } else if (token === '--dry-run') {
            explicitDryRun = true;
        } else {
            throw new VapiAgencyCliError('VAPI_AGENCY_CLI_ARGUMENT_FORBIDDEN');
        }
    }
    if (!args.companyId || !UUID_RE.test(args.companyId)) {
        throw new VapiAgencyCliError('VAPI_AGENCY_CLI_COMPANY_ID_REQUIRED');
    }
    if (args.apply && explicitDryRun) {
        throw new VapiAgencyCliError('VAPI_AGENCY_CLI_MODE_CONFLICT');
    }
    if (args.greeting !== undefined && typeof args.greeting !== 'string') {
        throw new VapiAgencyCliError('VAPI_AGENCY_CLI_GREETING_INVALID');
    }
    return args;
}

async function run(argv = process.argv.slice(2), dependencies = {}) {
    const args = parseArgs(argv);
    const result = await (dependencies.provisionCompany || provisioning.provisionCompany)(args, {
        environment: dependencies.environment || process.env,
        ...(dependencies.serviceDependencies || {}),
    });
    (dependencies.log || console.log)(JSON.stringify(result, null, 2));
    return result;
}

if (require.main === module) {
    run()
        .catch((error) => {
            const differingFields = Array.isArray(error?.details?.differingFields)
                ? ` differing_fields=${error.details.differingFields.join(',')}`
                : '';
            console.error(
                'Vapi agency company provisioning failed:',
                `${error?.code || 'UNKNOWN'}${differingFields}`,
            );
            process.exitCode = 1;
        })
        .finally(() => db.pool.end().catch(() => {}));
}

module.exports = {
    VapiAgencyCliError,
    parseArgs,
    run,
};
