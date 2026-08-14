#!/usr/bin/env node

require('dotenv').config();

const db = require('../db/connection');
const { pruneIngestedEmailDrafts } = require('../services/emailDraftPruneService');

function usage() {
    return [
        'Usage:',
        '  node backend/src/cli/pruneIngestedEmailDrafts.js --company-id <uuid> [options]',
        '',
        'Options:',
        '  --dry-run, -n   Classify and report only (default)',
        '  --apply         Mark Gmail 404 rows as reversible draft artifacts',
        '  --limit <N>     Inspect at most N currently unmarked outbound rows (1..100000; default 100)',
        '  --help          Show this help',
    ].join('\n');
}

function parseArgs(argv) {
    const args = { companyId: null, dryRun: true, limit: 100, help: false };
    for (let index = 2; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--apply') args.dryRun = false;
        else if (token === '--dry-run' || token === '-n') args.dryRun = true;
        else if (token === '--help' || token === '-h') args.help = true;
        else if (token === '--company-id' || token === '--limit') {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
            if (token === '--company-id') args.companyId = value;
            else args.limit = Number(value);
            index += 1;
        } else if (token.startsWith('--company-id=')) {
            args.companyId = token.slice('--company-id='.length);
        } else if (token.startsWith('--limit=')) {
            args.limit = Number(token.slice('--limit='.length));
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

    const result = await pruneIngestedEmailDrafts(args);
    console.log(JSON.stringify(result, null, 2));
    if (args.dryRun) {
        console.log('[EmailDraftPrune] dry-run only; rerun with --apply to mark candidates.');
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
