'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../backend/src/db/connection');

jest.setTimeout(30000);

const FORWARD = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '288_invoice_removal.sql'),
    'utf8'
);
const ROLLBACK = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', 'rollback_288_invoice_removal.sql'),
    'utf8'
);

let client;

afterAll(async () => {
    if (client) {
        try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
    await db.pool.end();
});

test('migration 288 applies and its rollback removes only OB-70 schema', async () => {
    client = await db.pool.connect();
    await client.query('BEGIN');

    await client.query(FORWARD);
    const { rows: applied } = await client.query(
        `SELECT to_regclass('invoice_removals') IS NOT NULL AS has_removals,
                EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'payment_transactions'
                      AND column_name = 'origin_invoice_id'
                ) AS has_origin,
                EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'invoice_removals'
                      AND column_name = 'request_id'
                ) AS has_request_id`
    );
    expect(applied[0]).toEqual({
        has_removals: true,
        has_origin: true,
        has_request_id: true,
    });

    await client.query(ROLLBACK);
    const { rows: rolledBack } = await client.query(
        `SELECT to_regclass('invoice_removals') IS NULL AS removals_gone,
                NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'payment_transactions'
                      AND column_name = 'origin_invoice_id'
                ) AS origin_gone,
                to_regclass('payment_transactions') IS NOT NULL AS payments_preserved`
    );
    expect(rolledBack[0]).toEqual({
        removals_gone: true,
        origin_gone: true,
        payments_preserved: true,
    });
});
