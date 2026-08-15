#!/usr/bin/env node
'use strict';

const db = require('../src/db/connection');
const machineCredentials = require('../src/services/machineCredentialService');

function parseArgs(argv) {
    const args = { scopes: [] };
    for (let i = 0; i < argv.length; i++) {
        const value = argv[i + 1];
        if (argv[i] === '--company-id') { args.companyId = value; i++; }
        else if (argv[i] === '--surface') { args.surface = value; i++; }
        else if (argv[i] === '--scope') { args.scopes.push(value); i++; }
        else if (argv[i] === '--actor-user-id') { args.actorUserId = value; i++; }
        else if (argv[i] === '--secret-env') { args.secretEnv = value; i++; }
        else throw new Error(`Unknown argument: ${argv[i]}`);
    }
    if (!args.companyId) throw new Error('--company-id is required');
    if (!args.surface) throw new Error('--surface is required');
    if (!args.secretEnv) throw new Error('--secret-env is required');
    if (args.scopes.length === 0) throw new Error('At least one --scope is required');
    return args;
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const secret = process.env[args.secretEnv];
    if (!secret) throw new Error('The selected secret environment variable is not set');
    const result = await machineCredentials.provisionCredential({
        companyId: args.companyId,
        surface: args.surface,
        actorUserId: args.actorUserId || null,
        scopes: args.scopes,
        secret,
    });
    console.log(JSON.stringify({
        credential_id: result.id,
        company_id: result.companyId,
        surface: result.surface,
        created: result.created,
    }));
}

if (require.main === module) {
    main()
        .catch(error => {
            console.error('Machine credential provisioning failed:', error?.code || error?.name || 'UNKNOWN');
            process.exitCode = 1;
        })
        .finally(() => db.pool.end().catch(() => {}));
}

module.exports = { parseArgs, main };
