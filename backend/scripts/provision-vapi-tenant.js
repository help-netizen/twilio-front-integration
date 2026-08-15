#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const db = require('../src/db/connection');
const vapiOrgProvisioningService = require('../src/services/vapiOrgProvisioningService');

function parseArgs(argv) {
    const args = { environment: 'prod' };
    for (let i = 0; i < argv.length; i++) {
        const value = argv[i + 1];
        if (argv[i] === '--company-id') { args.companyId = value; i++; }
        else if (argv[i] === '--environment') { args.environment = value; i++; }
        else if (argv[i] === '--tools-secret-env') { args.toolsSecretEnv = value; i++; }
        else if (argv[i] === '--secret-output-file') { args.secretOutputFile = value; i++; }
        else throw new Error(`Unknown argument: ${argv[i]}`);
    }
    if (!args.companyId) throw new Error('--company-id is required');
    if (args.toolsSecretEnv && args.secretOutputFile) {
        throw new Error('Use only one of --tools-secret-env or --secret-output-file');
    }
    if (!args.toolsSecretEnv && !args.secretOutputFile) {
        throw new Error('--tools-secret-env or --secret-output-file is required');
    }
    return args;
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.secretOutputFile) {
        await fs.access(args.secretOutputFile)
            .then(() => { throw new Error('Secret output file already exists'); })
            .catch(error => {
                if (error.code !== 'ENOENT') throw error;
            });
    }
    const toolsSecret = args.toolsSecretEnv ? process.env[args.toolsSecretEnv] : null;
    if (args.toolsSecretEnv && !toolsSecret) {
        throw new Error('The selected tools secret environment variable is not set');
    }

    const result = await vapiOrgProvisioningService.provision({
        companyId: args.companyId,
        environment: args.environment,
        toolsSecret,
    });
    let secretWritten = false;
    if (result.credential.secret) {
        if (args.secretOutputFile) {
            await fs.writeFile(args.secretOutputFile, result.credential.secret, {
                encoding: 'utf8',
                mode: 0o600,
                flag: 'wx',
            });
            secretWritten = true;
        } else if (!args.toolsSecretEnv) {
            throw new Error('Generated credential has no secure output target');
        }
    }
    console.log(JSON.stringify({
        company_id: result.companyId,
        environment: result.environment,
        connection_id: result.connectionId,
        provider_org_id: result.providerOrgId,
        organization_created: result.organizationCreated,
        credential_id: result.credential.id,
        credential_created: result.credential.created,
        secret_written: secretWritten,
    }));
}

if (require.main === module) {
    main()
        .catch(error => {
            console.error('Vapi tenant provisioning failed:', error?.code || error?.name || 'UNKNOWN');
            process.exitCode = 1;
        })
        .finally(() => db.pool.end().catch(() => {}));
}

module.exports = { parseArgs, main };
