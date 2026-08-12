#!/usr/bin/env node

require('dotenv').config();

const db = require('../db/connection');
const {
    canonicalizeJobTechnicianIds,
} = require('../services/jobTechnicianIdCanonicalizationService');

function usage() {
    return [
        'Usage:',
        '  node backend/src/cli/canonicalizeJobTechnicianIds.js --company-id <uuid> [options]',
        '',
        'Options:',
        '  --dry-run, -n   Print before/projected-after inventory (default)',
        '  --apply         Commit the UUID rewrite',
        '  --help          Show this help',
    ].join('\n');
}

function parseArgs(argv) {
    const args = { companyId: null, dryRun: true, help: false };
    for (let index = 2; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--apply') args.dryRun = false;
        else if (token === '--dry-run' || token === '-n') args.dryRun = true;
        else if (token === '--help' || token === '-h') args.help = true;
        else if (token === '--company-id') {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) throw new Error('--company-id requires a value');
            args.companyId = value;
            index += 1;
        } else if (token.startsWith('--company-id=')) {
            args.companyId = token.slice('--company-id='.length);
        } else {
            throw new Error(`Unknown option: ${token}`);
        }
    }
    return args;
}

async function main(argv = process.argv) {
    const args = parseArgs(argv);
    if (args.help) {
        console.log(usage());
        return 0;
    }
    if (!args.companyId) throw new Error(`company-id is required\n\n${usage()}`);
    const result = await canonicalizeJobTechnicianIds(args);
    console.log(JSON.stringify(result, null, 2));
    if (args.dryRun) {
        console.log('[TechnicianIdCanon] dry-run only; rerun with --apply to commit.');
    }
    return 0;
}

if (require.main === module) {
    main()
        .catch(error => {
            console.error(error.message || error);
            process.exitCode = 1;
        })
        .finally(async () => {
            await db.pool.end().catch(() => {});
        });
}

module.exports = { main, parseArgs, usage };
