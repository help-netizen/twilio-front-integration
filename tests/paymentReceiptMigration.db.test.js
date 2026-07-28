'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../backend/src/db/connection');

const migration = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '215_payment_receipt_delivery_tracking.sql'),
    'utf8'
);
const rollback = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', 'rollback_215_payment_receipt_delivery_tracking.sql'),
    'utf8'
);

jest.setTimeout(30000);

afterAll(async () => {
    try { await db.pool.end(); } catch { /* already closed */ }
});

test('migration 215 is idempotent and rollback removes only receipt delivery tracking', async () => {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(migration);
        await client.query(migration);

        const columns = await client.query(
            `SELECT column_name
             FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'payment_receipts'
               AND column_name IN ('idempotency_key', 'provider_message_id')
             ORDER BY column_name`
        );
        expect(columns.rows.map(row => row.column_name)).toEqual([
            'idempotency_key',
            'provider_message_id',
        ]);

        const index = await client.query(
            `SELECT indexdef
             FROM pg_indexes
             WHERE schemaname = current_schema()
               AND indexname = 'uq_payment_receipts_transaction_idempotency'`
        );
        expect(index.rows).toHaveLength(1);
        expect(index.rows[0].indexdef).toContain('(transaction_id, idempotency_key)');
        expect(index.rows[0].indexdef).toContain('WHERE (idempotency_key IS NOT NULL)');

        await client.query(rollback);
        await client.query(rollback);
        const afterRollback = await client.query(
            `SELECT column_name
             FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'payment_receipts'
               AND column_name IN ('idempotency_key', 'provider_message_id')`
        );
        expect(afterRollback.rows).toEqual([]);
    } finally {
        await client.query('ROLLBACK');
        client.release();
    }
});
