#!/usr/bin/env node
/**
 * Issue an analytics:read API key for an external reporting consumer.
 * Writes one row into api_integrations with scopes=["analytics:read"].
 *
 * Secret is randomly generated, printed once, and stored as hash(secret+pepper).
 */

const crypto = require('crypto');
const db = require('../src/db/connection');

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const key = argv[i];
        const value = argv[i + 1];
        if (key === '--client')      { args.clientName = value; i++; }
        else if (key === '--company-id') { args.companyId = value; i++; }
        else if (key === '--expires-days') { args.expiresDays = parseInt(value, 10); i++; }
    }
    return args;
}

(async () => {
    const args = parseArgs(process.argv);
    if (!args.clientName) {
        console.error('Usage: --client "<name>" [--company-id <uuid>] [--expires-days <n>]');
        process.exit(1);
    }
    if (!process.env.BLANC_SERVER_PEPPER) {
        console.error('BLANC_SERVER_PEPPER env var is required.');
        process.exit(1);
    }

    const keyId  = 'blanc_ana_' + crypto.randomBytes(12).toString('hex');
    const secret =               crypto.randomBytes(32).toString('base64url');
    const secretHash = crypto
        .createHash('sha256')
        .update(secret + process.env.BLANC_SERVER_PEPPER)
        .digest('hex');

    const expiresAt = args.expiresDays
        ? new Date(Date.now() + args.expiresDays * 86400000).toISOString()
        : null;

    await db.query(
        `INSERT INTO api_integrations (client_name, key_id, secret_hash, scopes, company_id, expires_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [args.clientName, keyId, secretHash, JSON.stringify(['analytics:read']),
         args.companyId || null, expiresAt]
    );

    console.log('─'.repeat(72));
    console.log(' API KEY ISSUED — copy these now, secret will not be shown again:');
    console.log('─'.repeat(72));
    console.log('  X-BLANC-API-KEY    :', keyId);
    console.log('  X-BLANC-API-SECRET :', secret);
    console.log('  Scopes             : analytics:read');
    console.log('  Client             :', args.clientName);
    console.log('  Company id         :', args.companyId || '(none — tenant-wide)');
    console.log('  Expires at         :', expiresAt || '(never)');
    console.log('─'.repeat(72));

    await db.end?.();
    process.exit(0);
})().catch((err) => {
    console.error('Failed to issue key:', err);
    process.exit(1);
});
