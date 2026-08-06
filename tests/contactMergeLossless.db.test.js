'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const mergeService = require('../backend/src/services/contactEmailMergeService');

jest.setTimeout(60000);

const migration = fs.readFileSync(path.join(
    __dirname,
    '../backend/db/migrations/242_contact_merge_redirects.sql'
), 'utf8');

describe('ZB-DECOUPLE-001 B3 lossless contact merge against albusto_test', () => {
    let client;
    const companyA = randomUUID();
    const companyB = randomUUID();
    const suffix = randomUUID().replaceAll('-', '');

    async function insertContact(companyId, fields = {}) {
        const { rows } = await client.query(
            `INSERT INTO contacts
                (company_id, full_name, first_name, last_name, company_name, title,
                 phone_e164, secondary_phone, secondary_phone_name, email, notes,
                 structured_notes, zenbooker_customer_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
             RETURNING *`,
            [
                companyId,
                fields.full_name || null,
                fields.first_name || null,
                fields.last_name || null,
                fields.company_name || null,
                fields.title || null,
                fields.phone_e164 || null,
                fields.secondary_phone || null,
                fields.secondary_phone_name || null,
                fields.email || null,
                fields.notes || null,
                JSON.stringify(fields.structured_notes || []),
                fields.zenbooker_customer_id || null,
            ]
        );
        return rows[0];
    }

    async function seedEveryContactFk(survivor, donor) {
        const user = await client.query(
            `INSERT INTO crm_users (keycloak_sub, email, full_name)
             VALUES ($1, $2, 'B3 Fixture User') RETURNING id`,
            [`b3-${suffix}`, `b3-${suffix}@example.test`]
        );
        const userId = user.rows[0].id;
        const account = await client.query(
            `INSERT INTO crm_accounts (company_id, name)
             VALUES ($1, 'B3 Account') RETURNING id`,
            [companyA]
        );
        const deal = await client.query(
            `INSERT INTO crm_deals (company_id, name, stage)
             VALUES ($1, 'B3 Deal', 'open') RETURNING id`,
            [companyA]
        );
        const mailbox = await client.query(
            `INSERT INTO email_mailboxes (company_id, provider, email_address)
             VALUES ($1, 'gmail', $2) RETURNING id`,
            [companyA, `mailbox-${suffix}@example.test`]
        );
        const thread = await client.query(
            `INSERT INTO email_threads (company_id, mailbox_id, provider_thread_id)
             VALUES ($1, $2, $3) RETURNING id`,
            [companyA, mailbox.rows[0].id, `thread-${suffix}`]
        );
        const survivorTimeline = await client.query(
            `INSERT INTO timelines (company_id, contact_id, display_name)
             VALUES ($1, $2, 'Survivor timeline') RETURNING id`,
            [companyA, survivor.id]
        );
        const donorTimeline = await client.query(
            `INSERT INTO timelines
                (company_id, contact_id, display_name, has_unread, sms_last_at)
             VALUES ($1, $2, 'Donor timeline', true, NOW()) RETURNING id`,
            [companyA, donor.id]
        );
        const job = await client.query(
            `INSERT INTO jobs (company_id, contact_id, zenbooker_job_id)
             VALUES ($1, $2, $3) RETURNING id`,
            [companyA, donor.id, `b3-job-${suffix}`]
        );
        const lead = await client.query(
            `INSERT INTO leads (company_id, uuid, contact_id)
             VALUES ($1, $2, $3) RETURNING id`,
            [companyA, `b3-lead-${suffix}`.slice(0, 40), donor.id]
        );
        const estimate = await client.query(
            `INSERT INTO estimates (company_id, estimate_number, contact_id)
             VALUES ($1, $2, $3) RETURNING id`,
            [companyA, `EST-${suffix.slice(0, 12)}`, donor.id]
        );
        const invoice = await client.query(
            `INSERT INTO invoices (company_id, invoice_number, contact_id)
             VALUES ($1, $2, $3) RETURNING id`,
            [companyA, `INV-${suffix.slice(0, 12)}`, donor.id]
        );
        const address = await client.query(
            `INSERT INTO contact_addresses
                (contact_id, label, is_primary, street_line1, city, state, postal_code,
                 google_place_id, address_normalized_hash)
             VALUES ($1, 'Home', true, '1 Donor Way', 'Boston', 'MA', '02101', $2, $3)
             RETURNING id`,
            [donor.id, `place-${suffix}`, `hash-${suffix}`]
        );
        await client.query(
            `UPDATE leads SET contact_address_id = $1
              WHERE id = $2 AND company_id = $3`,
            [address.rows[0].id, lead.rows[0].id, companyA]
        );

        await client.query(
            `INSERT INTO call_masking_sessions
                (company_id, call_sid, contact_id, provider_user_id, masking_number)
             VALUES ($1, $2, $3, $4, '+16174044425')`,
            [companyA, `CA-b3-${suffix}`, donor.id, userId]
        );
        await client.query(
            `INSERT INTO calls
                (call_sid, contact_id, direction, status, company_id, timeline_id)
             VALUES ($1, $2, 'inbound', 'completed', $3, $4)`,
            [`CA-direct-${suffix}`, donor.id, companyA, donorTimeline.rows[0].id]
        );
        await client.query(
            `INSERT INTO contact_call_masking_codes (company_id, contact_id, code)
             VALUES ($1, $2, 800001)`,
            [companyA, donor.id]
        );
        await client.query(
            `INSERT INTO contact_emails (contact_id, email, email_normalized, is_primary)
             VALUES ($1, $2, LOWER($2), true),
                    ($1, $3, LOWER($3), false)`,
            [donor.id, donor.email, `other-${suffix}@example.test`]
        );
        await client.query(
            `INSERT INTO contact_external_identities
                (company_id, source, external_id, contact_id)
             VALUES ($1, 'zenbooker', $2, $3),
                    ($1, 'legacy_import', $4, $3)`,
            [companyA, donor.zenbooker_customer_id, donor.id, `legacy-${suffix}`]
        );
        await client.query(
            `INSERT INTO contact_phones
                (company_id, contact_id, phone_e164, normalized_phone, label, is_primary)
             VALUES ($1, $2, '+16175550100', '6175550100', 'Survivor label', true),
                    ($1, $3, '(617) 555-0100', '6175550100', 'Donor label', true),
                    ($1, $3, '+16175550101', '6175550101', 'Donor secondary', false)`,
            [companyA, survivor.id, donor.id]
        );
        await client.query(
            `INSERT INTO crm_account_contacts
                (company_id, account_id, contact_id, relationship_type)
             VALUES ($1, $2, $3, 'customer')`,
            [companyA, account.rows[0].id, donor.id]
        );
        await client.query(
            `INSERT INTO crm_activities
                (company_id, contact_id, type, summary, source_entity_type, source_entity_id)
             VALUES ($1, $2, 'note', 'Donor activity', 'contact', $3)`,
            [companyA, donor.id, String(donor.id)]
        );
        await client.query(
            `INSERT INTO crm_deal_contacts (company_id, deal_id, contact_id, role)
             VALUES ($1, $2, $3, 'decision_maker')`,
            [companyA, deal.rows[0].id, donor.id]
        );
        await client.query(
            `INSERT INTO email_messages
                (company_id, mailbox_id, thread_id, provider_message_id, direction,
                 contact_id, timeline_id, on_timeline)
             VALUES ($1, $2, $3, $4, 'inbound', $5, $6, true)`,
            [companyA, mailbox.rows[0].id, thread.rows[0].id,
                `message-${suffix}`, donor.id, donorTimeline.rows[0].id]
        );
        await client.query(
            `INSERT INTO outbound_call_attempts (company_id, job_id, contact_id)
             VALUES ($1, $2, $3)`,
            [companyA, job.rows[0].id, donor.id]
        );
        await client.query(
            `INSERT INTO payment_transactions
                (company_id, contact_id, transaction_type, payment_method, amount)
             VALUES ($1, $2, 'payment', 'cash', 12.34)`,
            [companyA, donor.id]
        );
        const token = await client.query(
            `INSERT INTO portal_access_tokens
                (company_id, contact_id, token_hash, expires_at)
             VALUES ($1, $2, $3, NOW() + INTERVAL '1 day') RETURNING id`,
            [companyA, donor.id, `token-${suffix}`]
        );
        const session = await client.query(
            `INSERT INTO portal_sessions (token_id, contact_id)
             VALUES ($1, $2) RETURNING id`,
            [token.rows[0].id, donor.id]
        );
        await client.query(
            `INSERT INTO portal_events (session_id, contact_id, event_type)
             VALUES ($1, $2, 'view')`,
            [session.rows[0].id, donor.id]
        );
        const stripeCustomer = await client.query(
            `INSERT INTO stripe_contact_customers
                (company_id, contact_id, stripe_account_id, stripe_customer_id)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [companyA, donor.id, `acct_${suffix}`, `cus_${suffix}`]
        );
        await client.query(
            `INSERT INTO stripe_saved_payment_methods
                (company_id, contact_id, stripe_contact_customer_id,
                 stripe_account_id, stripe_customer_id, stripe_payment_method_id,
                 brand, last4, exp_month, exp_year)
             VALUES ($1, $2, $3, $4, $5, $6, 'visa', '4242', 12, 2030)`,
            [companyA, donor.id, stripeCustomer.rows[0].id,
                `acct_${suffix}`, `cus_${suffix}`, `pm_${suffix}`]
        );
        await client.query(
            `INSERT INTO stripe_payment_sessions (company_id, contact_id, amount)
             VALUES ($1, $2, 23.45)`,
            [companyA, donor.id]
        );
        await client.query(
            `INSERT INTO tasks
                (company_id, thread_id, subject_type, subject_id, title, status, contact_id)
             VALUES ($1, $2, 'contact', $3, 'Closed donor task', 'done', $3)`,
            [companyA, donorTimeline.rows[0].id, donor.id]
        );
        await client.query(
            `INSERT INTO yelp_conversations (company_id, conversation_id, timeline_id)
             VALUES ($1, $2, $3)`,
            [companyA, `yelp-${suffix}`, donorTimeline.rows[0].id]
        );
        await client.query(
            `INSERT INTO crm_notes (company_id, entity_type, entity_id, text, source)
             VALUES ($1, 'contact', $2, 'CRM donor note', 'manual')`,
            [companyA, donor.id]
        );
        await client.query(
            `INSERT INTO note_attachments
                (company_id, entity_type, entity_id, note_index, note_id,
                 file_name, storage_key)
             VALUES ($1, 'contact', $2, 1, 'donor-note', 'donor.txt', $3)`,
            [companyA, donor.id, `b3/${suffix}/donor.txt`]
        );

        return {
            survivorTimelineId: survivorTimeline.rows[0].id,
            donorTimelineId: donorTimeline.rows[0].id,
            stripeCustomerId: stripeCustomer.rows[0].id,
            directTables: mergeService.CONTACT_FK_INVENTORY.map(row => row.table),
            ids: {
                job: job.rows[0].id,
                lead: lead.rows[0].id,
                estimate: estimate.rows[0].id,
                invoice: invoice.rows[0].id,
            },
        };
    }

    beforeAll(async () => {
        client = await db.pool.connect();
        await client.query('BEGIN');
        await client.query(migration);
        await client.query(
            `INSERT INTO companies (id, name, slug, status, timezone)
             VALUES ($1, 'B3 merge A', $2, 'active', 'America/New_York'),
                    ($3, 'B3 merge B', $4, 'active', 'America/New_York')`,
            [companyA, `b3-merge-a-${suffix}`, companyB, `b3-merge-b-${suffix}`]
        );
    });

    test('FK-TABLE INVENTORY exactly matches every live FK whose referenced key includes contacts.id', async () => {
        const { rows } = await client.query(
            `SELECT DISTINCT child.relname AS table_name, child_col.attname AS column_name
               FROM pg_constraint constraint_row
               JOIN pg_class parent ON parent.oid = constraint_row.confrelid
               JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
               JOIN pg_class child ON child.oid = constraint_row.conrelid
               JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
                    WITH ORDINALITY AS keys(child_attnum, parent_attnum, ord) ON true
               JOIN pg_attribute child_col
                 ON child_col.attrelid = child.oid AND child_col.attnum = keys.child_attnum
               JOIN pg_attribute parent_col
                 ON parent_col.attrelid = parent.oid AND parent_col.attnum = keys.parent_attnum
              WHERE constraint_row.contype = 'f'
                AND parent_ns.nspname = 'public'
                AND parent.relname = 'contacts'
                AND parent_col.attname = 'id'
              ORDER BY child.relname, child_col.attname`
        );
        expect(rows.map(row => `${row.table_name}:${row.column_name}`)).toEqual(
            mergeService.CONTACT_FK_INVENTORY
                .map(row => `${row.table}:contact_id`)
                .sort()
        );
        expect(rows).toHaveLength(25);
    });

    test('moves every child, notes, identities, phones, and closed history; archives and redirects idempotently', async () => {
        const survivor = await insertContact(companyA, {
            full_name: 'Survivor Name Must Win',
            phone_e164: '+16175550100',
            email: 'survivor@example.test',
            notes: 'Keep survivor note',
            structured_notes: [
                { id: 'same-note', text: 'Richer survivor note', created_by: 'local-user' },
                { id: 'survivor-note', text: 'Survivor only' },
            ],
            zenbooker_customer_id: `zb-survivor-${suffix}`,
        });
        const donor = await insertContact(companyA, {
            full_name: 'Donor Name Must Not Steal',
            first_name: 'Fill First',
            phone_e164: '(617) 555-0100',
            secondary_phone: '+16175550101',
            secondary_phone_name: 'Donor secondary',
            email: 'donor@example.test',
            notes: 'Donor legacy note',
            structured_notes: [
                { id: 'same-note', text: 'Bare donor duplicate' },
                { id: 'donor-note', text: 'Donor only' },
            ],
            zenbooker_customer_id: `zb-donor-${suffix}`,
        });
        const fixture = await seedEveryContactFk(survivor, donor);

        const result = await mergeService.mergeContacts(
            survivor.id, donor.id, companyA, client
        );
        expect(result).toMatchObject({
            status: 'merged',
            survivor_contact_id: survivor.id,
            merged_contact_id: donor.id,
            dropped_phones: [],
            idempotent: false,
        });

        for (const descriptor of mergeService.CONTACT_FK_INVENTORY) {
            const donorPredicate = descriptor.hasCompanyId
                ? `contact_id = $1 AND company_id = $2`
                : `contact_id = $1`;
            const { rows: [remaining] } = await client.query(
                `SELECT COUNT(*)::int AS count FROM ${descriptor.table} WHERE ${donorPredicate}`,
                descriptor.hasCompanyId ? [donor.id, companyA] : [donor.id]
            );
            expect({ table: descriptor.table, count: remaining.count }).toEqual({
                table: descriptor.table,
                count: 0,
            });
            const survivorPredicate = descriptor.hasCompanyId
                ? `contact_id = $1 AND company_id = $2`
                : `contact_id = $1`;
            const { rows: [reowned] } = await client.query(
                `SELECT COUNT(*)::int AS count FROM ${descriptor.table} WHERE ${survivorPredicate}`,
                descriptor.hasCompanyId ? [survivor.id, companyA] : [survivor.id]
            );
            expect({ table: descriptor.table, count: reowned.count }).toEqual({
                table: descriptor.table,
                count: expect.any(Number),
            });
            expect(reowned.count).toBeGreaterThan(0);
        }
        await expect(mergeService.assertNoDonorReferences(client, companyA, donor.id))
            .resolves.toBeUndefined();

        const { rows: [survivorAfter] } = await client.query(
            `SELECT * FROM contacts WHERE id = $1 AND company_id = $2`,
            [survivor.id, companyA]
        );
        expect(survivorAfter.full_name).toBe('Survivor Name Must Win');
        expect(survivorAfter.email).toBe('survivor@example.test');
        expect(survivorAfter.phone_e164).toBe('+16175550100');
        expect(survivorAfter.first_name).toBe('Fill First');
        expect(survivorAfter.secondary_phone).toBe('+16175550101');
        expect(survivorAfter.notes).toContain('Keep survivor note');
        expect(survivorAfter.notes).toContain('Donor legacy note');
        expect(survivorAfter.structured_notes.map(note => note.id)).toEqual([
            'same-note', 'survivor-note', 'donor-note',
        ]);
        expect(survivorAfter.structured_notes[0].text).toBe('Richer survivor note');

        const { rows: [donorAfter] } = await client.query(
            `SELECT deleted_at FROM contacts WHERE id = $1 AND company_id = $2`,
            [donor.id, companyA]
        );
        expect(donorAfter).toBeTruthy();
        expect(donorAfter.deleted_at).toBeTruthy();

        const { rows: identities } = await client.query(
            `SELECT source, external_id FROM contact_external_identities
              WHERE company_id = $1 AND contact_id = $2
              ORDER BY source, external_id`,
            [companyA, survivor.id]
        );
        expect(identities).toEqual(expect.arrayContaining([
            { source: 'legacy_import', external_id: `legacy-${suffix}` },
            { source: 'zenbooker', external_id: `zb-donor-${suffix}` },
            { source: 'zenbooker', external_id: `zb-survivor-${suffix}` },
        ]));
        const { rows: phones } = await client.query(
            `SELECT normalized_phone, label FROM contact_phones
              WHERE company_id = $1 AND contact_id = $2
              ORDER BY normalized_phone`,
            [companyA, survivor.id]
        );
        expect(phones.map(row => row.normalized_phone)).toEqual(['6175550100', '6175550101']);
        expect(phones[0].label).toContain('Survivor label');
        expect(phones[0].label).toContain('Donor label');

        const { rows: [closedTask] } = await client.query(
            `SELECT contact_id, subject_id, thread_id, status FROM tasks
              WHERE company_id = $1 AND title = 'Closed donor task'`,
            [companyA]
        );
        expect(closedTask).toEqual({
            contact_id: survivor.id,
            subject_id: survivor.id,
            thread_id: fixture.survivorTimelineId,
            status: 'done',
        });
        const { rows: [stripe] } = await client.query(
            `SELECT customer.contact_id AS customer_contact_id,
                    method.contact_id AS method_contact_id
               FROM stripe_contact_customers customer
               JOIN stripe_saved_payment_methods method
                 ON method.stripe_contact_customer_id = customer.id
              WHERE customer.id = $1 AND customer.company_id = $2`,
            [fixture.stripeCustomerId, companyA]
        );
        expect(stripe).toEqual({
            customer_contact_id: survivor.id,
            method_contact_id: survivor.id,
        });
        const { rows: [attachment] } = await client.query(
            `SELECT entity_id, note_id FROM note_attachments
              WHERE company_id = $1 AND storage_key = $2`,
            [companyA, `b3/${suffix}/donor.txt`]
        );
        expect(attachment).toEqual({ entity_id: survivor.id, note_id: 'donor-note' });

        const { rows: [redirect] } = await client.query(
            `SELECT survivor_contact_id, status, review_reasons, merged_at
               FROM contact_merge_redirects
              WHERE company_id = $1 AND old_contact_id = $2`,
            [companyA, donor.id]
        );
        expect(redirect).toMatchObject({
            survivor_contact_id: survivor.id,
            status: 'merged',
            review_reasons: [],
        });
        expect(redirect.merged_at).toBeTruthy();

        const beforeCounts = await client.query(
            `SELECT
                (SELECT COUNT(*)::int FROM jobs WHERE company_id = $1 AND contact_id = $2) AS jobs,
                (SELECT COUNT(*)::int FROM contact_phones WHERE company_id = $1 AND contact_id = $2) AS phones,
                (SELECT COUNT(*)::int FROM tasks WHERE company_id = $1 AND contact_id = $2) AS tasks`,
            [companyA, survivor.id]
        );
        const rerun = await mergeService.mergeContacts(
            survivor.id, donor.id, companyA, client
        );
        expect(rerun).toMatchObject({
            status: 'merged',
            survivor_contact_id: survivor.id,
            idempotent: true,
        });
        const afterCounts = await client.query(
            `SELECT
                (SELECT COUNT(*)::int FROM jobs WHERE company_id = $1 AND contact_id = $2) AS jobs,
                (SELECT COUNT(*)::int FROM contact_phones WHERE company_id = $1 AND contact_id = $2) AS phones,
                (SELECT COUNT(*)::int FROM tasks WHERE company_id = $1 AND contact_id = $2) AS tasks`,
            [companyA, survivor.id]
        );
        expect(afterCounts.rows[0]).toEqual(beforeCounts.rows[0]);
    });

    test('different Stripe customers quarantine the donor without archiving or moving links', async () => {
        const survivor = await insertContact(companyA, { full_name: 'Stripe survivor' });
        const donor = await insertContact(companyA, { full_name: 'Stripe donor' });
        const survivorCustomer = await client.query(
            `INSERT INTO stripe_contact_customers
                (company_id, contact_id, stripe_account_id, stripe_customer_id)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [companyA, survivor.id, `acct-conflict-a-${suffix}`, `cus-conflict-a-${suffix}`]
        );
        const donorCustomer = await client.query(
            `INSERT INTO stripe_contact_customers
                (company_id, contact_id, stripe_account_id, stripe_customer_id)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [companyA, donor.id, `acct-conflict-b-${suffix}`, `cus-conflict-b-${suffix}`]
        );
        await client.query(
            `INSERT INTO stripe_saved_payment_methods
                (company_id, contact_id, stripe_contact_customer_id,
                 stripe_account_id, stripe_customer_id, stripe_payment_method_id,
                 brand, last4, exp_month, exp_year)
             VALUES ($1, $2, $3, $4, $5, $6, 'visa', '1111', 1, 2031)`,
            [companyA, donor.id, donorCustomer.rows[0].id,
                `acct-conflict-b-${suffix}`, `cus-conflict-b-${suffix}`, `pm-conflict-${suffix}`]
        );

        const result = await mergeService.mergeContacts(
            survivor.id, donor.id, companyA, client
        );
        expect(result).toMatchObject({
            status: 'needs_review',
            survivor_contact_id: survivor.id,
            merged_contact_id: donor.id,
        });
        expect(result.review_reasons).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'stripe_customer_conflict' }),
        ]));
        const { rows: [state] } = await client.query(
            `SELECT contact.deleted_at, redirect.status, redirect.review_reasons,
                    (SELECT contact_id FROM stripe_contact_customers WHERE id = $3) AS donor_stripe_owner,
                    (SELECT contact_id FROM stripe_contact_customers WHERE id = $4) AS survivor_stripe_owner
               FROM contacts contact
               JOIN contact_merge_redirects redirect
                 ON redirect.company_id = contact.company_id
                AND redirect.old_contact_id = contact.id
              WHERE contact.company_id = $1 AND contact.id = $2`,
            [companyA, donor.id, donorCustomer.rows[0].id, survivorCustomer.rows[0].id]
        );
        expect(state.deleted_at).toBeNull();
        expect(state.status).toBe('needs_review');
        expect(state.review_reasons).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'stripe_customer_conflict' }),
        ]));
        expect(state.donor_stripe_owner).toBe(donor.id);
        expect(state.survivor_stripe_owner).toBe(survivor.id);
    });

    test('same-company guard refuses a foreign donor and leaves both tenants unchanged', async () => {
        const survivor = await insertContact(companyA, { full_name: 'Tenant A survivor' });
        const foreign = await insertContact(companyB, { full_name: 'Tenant B donor' });
        await client.query(
            `INSERT INTO jobs (company_id, contact_id, zenbooker_job_id)
             VALUES ($1, $2, $3)`,
            [companyB, foreign.id, `foreign-${suffix}`]
        );
        await expect(mergeService.mergeContacts(survivor.id, foreign.id, companyA, client))
            .rejects.toThrow(/cross-tenant/i);
        const { rows: [state] } = await client.query(
            `SELECT
                (SELECT deleted_at FROM contacts WHERE id = $1 AND company_id = $2) AS foreign_deleted_at,
                (SELECT contact_id FROM jobs WHERE zenbooker_job_id = $3 AND company_id = $2) AS foreign_job_contact,
                (SELECT COUNT(*)::int FROM contact_merge_redirects
                  WHERE company_id = $4 AND old_contact_id = $1) AS wrong_tenant_audits`,
            [foreign.id, companyB, `foreign-${suffix}`, companyA]
        );
        expect(state).toEqual({
            foreign_deleted_at: null,
            foreign_job_contact: foreign.id,
            wrong_tenant_audits: 0,
        });
    });

    afterAll(async () => {
        if (client) {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
        await db.pool.end().catch(() => {});
    });
});
