'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

jest.mock('../backend/src/db/stripePaymentsQueries');
jest.mock('../backend/src/db/paymentsQueries');
jest.mock('../backend/src/db/jobFinanceQueries');
jest.mock('../backend/src/services/paymentsService');
jest.mock('../backend/src/services/invoicesService');
jest.mock('../backend/src/db/invoicesQueries');
jest.mock('../backend/src/db/estimatesQueries');
jest.mock('../backend/src/services/stripeConnectProvider');
jest.mock('../backend/src/services/jobsService');
jest.mock('../backend/src/services/marketplaceService');
jest.mock('../backend/src/db/marketplaceQueries', () => ({
    ensureMarketplaceSchema: jest.fn().mockResolvedValue(undefined),
    listInstallations: jest.fn().mockResolvedValue([]),
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../backend/src/services/eventBus', () => ({
    emit: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../backend/src/db/connection');
const q = require('../backend/src/db/stripePaymentsQueries');
const savedCardsQueries = require('../backend/src/db/stripeSavedCardsQueries');
const jobFinanceQueries = require('../backend/src/db/jobFinanceQueries');
const jobsService = require('../backend/src/services/jobsService');
const provider = require('../backend/src/services/stripeConnectProvider');
const service = require('../backend/src/services/stripePaymentsService');

jest.setTimeout(60000);

const MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '229_card_on_file.sql'),
    'utf8'
);
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const ACCOUNT_A = `acct_ttl_a_${process.pid}`;
const ACCOUNT_B = `acct_ttl_b_${process.pid}`;
const ACTOR = { id: randomUUID() };
const REQUEST_KEY = randomUUID();
const TAG = `card-ttl-${Date.now()}-${process.pid}`;

let client;
let originalQuery;
let contactA;
let contactB;
let expiredCardA;
let freshCardA;
let freshCardB;

beforeAll(async () => {
    client = await db.pool.connect();
    await client.query('BEGIN');
    originalQuery = db.query;
    db.query = (text, params) => client.query(text, params);

    // Production reaches 229 through migration 208, which owns this composite
    // tenant-key index. The shared local DB may lag that migration.
    await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_company_id_id
         ON contacts (company_id, id)`
    );
    // The migration itself is part of the test: rerunning it must remain safe.
    await client.query(MIGRATION);
    await client.query(MIGRATION);
    await client.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
            COMPANY_A, `${TAG} A`, `${TAG}-a`,
            COMPANY_B, `${TAG} B`, `${TAG}-b`,
        ]
    );
    const contacts = await client.query(
        `INSERT INTO contacts (company_id, full_name)
         VALUES ($1, 'TTL Contact A'), ($2, 'TTL Contact B')
         RETURNING id, company_id`,
        [COMPANY_A, COMPANY_B]
    );
    contactA = contacts.rows.find(row => row.company_id === COMPANY_A).id;
    contactB = contacts.rows.find(row => row.company_id === COMPANY_B).id;

    const mappings = await client.query(
        `INSERT INTO stripe_contact_customers
            (company_id, contact_id, stripe_account_id, stripe_customer_id)
         VALUES ($1, $2, $3, 'cus_ttl_a'), ($4, $5, $6, 'cus_ttl_b')
         RETURNING id, company_id`,
        [COMPANY_A, contactA, ACCOUNT_A, COMPANY_B, contactB, ACCOUNT_B]
    );
    const mappingA = mappings.rows.find(row => row.company_id === COMPANY_A).id;
    const mappingB = mappings.rows.find(row => row.company_id === COMPANY_B).id;
    const cards = await client.query(
        `INSERT INTO stripe_saved_payment_methods (
            company_id, contact_id, stripe_contact_customer_id,
            stripe_account_id, stripe_customer_id, stripe_payment_method_id,
            brand, last4, exp_month, exp_year, saved_at, expires_at
         ) VALUES
            ($1,$2,$3,$4,'cus_ttl_a','pm_expired_saved_at','visa','4242',12,2030,
             NOW() - INTERVAL '15 days', NOW() + INTERVAL '30 days'),
            ($1,$2,$3,$4,'cus_ttl_a','pm_fresh_a','mastercard','4444',11,2031,
             NOW() - INTERVAL '1 day', NOW() + INTERVAL '13 days'),
            ($5,$6,$7,$8,'cus_ttl_b','pm_fresh_b','amex','0005',10,2032,
             NOW() - INTERVAL '1 day', NOW() + INTERVAL '13 days')
         RETURNING id, company_id, stripe_payment_method_id`,
        [
            COMPANY_A, contactA, mappingA, ACCOUNT_A,
            COMPANY_B, contactB, mappingB, ACCOUNT_B,
        ]
    );
    expiredCardA = cards.rows.find(row => row.stripe_payment_method_id === 'pm_expired_saved_at');
    freshCardA = cards.rows.find(row => row.stripe_payment_method_id === 'pm_fresh_a');
    freshCardB = cards.rows.find(row => row.stripe_payment_method_id === 'pm_fresh_b');

    q.getAccountByCompany.mockResolvedValue({
        company_id: COMPANY_A,
        stripe_account_id: ACCOUNT_A,
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: { card_payments: 'active' },
        status: 'connected_ready',
    });
    q.getSessionByRequestKey.mockResolvedValue(null);
    jobsService.getJobById.mockResolvedValue({ id: 7001, contact_id: contactA });
    jobFinanceQueries.listJobPaymentRollups.mockResolvedValue([{ total_due: 95 }]);
    provider.retrievePaymentMethod.mockRejectedValue(
        new Error('Expired card reached Stripe provider')
    );
});

afterAll(async () => {
    db.query = originalQuery;
    if (client) {
        try {
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
    }
    await db.pool.end();
});

describe('CARD-ON-FILE-001 real PostgreSQL TTL and tenant controls', () => {
    test('TTL-SABOTAGE: charge rejects a >14-day card from saved_at before any Stripe call', async () => {
        await expect(service.chargeJobSavedCard(COMPANY_A, ACTOR, 7001, {
            savedCardId: Number(expiredCardA.id),
            amount: 95,
            expectedDue: 95,
            requestKey: REQUEST_KEY,
        })).rejects.toMatchObject({
            code: 'CARD_EXPIRED',
            httpStatus: 409,
        });
        expect(provider.retrievePaymentMethod).not.toHaveBeenCalled();
    });

    test('usable-card queries silently exclude expired rows from every UI surface', async () => {
        const usable = await savedCardsQueries.listUsableContactCards(
            COMPANY_A,
            contactA,
            ACCOUNT_A
        );

        expect(usable.map(row => String(row.id))).toEqual([String(freshCardA.id)]);
        expect(usable.map(row => String(row.id))).not.toContain(String(expiredCardA.id));
    });

    test('T-blast: a foreign tenant card is unavailable and byte-unchanged', async () => {
        const before = await client.query(
            `SELECT to_jsonb(card.*) AS row
             FROM stripe_saved_payment_methods card
             WHERE company_id = $1 AND id = $2`,
            [COMPANY_B, freshCardB.id]
        );

        await expect(service.chargeJobSavedCard(COMPANY_A, ACTOR, 7001, {
            savedCardId: Number(freshCardB.id),
            amount: 95,
            expectedDue: 95,
            requestKey: randomUUID(),
        })).rejects.toMatchObject({ code: 'CARD_EXPIRED', httpStatus: 409 });

        const after = await client.query(
            `SELECT to_jsonb(card.*) AS row
             FROM stripe_saved_payment_methods card
             WHERE company_id = $1 AND id = $2`,
            [COMPANY_B, freshCardB.id]
        );
        expect(after.rows[0].row).toStrictEqual(before.rows[0].row);
        expect(provider.retrievePaymentMethod).not.toHaveBeenCalled();
    });

    test('charging/marking use does not extend saved_at or expires_at', async () => {
        const before = await client.query(
            `SELECT saved_at, expires_at
             FROM stripe_saved_payment_methods
             WHERE company_id = $1 AND id = $2`,
            [COMPANY_A, freshCardA.id]
        );

        await savedCardsQueries.markCardUsed(COMPANY_A, freshCardA.id, client);

        const after = await client.query(
            `SELECT saved_at, expires_at, last_used_at
             FROM stripe_saved_payment_methods
             WHERE company_id = $1 AND id = $2`,
            [COMPANY_A, freshCardA.id]
        );
        expect(after.rows[0].saved_at).toEqual(before.rows[0].saved_at);
        expect(after.rows[0].expires_at).toEqual(before.rows[0].expires_at);
        expect(after.rows[0].last_used_at).toBeInstanceOf(Date);
    });
});
