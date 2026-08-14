#!/usr/bin/env node
'use strict';

/**
 * Are the migrations actually applied?
 *
 * `schema_migrations` cannot answer that here: it is legacy, stops at 18, and
 * everything from 083 on is re-runnable and untracked. So the only honest check
 * is to ask the database whether the objects the migrations create are THERE.
 *
 * This reads every migration file, collects the tables, columns and indexes it
 * creates, and reports the ones missing from the connected database. An object a
 * LATER migration drops is not counted as missing — that is the schema doing
 * what it was told.
 *
 * Usage:
 *   node backend/src/cli/verifyMigrationsApplied.js            # everything
 *   node backend/src/cli/verifyMigrationsApplied.js --from=200 # recent only
 *
 * Exit code is 1 when something is missing, so it can gate a deploy.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/connection');

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

function parseArgs(argv) {
    const args = { from: 0 };
    for (const arg of argv) {
        if (arg.startsWith('--from=')) args.from = Number(arg.slice('--from='.length)) || 0;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

/** Objects a later migration removes on purpose — absent by design, not by failure. */
function collectDropped(sources) {
    const dropped = new Set();
    const all = sources.join('\n');
    for (const m of all.matchAll(/DROP\s+(?:INDEX|TABLE)\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) dropped.add(m[1]);
    for (const m of all.matchAll(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) dropped.add(m[1]);
    return dropped;
}

function collectExpected(files, dropped) {
    const expected = [];
    const seen = new Set();
    const add = (migration, kind, name, on = null) => {
        const key = `${kind}:${name}`;
        if (seen.has(key)) return;
        seen.add(key);
        expected.push({ migration, kind, name, ...(on ? { on } : {}) });
    };

    for (const { migration, source } of files) {
        for (const m of source.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
            if (!dropped.has(m[1])) add(migration, 'table', m[1]);
        }
        for (const m of source.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)[\s\S]{0,200}?ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
            if (!dropped.has(m[2])) add(migration, 'column', `${m[1]}.${m[2]}`);
        }
        // An index is recorded with what it indexes. When the column underneath
        // it is later dropped the index goes with it, and reporting that as a
        // failed migration is how a check earns the right to be ignored —
        // uq_provider_bridge_per_company indexes a Zenbooker bridge column that
        // ZB-DECOUPLE removed, and its absence is the schema being correct.
        for (const m of source.matchAll(
            /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+ON\s+(?:ONLY\s+)?([a-z_][a-z0-9_]*)\s*\(\s*([a-z_][a-z0-9_]*)/gi
        )) {
            if (!dropped.has(m[1])) add(migration, 'index', m[1], { table: m[2], column: m[3] });
        }
    }
    return expected;
}

async function isPresent(object) {
    if (object.kind === 'table') {
        const { rows } = await db.query(
            `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
            [object.name]
        );
        return rows.length > 0;
    }
    if (object.kind === 'index') {
        const { rows } = await db.query(
            `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
            [object.name]
        );
        return rows.length > 0;
    }
    const [table, column] = object.name.split('.');
    const { rows } = await db.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, column]
    );
    return rows.length > 0;
}

async function run() {
    const args = parseArgs(process.argv.slice(2));

    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(name => /^\d{3}_.*\.sql$/.test(name) && !name.startsWith('rollback'))
        .sort()
        .map(name => ({
            migration: name.slice(0, 3),
            source: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
        }))
        .filter(file => Number(file.migration) >= args.from);

    const dropped = collectDropped(files.map(file => file.source));
    const expected = collectExpected(files, dropped);

    const missing = [];
    const obsolete = [];
    for (const object of expected) {
        if (await isPresent(object)) continue;
        // Absent because what it indexed is gone? Then it is obsolete, not missing.
        if (object.on && !(await isPresent({ kind: 'column', name: `${object.on.table}.${object.on.column}` }))) {
            obsolete.push({ ...object, reason: `${object.on.table}.${object.on.column} no longer exists` });
            continue;
        }
        missing.push(object);
    }

    console.log(JSON.stringify({
        migrations_scanned: files.length,
        objects_checked: expected.length,
        missing: missing.length,
        obsolete: obsolete.length,
        details: missing,
        ...(obsolete.length ? { obsolete_details: obsolete } : {}),
    }, null, 2));

    return missing.length === 0 ? 0 : 1;
}

if (require.main === module) {
    run()
        .then(code => process.exit(code))
        .catch(err => {
            console.error(`[VerifyMigrations] ${err.message}`);
            process.exit(1);
        });
}

module.exports = { parseArgs, collectDropped, collectExpected };
