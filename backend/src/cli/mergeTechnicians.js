#!/usr/bin/env node

require('dotenv').config();

const db = require('../db/connection');
const {
    mergeTechnicians,
    TechnicianMergeConflictError,
    DATA_WINS_FAIL,
    DATA_WINS_SURVIVOR,
    DATA_WINS_LOSER,
} = require('../services/technicianMergeService');

function usage() {
    return [
        'Usage:',
        '  node backend/src/cli/mergeTechnicians.js --company-id <uuid> --loser-id <uuid> --survivor-id <uuid> [options]',
        '',
        'Options:',
        '  --display-name <name>              Rename survivor and linked CRM user',
        '  --dry-run, -n                      Preview only (default)',
        '  --apply                            Commit the merge (default is dry-run)',
        '  --data-wins <policy>                fail-closed (default), survivor, or loser',
        '  --survivor-wins                    Alias for --data-wins survivor',
        '  --loser-wins                       Alias for --data-wins loser',
        '  --help                             Show this help',
    ].join('\n');
}

function parseArgs(argv) {
    const args = {
        companyId: null,
        loserId: null,
        survivorId: null,
        displayName: undefined,
        dryRun: true,
        dataWins: DATA_WINS_FAIL,
        help: false,
    };
    const valueOptions = new Map([
        ['--company-id', 'companyId'],
        ['--loser-id', 'loserId'],
        ['--survivor-id', 'survivorId'],
        ['--display-name', 'displayName'],
        ['--data-wins', 'dataWins'],
    ]);
    for (let index = 2; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--apply') args.dryRun = false;
        else if (token === '--dry-run' || token === '-n') args.dryRun = true;
        else if (token === '--survivor-wins') args.dataWins = DATA_WINS_SURVIVOR;
        else if (token === '--loser-wins') args.dataWins = DATA_WINS_LOSER;
        else if (token === '--help' || token === '-h') args.help = true;
        else if (valueOptions.has(token)) {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) {
                throw new Error(`${token} requires a value`);
            }
            args[valueOptions.get(token)] = value;
            index += 1;
        } else if (token.startsWith('--') && token.includes('=')) {
            const [name, ...parts] = token.split('=');
            const field = valueOptions.get(name);
            if (!field) throw new Error(`Unknown option: ${name}`);
            args[field] = parts.join('=');
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
    if (!args.companyId || !args.loserId || !args.survivorId) {
        throw new Error(`company-id, loser-id, and survivor-id are required\n\n${usage()}`);
    }
    const result = await mergeTechnicians(args);
    console.log(JSON.stringify(result, null, 2));
    if (args.dryRun) {
        console.log('[TechnicianMerge] dry-run only; rerun with --apply to commit this plan.');
    }
    return 0;
}

if (require.main === module) {
    main()
        .catch(error => {
            if (error instanceof TechnicianMergeConflictError && error.plan) {
                console.error(JSON.stringify({
                    status: 'blocked',
                    error: error.message,
                    plan: error.plan,
                }, null, 2));
            } else {
                console.error(error.message || error);
            }
            process.exitCode = 1;
        })
        .finally(async () => {
            await db.pool.end().catch(() => {});
        });
}

module.exports = { main, parseArgs, usage };
