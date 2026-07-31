'use strict';

jest.mock('../backend/src/db/marketplaceQueries', () => ({
    ensureMarketplaceSchema: jest.fn().mockResolvedValue(undefined),
}));

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const paymentsQueries = require('../backend/src/db/paymentsQueries');
const stripePaymentsQueries = require('../backend/src/db/stripePaymentsQueries');

jest.setTimeout(30000);

afterAll(async () => {
    try { await db.pool.end(); } catch { /* already closed */ }
});

test('RECEIPT-TENANCY-DB: detail/history/claim/complete/release isolate two tenants', async () => {
    const client = await db.pool.connect();
    const companyA = randomUUID();
    const companyB = randomUUID();
    const userA = randomUUID();
    try {
        await client.query('BEGIN');
        await client.query(`
            CREATE TEMP TABLE companies (
                id UUID PRIMARY KEY,
                timezone TEXT
            ) ON COMMIT DROP;
            CREATE TEMP TABLE crm_users (
                id UUID PRIMARY KEY,
                full_name TEXT,
                email TEXT
            ) ON COMMIT DROP;
            CREATE TEMP TABLE company_memberships (
                company_id UUID NOT NULL,
                user_id UUID NOT NULL,
                UNIQUE (company_id, user_id)
            ) ON COMMIT DROP;
            CREATE TEMP TABLE contacts (
                id BIGINT PRIMARY KEY,
                company_id UUID NOT NULL,
                email TEXT,
                full_name TEXT
            ) ON COMMIT DROP;
            CREATE TEMP TABLE jobs (
                id BIGINT PRIMARY KEY,
                company_id UUID NOT NULL,
                contact_id BIGINT,
                customer_email TEXT,
                customer_name TEXT,
                territory TEXT,
                city TEXT,
                job_number TEXT,
                service_name TEXT
            ) ON COMMIT DROP;
            CREATE TEMP TABLE invoices (
                id BIGINT PRIMARY KEY,
                company_id UUID NOT NULL,
                contact_id BIGINT,
                job_id BIGINT,
                invoice_number TEXT,
                -- Mirrors the real table: the receipt context picks a job's newest
                -- non-void invoice when the payment carries none (RECEIPT-INVOICE-PDF-001).
                status TEXT NOT NULL DEFAULT 'sent',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            ) ON COMMIT DROP;
            CREATE TEMP TABLE stripe_connected_accounts (
                company_id UUID PRIMARY KEY,
                stripe_account_id TEXT,
                livemode BOOLEAN
            ) ON COMMIT DROP;
            CREATE TEMP TABLE stripe_payment_sessions (
                id BIGINT PRIMARY KEY,
                company_id UUID NOT NULL,
                contact_id BIGINT,
                invoice_id BIGINT,
                job_id BIGINT,
                stripe_payment_intent_id TEXT,
                stripe_charge_id TEXT,
                stripe_checkout_session_id TEXT,
                stripe_account_id TEXT,
                created_by UUID,
                surface TEXT,
                created_at TIMESTAMPTZ
            ) ON COMMIT DROP;
            CREATE TEMP TABLE payment_transactions (
                id BIGINT PRIMARY KEY,
                company_id UUID NOT NULL,
                contact_id BIGINT,
                estimate_id BIGINT,
                invoice_id BIGINT,
                job_id BIGINT,
                transaction_type TEXT NOT NULL,
                payment_method TEXT NOT NULL,
                status TEXT NOT NULL,
                amount NUMERIC(12,2) NOT NULL,
                currency TEXT NOT NULL,
                reference_number TEXT,
                external_id TEXT,
                external_source TEXT,
                memo TEXT,
                metadata JSONB NOT NULL DEFAULT '{}',
                processed_at TIMESTAMPTZ,
                recorded_by UUID,
                created_at TIMESTAMPTZ NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL,
                voided_at TIMESTAMPTZ,
                voided_by UUID,
                void_reason TEXT
            ) ON COMMIT DROP;
            CREATE TEMP TABLE payment_receipts (
                id BIGSERIAL PRIMARY KEY,
                transaction_id BIGINT NOT NULL,
                receipt_number TEXT NOT NULL,
                sent_to_email TEXT,
                sent_to_phone TEXT,
                sent_via TEXT,
                pdf_storage_key TEXT,
                sent_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                idempotency_key TEXT,
                provider_message_id TEXT
            ) ON COMMIT DROP;
            CREATE UNIQUE INDEX temp_receipt_idempotency
                ON payment_receipts (transaction_id, idempotency_key)
                WHERE idempotency_key IS NOT NULL;
        `);
        await client.query(
            `INSERT INTO companies (id, timezone) VALUES
                ($1, 'America/New_York'), ($2, 'America/Chicago')`,
            [companyA, companyB]
        );
        await client.query(
            `INSERT INTO crm_users (id, full_name, email)
                VALUES ($1, 'Operator A', 'operator@example.com')`,
            [userA]
        );
        await client.query(
            `INSERT INTO company_memberships (company_id, user_id) VALUES ($1, $2)`,
            [companyA, userA]
        );
        await client.query(
            `INSERT INTO contacts (id, company_id, email, full_name) VALUES
                (11, $1, 'same@example.com', 'Customer A'),
                (22, $2, 'same@example.com', 'Customer B')`,
            [companyA, companyB]
        );
        await client.query(
            `INSERT INTO jobs (
                id, company_id, contact_id, customer_email, customer_name,
                territory, city, job_number, service_name
             ) VALUES
                (111, $1, 11, 'same@example.com', 'Customer A', 'A Territory', 'A City', 'JOB-A', 'Repair A'),
                (222, $2, 22, 'same@example.com', 'Customer B', 'B Territory', 'B City', 'JOB-B', 'Repair B')`,
            [companyA, companyB]
        );
        await client.query(
            `INSERT INTO stripe_connected_accounts (company_id, stripe_account_id, livemode) VALUES
                ($1, 'acct_a', false), ($2, 'acct_b', true)`,
            [companyA, companyB]
        );
        await client.query(
            `INSERT INTO stripe_payment_sessions (
                id, company_id, contact_id, job_id, stripe_payment_intent_id,
                stripe_charge_id, stripe_account_id, created_by, surface, created_at
             ) VALUES
                (1001, $1, 11, 111, 'pi_same', 'ch_a', 'acct_a', $3, 'manual_card', NOW()),
                (1002, $2, 22, 222, 'pi_same', 'ch_b', 'acct_b', NULL, 'checkout_link', NOW())`,
            [companyA, companyB, userA]
        );
        await client.query(
            `INSERT INTO payment_transactions (
                id, company_id, contact_id, job_id, transaction_type,
                payment_method, status, amount, currency, external_id,
                external_source, memo, metadata, processed_at, created_at, updated_at
             ) VALUES
                (71, $1, 11, 111, 'payment', 'credit_card', 'completed', 95, 'USD',
                 'pi_same', 'stripe', 'A memo', '{}', NOW(), NOW(), NOW()),
                (72, $2, 22, 222, 'payment', 'credit_card', 'completed', 95, 'USD',
                 'pi_same', 'stripe', 'B memo', '{}', NOW(), NOW(), NOW())`,
            [companyA, companyB]
        );
        await client.query(
            `INSERT INTO payment_receipts (
                transaction_id, receipt_number, sent_to_email, sent_via,
                sent_at, idempotency_key, provider_message_id
             ) VALUES
                (72, 'REC-B-SENT', 'same@example.com', 'email', NOW(), 'shared-key', 'gmail-b'),
                (72, 'REC-B-PENDING', 'same@example.com', 'email', NULL, 'pending-b', NULL)`
        );

        const own = await paymentsQueries.getTransactionReceiptContext(companyA, 71, client);
        expect(own).toMatchObject({
            id: '71',
            company_id: companyA,
            customer_name: 'Customer A',
            created_by_name: 'Operator A',
            territory: 'A Territory',
            stripe_payment_id: 'ch_a',
        });
        await expect(paymentsQueries.getTransactionReceiptContext(companyA, 72, client))
            .resolves.toBeNull();
        await expect(paymentsQueries.getTransactionReceiptContext(companyB, 72, client))
            .resolves.toMatchObject({
                company_id: companyB,
                customer_name: 'Customer B',
                created_by_name: 'Customer (online)',
                territory: 'B Territory',
            });
        await expect(stripePaymentsQueries.getSessionById(companyA, 1002, client))
            .resolves.toBeNull();
        await expect(stripePaymentsQueries.getSessionById(companyB, 1002, client))
            .resolves.toMatchObject({ company_id: companyB, stripe_payment_intent_id: 'pi_same' });

        const foreignHistory = await paymentsQueries.listReceiptHistory(companyA, 72, client);
        expect(foreignHistory).toEqual([]);
        const companyBHistoryBefore = await paymentsQueries.listReceiptHistory(companyB, 72, client);
        expect(companyBHistoryBefore).toHaveLength(1);
        expect(companyBHistoryBefore[0]).toMatchObject({
            to: 'same@example.com',
            channel: 'email',
        });

        const foreignClaim = await paymentsQueries.claimReceiptDelivery(
            companyA,
            72,
            {
                receiptNumber: 'REC-FOREIGN',
                idempotencyKey: 'shared-key',
                email: 'same@example.com',
            },
            client
        );
        expect(foreignClaim).toEqual({ receipt: null, claimed: false });

        const ownClaim = await paymentsQueries.claimReceiptDelivery(
            companyA,
            71,
            {
                receiptNumber: 'REC-A',
                idempotencyKey: 'shared-key',
                email: 'same@example.com',
            },
            client
        );
        expect(ownClaim.claimed).toBe(true);
        const completed = await paymentsQueries.completeReceiptDelivery(
            companyA,
            ownClaim.receipt.id,
            'gmail-a',
            client
        );
        expect(completed).toMatchObject({
            transaction_id: '71',
            provider_message_id: 'gmail-a',
        });
        expect(completed.sent_at).toBeTruthy();

        const pendingB = await client.query(
            `SELECT id FROM payment_receipts
             WHERE transaction_id = 72 AND idempotency_key = 'pending-b'`
        );
        await expect(paymentsQueries.releaseReceiptDelivery(
            companyA,
            pendingB.rows[0].id,
            client
        )).resolves.toBe(false);
        const companyBRowsAfter = await client.query(
            `SELECT receipt_number, sent_at, provider_message_id
             FROM payment_receipts
             WHERE transaction_id = 72
             ORDER BY receipt_number`
        );
        expect(companyBRowsAfter.rows).toHaveLength(2);
        expect(companyBRowsAfter.rows).toEqual(expect.arrayContaining([
            expect.objectContaining({
                receipt_number: 'REC-B-SENT',
                provider_message_id: 'gmail-b',
            }),
            expect.objectContaining({
                receipt_number: 'REC-B-PENDING',
                sent_at: null,
            }),
        ]));
    } finally {
        await client.query('ROLLBACK');
        client.release();
    }
});
