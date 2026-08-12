#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../backend/src/db/connection');
const { PAYMENT_LEDGER_ROWS_SQL } = require('../backend/src/services/paymentLedgerService');

const ROOT = path.join(__dirname, '..');
const BEFORE_SQL = fs.readFileSync(
    path.join(__dirname, 'sql', 'pay-dezb-001-before.sql'),
    'utf8'
);
const MIGRATION_SQL = fs.readFileSync(
    path.join(ROOT, 'backend', 'db', 'migrations', '254_payment_legacy_snapshot.sql'),
    'utf8'
);

function stableValue(value) {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value).sort().map(key => [key, stableValue(value[key])])
        );
    }
    return value;
}

function comparableRow(row) {
    const { attachments: _attachments, ...rest } = row;
    void _attachments;
    return stableValue(rest);
}

function compareRows(beforeRows, afterRows) {
    const before = new Map(beforeRows.map(row => [String(row.id), comparableRow(row)]));
    const after = new Map(afterRows.map(row => [String(row.id), comparableRow(row)]));
    const ids = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => (
        BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0
    ));
    const mismatches = [];

    for (const id of ids) {
        const beforeRow = before.get(id);
        const afterRow = after.get(id);
        if (JSON.stringify(beforeRow) !== JSON.stringify(afterRow)) {
            mismatches.push({ id, before: beforeRow ?? null, after: afterRow ?? null });
        }
    }

    return {
        ok: mismatches.length === 0 && before.size === beforeRows.length && after.size === afterRows.length,
        before_count: beforeRows.length,
        after_count: afterRows.length,
        mismatches,
    };
}

async function captureRows(client, ledgerSql, companyId) {
    const { rows } = await client.query(
        `WITH ledger_rows AS (
            ${ledgerSql}
         )
         SELECT p.*
         FROM ledger_rows p
         WHERE p.company_id = $1
           AND p.external_source = 'zenbooker'
         ORDER BY p.id`,
        [companyId]
    );
    return rows;
}

async function runComparison({ companyId, outputDir, migrationSql = MIGRATION_SQL }) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const beforeRows = await captureRows(client, BEFORE_SQL, companyId);
        await client.query(migrationSql);
        const afterRows = await captureRows(client, PAYMENT_LEDGER_ROWS_SQL, companyId);
        const comparison = compareRows(beforeRows, afterRows);

        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, 'before.json'), `${JSON.stringify(stableValue(beforeRows), null, 2)}\n`);
        fs.writeFileSync(path.join(outputDir, 'after.json'), `${JSON.stringify(stableValue(afterRows), null, 2)}\n`);
        fs.writeFileSync(path.join(outputDir, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
        await client.query('ROLLBACK');
        return comparison;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

function parseArgs(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--company-id') result.companyId = argv[++index];
        else if (argument === '--output-dir') result.outputDir = argv[++index];
        else throw new Error(`Unknown argument: ${argument}`);
    }
    if (!result.companyId) throw new Error('--company-id is required');
    if (!result.outputDir) throw new Error('--output-dir is required');
    return result;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const result = await runComparison(args);
    if (!result.ok) {
        console.error(`PAY-DEZB-001 mismatch: ${result.mismatches.length} of ${result.before_count} rows differ`);
        process.exitCode = 1;
        return;
    }
    console.log(`PAY-DEZB-001 match: ${result.before_count} historical rows`);
}

if (require.main === module) {
    main()
        .catch(error => {
            console.error(error);
            process.exitCode = 1;
        })
        .finally(() => db.pool.end());
}

module.exports = {
    BEFORE_SQL,
    MIGRATION_SQL,
    comparableRow,
    compareRows,
    captureRows,
    runComparison,
};
