'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The reviewed tenant-safety exceptions in technicianServiceAreaQueries and
 * technicianWorkScheduleQueries rest on one fact: every unique key of those
 * tables leads with company_id, so an `ON CONFLICT (company_id, technician_id)
 * DO UPDATE` can only ever reach a row of the company doing the insert.
 *
 * Narrow one of those keys to the technician alone and the exception silently
 * starts covering a genuine cross-tenant write. This reads the migrations
 * rather than a live database so it cannot pass vacuously on a machine whose
 * schema is behind.
 */
const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const TABLES = ['technician_area_wildcards', 'technician_work_schedules'];

function migrationSources() {
    return fs.readdirSync(MIGRATIONS)
        .filter(name => name.endsWith('.sql') && !name.startsWith('rollback_'))
        .map(name => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS, name), 'utf8') }));
}

function uniqueKeyColumnLists(sql, table) {
    const lists = [];
    const unique = new RegExp(
        `CREATE\\s+UNIQUE\\s+INDEX[\\s\\S]*?ON\\s+${table}\\s*\\(([^)]*)\\)`,
        'gi'
    );
    let match;
    while ((match = unique.exec(sql)) !== null) lists.push(match[1]);

    const create = new RegExp(`CREATE\\s+TABLE[^;]*?${table}\\s*\\(([\\s\\S]*?);`, 'i').exec(sql);
    if (create) {
        const primary = /PRIMARY\s+KEY\s*\(([^)]*)\)/gi;
        let key;
        while ((key = primary.exec(create[1])) !== null) lists.push(key[1]);
    }
    return lists;
}

describe('TENANCY: technician upsert keys stay company-scoped', () => {
    test('every unique key declared for the technician upsert tables leads with company_id', () => {
        const sources = migrationSources();
        for (const table of TABLES) {
            const found = [];
            for (const { name, sql } of sources) {
                for (const columns of uniqueKeyColumnLists(sql, table)) {
                    found.push({ name, columns });
                }
            }
            expect(found.length).toBeGreaterThan(0);
            for (const entry of found) {
                const first = entry.columns.split(',')[0].trim().replace(/"/g, '');
                expect(`${table} in ${entry.name}: ${first}`).toBe(`${table} in ${entry.name}: company_id`);
            }
        }
    });
});
