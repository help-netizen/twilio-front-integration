'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const FORWARD_PATH = path.join(MIGRATIONS, '187_list_pagination_cursor_indexes.sql');
const ROLLBACK_PATH = path.join(MIGRATIONS, 'rollback_187_list_pagination_cursor_indexes.sql');

function namesFor(pattern, sql) {
    return [...sql.matchAll(pattern)].map(match => match[1]);
}

describe('migration 187 list pagination cursor indexes', () => {
    const forward = fs.readFileSync(FORWARD_PATH, 'utf8');
    const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');

    const approved = [
        'idx_lpu_leads_company_created_id',
        'idx_lpu_jobs_company_start_id',
        'idx_lpu_jobs_company_created_id',
        'idx_lpu_tasks_company_status_due_created_id',
        'idx_lpu_contacts_company_id',
        'idx_lpu_zb_payments_company_date_id',
    ];

    test('creates exactly the six approved indexes idempotently', () => {
        const names = namesFor(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi, forward);

        expect(names).toEqual(approved);
        expect(forward.match(/CREATE\s+INDEX/gi)).toHaveLength(6);
        expect(forward).not.toMatch(/CREATE\s+(?:TABLE|UNIQUE\s+INDEX)|ALTER\s+TABLE|INSERT\s+INTO|UPDATE\s+/i);
    });

    test('pins table, column, direction, and null-order definitions', () => {
        expect(forward).toMatch(/ON\s+leads\s*\(company_id,\s*created_at\s+DESC,\s*id\s+DESC\)/i);
        expect(forward).toMatch(/ON\s+jobs\s*\(company_id,\s*start_date\s+DESC\s+NULLS\s+LAST,\s*id\s+DESC\)/i);
        expect(forward).toMatch(/ON\s+jobs\s*\(company_id,\s*created_at\s+DESC,\s*id\s+DESC\)/i);
        expect(forward).toMatch(/ON\s+tasks\s*\(company_id,\s*status,\s*due_at\s+ASC\s+NULLS\s+LAST,\s*created_at\s+DESC,\s*id\s+DESC\)/i);
        expect(forward).toMatch(/ON\s+contacts\s*\(company_id,\s*id\s+DESC\)/i);
        expect(forward).toMatch(/ON\s+zb_payments\s*\(company_id,\s*payment_date\s+DESC\s+NULLS\s+LAST,\s*id\s+DESC\)/i);
    });

    test('rollback drops exactly the forward index names idempotently', () => {
        const rollbackNames = namesFor(/DROP\s+INDEX\s+IF\s+EXISTS\s+(\w+)/gi, rollback);

        expect(rollbackNames).toEqual(approved);
        expect(rollback.match(/DROP\s+INDEX/gi)).toHaveLength(6);
        expect(new Set(rollbackNames)).toEqual(new Set(
            namesFor(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi, forward),
        ));
    });
});
