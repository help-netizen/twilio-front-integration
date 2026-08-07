'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const { parseArgs, run } = require('../scripts/bulkMergeContacts');

jest.setTimeout(60000);

describe('ZB-DECOUPLE-001 B4 bulk contact merge against albusto_test', () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const fuzzyCompany = randomUUID();
    const suffix = randomUUID().replaceAll('-', '');
    const cleanPhone = '6175554101';
    const householdPhone = '6175554202';
    const stripePhone = '6175554303';
    const fuzzyPhones = {
        marilyn: '6175554401',
        kanny: '6175554402',
        nickname: '6175554403',
        gender: '6175554404',
        different: '6175554405',
        placeholder: '6175554406',
        multi: '6175554407',
        sabotage: '6175554408',
    };
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'albusto-b4-'));
    const output = jest.fn();
    const warningOutput = jest.fn();
    const ids = {};
    const fuzzyIds = {};
    let runNumber = 0;

    function dependencies() {
        runNumber += 1;
        return {
            db,
            output,
            warningOutput,
            outputDirectory,
            now: () => new Date(`2035-01-0${runNumber}T12:00:00.000Z`),
        };
    }

    async function insertContact(companyId, fields) {
        const { rows } = await db.query(
            `INSERT INTO contacts
                (company_id, full_name, first_name, last_name, company_name,
                 phone_e164, email, notes, zenbooker_customer_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id`,
            [
                companyId,
                fields.fullName,
                fields.firstName || null,
                fields.lastName || null,
                fields.companyName || null,
                fields.phone,
                fields.email || null,
                fields.notes || null,
                fields.externalId || null,
                fields.createdAt,
            ]
        );
        return rows[0].id;
    }

    async function inventoryPhone(companyId, contactId, phone, normalizedPhone) {
        await db.query(
            `INSERT INTO contact_phones
                (company_id, contact_id, phone_e164, normalized_phone, is_primary)
             VALUES ($1, $2, $3, $4, true)`,
            [companyId, contactId, phone, normalizedPhone]
        );
    }

    async function companySnapshot(companyId) {
        const { rows } = await db.query(
            `SELECT jsonb_build_object(
                'contacts', COALESCE((
                    SELECT jsonb_agg(to_jsonb(contact_row) ORDER BY contact_row.id)
                    FROM contacts contact_row WHERE contact_row.company_id = $1
                ), '[]'::jsonb),
                'phones', COALESCE((
                    SELECT jsonb_agg(to_jsonb(phone_row) ORDER BY phone_row.id)
                    FROM contact_phones phone_row WHERE phone_row.company_id = $1
                ), '[]'::jsonb),
                'identities', COALESCE((
                    SELECT jsonb_agg(to_jsonb(identity_row) ORDER BY identity_row.source, identity_row.external_id)
                    FROM contact_external_identities identity_row WHERE identity_row.company_id = $1
                ), '[]'::jsonb),
                'redirects', COALESCE((
                    SELECT jsonb_agg(to_jsonb(redirect_row) ORDER BY redirect_row.old_contact_id)
                    FROM contact_merge_redirects redirect_row WHERE redirect_row.company_id = $1
                ), '[]'::jsonb),
                'jobs', COALESCE((
                    SELECT jsonb_agg(to_jsonb(job_row) ORDER BY job_row.id)
                    FROM jobs job_row WHERE job_row.company_id = $1
                ), '[]'::jsonb),
                'leads', COALESCE((
                    SELECT jsonb_agg(to_jsonb(lead_row) ORDER BY lead_row.id)
                    FROM leads lead_row WHERE lead_row.company_id = $1
                ), '[]'::jsonb),
                'invoices', COALESCE((
                    SELECT jsonb_agg(to_jsonb(invoice_row) ORDER BY invoice_row.id)
                    FROM invoices invoice_row WHERE invoice_row.company_id = $1
                ), '[]'::jsonb),
                'stripe_customers', COALESCE((
                    SELECT jsonb_agg(to_jsonb(stripe_row) ORDER BY stripe_row.id)
                    FROM stripe_contact_customers stripe_row WHERE stripe_row.company_id = $1
                ), '[]'::jsonb)
            ) AS snapshot`,
            [companyId]
        );
        return JSON.stringify(rows[0].snapshot);
    }

    beforeAll(async () => {
        const mergeMigration = fs.readFileSync(path.join(
            __dirname,
            '../backend/db/migrations/243_contact_merge_redirects.sql'
        ), 'utf8');
        await db.query(mergeMigration);
        await db.query(
            `INSERT INTO companies (id, name, slug, status, timezone)
             VALUES ($1, 'B4 bulk merge A', $2, 'active', 'America/New_York'),
                    ($3, 'B4 bulk merge B', $4, 'active', 'America/New_York'),
                    ($5, 'B4 fuzzy merge', $6, 'active', 'America/New_York')`,
            [
                companyA,
                `b4-a-${suffix}`,
                companyB,
                `b4-b-${suffix}`,
                fuzzyCompany,
                `b4-fuzzy-${suffix}`,
            ]
        );

        ids.cleanOld = await insertContact(companyA, {
            fullName: 'Alice B. Carter',
            firstName: 'Alice',
            lastName: 'Carter',
            companyName: 'Carter Home',
            phone: '+1 (617) 555-4101',
            email: `alice-old-${suffix}@example.test`,
            notes: 'Old but less linked',
            externalId: `zb-clean-old-${suffix}`,
            createdAt: '2020-01-01T00:00:00Z',
        });
        ids.cleanWinner = await insertContact(companyA, {
            fullName: 'Carter, Alice B',
            phone: '617.555.4101',
            externalId: `zb-clean-winner-${suffix}`,
            createdAt: '2023-01-01T00:00:00Z',
        });
        ids.cleanOther = await insertContact(companyA, {
            fullName: 'ALICE CARTER',
            phone: '1-617-555-4101',
            email: `alice-other-${suffix}@example.test`,
            externalId: `zb-clean-other-${suffix}`,
            createdAt: '2019-01-01T00:00:00Z',
        });
        for (const contactId of [ids.cleanOld, ids.cleanWinner, ids.cleanOther]) {
            await inventoryPhone(companyA, contactId, '+16175554101', cleanPhone);
        }
        for (const [contactId, externalId] of [
            [ids.cleanOld, `zb-clean-old-${suffix}`],
            [ids.cleanWinner, `zb-clean-winner-${suffix}`],
            [ids.cleanOther, `zb-clean-other-${suffix}`],
        ]) {
            await db.query(
                `INSERT INTO contact_external_identities
                    (company_id, source, external_id, contact_id)
                 VALUES ($1, 'zenbooker', $2, $3)`,
                [companyA, externalId, contactId]
            );
        }
        await db.query(
            `INSERT INTO jobs (company_id, contact_id, zenbooker_job_id)
             VALUES ($1, $2, $3), ($1, $2, $4), ($1, $2, $5), ($1, $6, $7)`,
            [
                companyA,
                ids.cleanWinner,
                `b4-winner-1-${suffix}`,
                `b4-winner-2-${suffix}`,
                `b4-winner-3-${suffix}`,
                ids.cleanOld,
                `b4-old-1-${suffix}`,
            ]
        );
        await db.query(
            `INSERT INTO leads (company_id, uuid, contact_id)
             VALUES ($1, $2, $3)`,
            [companyA, `b4-lead-${suffix}`.slice(0, 40), ids.cleanOther]
        );
        await db.query(
            `INSERT INTO invoices (company_id, invoice_number, contact_id)
             VALUES ($1, $2, $3)`,
            [companyA, `B4-${suffix.slice(0, 12)}`, ids.cleanOther]
        );

        ids.householdOne = await insertContact(companyA, {
            fullName: 'John Reed',
            phone: '+16175554202',
            createdAt: '2021-01-01T00:00:00Z',
        });
        ids.householdTwo = await insertContact(companyA, {
            fullName: 'Jane Reed',
            phone: '617-555-4202',
            createdAt: '2022-01-01T00:00:00Z',
        });
        await inventoryPhone(companyA, ids.householdOne, '+16175554202', householdPhone);
        await inventoryPhone(companyA, ids.householdTwo, '+16175554202', householdPhone);

        ids.stripeOne = await insertContact(companyA, {
            fullName: 'Robert Stone',
            phone: '+16175554303',
            createdAt: '2021-01-01T00:00:00Z',
        });
        ids.stripeTwo = await insertContact(companyA, {
            fullName: 'Robert Stone',
            phone: '617-555-4303',
            createdAt: '2022-01-01T00:00:00Z',
        });
        await inventoryPhone(companyA, ids.stripeOne, '+16175554303', stripePhone);
        await inventoryPhone(companyA, ids.stripeTwo, '+16175554303', stripePhone);
        const stripeOne = await db.query(
            `INSERT INTO stripe_contact_customers
                (company_id, contact_id, stripe_account_id, stripe_customer_id)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [companyA, ids.stripeOne, `acct_b4_one_${suffix}`, `cus_b4_one_${suffix}`]
        );
        const stripeTwo = await db.query(
            `INSERT INTO stripe_contact_customers
                (company_id, contact_id, stripe_account_id, stripe_customer_id)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [companyA, ids.stripeTwo, `acct_b4_two_${suffix}`, `cus_b4_two_${suffix}`]
        );
        await db.query(
            `INSERT INTO stripe_saved_payment_methods
                (company_id, contact_id, stripe_contact_customer_id,
                 stripe_account_id, stripe_customer_id, stripe_payment_method_id,
                 brand, last4, exp_month, exp_year)
             VALUES ($1, $2, $3, $4, $5, $6, 'visa', '4242', 12, 2035)`,
            [
                companyA,
                ids.stripeTwo,
                stripeTwo.rows[0].id,
                `acct_b4_two_${suffix}`,
                `cus_b4_two_${suffix}`,
                `pm_b4_${suffix}`,
            ]
        );
        expect(stripeOne.rows[0].id).toBeDefined();

        ids.foreignOne = await insertContact(companyB, {
            fullName: 'Foreign One',
            phone: '+16175554101',
            createdAt: '2020-01-01T00:00:00Z',
        });
        ids.foreignTwo = await insertContact(companyB, {
            fullName: 'Foreign Two',
            phone: '617-555-4101',
            createdAt: '2021-01-01T00:00:00Z',
        });
        await inventoryPhone(companyB, ids.foreignOne, '+16175554101', cleanPhone);
        await inventoryPhone(companyB, ids.foreignTwo, '+16175554101', cleanPhone);

        const fuzzyFixtures = {
            marilyn: [
                ['Marilyn Stone', 'Marilyn', 'Stone'],
                ['Marylin Stone', 'Marylin', 'Stone'],
            ],
            kanny: [
                ['Kanny Lee', 'Kanny', 'Lee'],
                ['Kenny Lee', 'Kenny', 'Lee'],
            ],
            nickname: [
                ['Judy Hale', 'Judy', 'Hale'],
                ['Judith Hale', 'Judith', 'Hale'],
            ],
            gender: [
                ['Gabriel Hall', 'Gabriel', 'Hall'],
                ['Gabrielle Hall', 'Gabrielle', 'Hall'],
            ],
            different: [
                ['Olga Elizarova', 'Olga', 'Elizarova'],
                ['Brooks Allwardt', 'Brooks', 'Allwardt'],
            ],
            placeholder: [
                ['Test Customer', 'Test', 'Customer'],
                ['Tess Customer', 'Tess', 'Customer'],
            ],
            multi: [
                ['Marilyn Stone', 'Marilyn', 'Stone'],
                ['Marylin Stone', 'Marylin', 'Stone'],
                ['Olga Stone', 'Olga', 'Stone'],
            ],
            sabotage: [
                ['John Reed', 'John', 'Reed'],
                ['Jane Reed', 'Jane', 'Reed'],
            ],
        };
        for (const [fixture, members] of Object.entries(fuzzyFixtures)) {
            fuzzyIds[fixture] = [];
            for (const [fullName, firstName, lastName] of members) {
                const contactId = await insertContact(fuzzyCompany, {
                    fullName,
                    firstName,
                    lastName,
                    phone: `+1${fuzzyPhones[fixture]}`,
                    createdAt: '2024-01-01T00:00:00Z',
                });
                fuzzyIds[fixture].push(contactId);
                await inventoryPhone(
                    fuzzyCompany,
                    contactId,
                    `+1${fuzzyPhones[fixture]}`,
                    fuzzyPhones[fixture]
                );
            }
        }
    });

    test('requires an explicit mode and validates the optional selection guards', () => {
        expect(() => parseArgs(['--company-id', companyA])).toThrow(
            'Choose exactly one explicit mode'
        );
        expect(() => parseArgs(['--company-id', companyA, '--dry-run', '--apply']))
            .toThrow('Choose exactly one explicit mode');
        expect(() => parseArgs(['--company-id', companyA, '--dry-run', '--limit', '0']))
            .toThrow('--limit must be a positive integer');
        expect(() => parseArgs(['--company-id', companyA, '--dry-run', '--set', '617555']))
            .toThrow('--set must be one normalized 10-digit phone number');
        expect(parseArgs(['--company-id', companyA, '--dry-run']).fuzzy).toBe(false);
        expect(parseArgs(['--company-id', companyA, '--dry-run', '--fuzzy']).fuzzy).toBe(true);
    });

    test('fuzzy merges close variants while gender, placeholder, and different people stay in review', async () => {
        const defaultDryRun = await run(
            ['--company-id', fuzzyCompany, '--dry-run'],
            dependencies()
        );
        expect(defaultDryRun.totals).toEqual({
            sets: 8,
            mergeable: 0,
            probable_household: 8,
            quarantine_blocked: 0,
            total_donors: 9,
        });
        expect(defaultDryRun.contact_totals).toEqual({
            before: 17,
            expected_after: 17,
            after: 17,
        });
        expect(defaultDryRun.sets.every(set => set.fuzzy_reason === undefined)).toBe(true);

        const fuzzyDryRun = await run(
            ['--company-id', fuzzyCompany, '--dry-run', '--fuzzy'],
            dependencies()
        );
        expect(fuzzyDryRun.totals).toEqual({
            sets: 8,
            mergeable: 3,
            probable_household: 5,
            quarantine_blocked: 0,
            total_donors: 9,
        });
        expect(fuzzyDryRun.contact_totals).toEqual({
            before: 17,
            expected_after: 14,
            after: 17,
        });
        const plansByPhone = new Map(
            fuzzyDryRun.sets.map(set => [set.normalized_phone, set])
        );
        expect(plansByPhone.get(fuzzyPhones.marilyn)).toMatchObject({
            disposition: 'mergeable',
            fuzzy_reason: 'levenshtein',
        });
        expect(plansByPhone.get(fuzzyPhones.kanny)).toMatchObject({
            disposition: 'mergeable',
            fuzzy_reason: 'levenshtein',
        });
        expect(plansByPhone.get(fuzzyPhones.nickname)).toMatchObject({
            disposition: 'mergeable',
            fuzzy_reason: 'nickname',
        });
        for (const fixture of ['gender', 'different', 'placeholder', 'multi', 'sabotage']) {
            expect(plansByPhone.get(fuzzyPhones[fixture])).toMatchObject({
                disposition: 'probable_household',
            });
            expect(plansByPhone.get(fuzzyPhones[fixture]).fuzzy_reason).toBeUndefined();
        }
        expect(plansByPhone.get(fuzzyPhones.gender).household.members.map(member => member.name))
            .toEqual(['Gabriel Hall', 'Gabrielle Hall']);
        expect(plansByPhone.get(fuzzyPhones.different).household.members.map(member => member.name))
            .toEqual(['Olga Elizarova', 'Brooks Allwardt']);
        expect(plansByPhone.get(fuzzyPhones.placeholder).household.members.map(member => member.name))
            .toEqual(['Test Customer', 'Tess Customer']);
        expect(plansByPhone.get(fuzzyPhones.multi).household.members).toHaveLength(3);

        const summary = fs.readFileSync(fuzzyDryRun.artifacts.summary, 'utf8');
        expect(summary).toContain('FUZZY → mergeable (3)');
        expect(summary).toContain(`${fuzzyPhones.marilyn} [levenshtein]`);
        expect(summary).toContain(`${fuzzyPhones.nickname} [nickname]`);

        const apply = await run(
            ['--company-id', fuzzyCompany, '--apply', '--fuzzy'],
            dependencies()
        );
        expect(apply.exit_code).toBe(0);
        expect(apply.failures).toEqual([]);
        expect(apply.contact_totals).toEqual({ before: 17, expected_after: 14, after: 14 });
        expect(apply.aggregate_apply_result).toMatchObject({
            merged_sets: 3,
            merged_donors: 3,
            skipped_sets: 5,
            failed_sets: 0,
        });
        for (const fixture of ['marilyn', 'kanny', 'nickname']) {
            const active = (await db.query(
                `SELECT COUNT(*)::int AS count
                   FROM contacts
                  WHERE company_id = $1
                    AND id = ANY($2::bigint[])
                    AND deleted_at IS NULL`,
                [fuzzyCompany, fuzzyIds[fixture]]
            )).rows[0].count;
            expect({ fixture, active }).toEqual({ fixture, active: 1 });
        }
        for (const fixture of ['gender', 'different', 'placeholder', 'multi', 'sabotage']) {
            const active = (await db.query(
                `SELECT COUNT(*)::int AS count
                   FROM contacts
                  WHERE company_id = $1
                    AND id = ANY($2::bigint[])
                    AND deleted_at IS NULL`,
                [fuzzyCompany, fuzzyIds[fixture]]
            )).rows[0].count;
            expect({ fixture, active }).toEqual({ fixture, active: fuzzyIds[fixture].length });
        }
    });

    test('dry-run is write-free; survivor = most-linked; apply is selective and rerun is a no-op', async () => {
        const beforeA = await companySnapshot(companyA);
        const beforeB = await companySnapshot(companyB);

        const dryRun = await run(
            ['--company-id', companyA, '--dry-run'],
            dependencies()
        );
        expect(dryRun.totals).toEqual({
            sets: 3,
            mergeable: 1,
            probable_household: 1,
            quarantine_blocked: 1,
            total_donors: 4,
        });
        expect(dryRun.contact_totals).toEqual({ before: 7, expected_after: 5, after: 7 });
        expect(await companySnapshot(companyA)).toBe(beforeA);
        expect(await companySnapshot(companyB)).toBe(beforeB);
        expect(fs.existsSync(dryRun.artifacts.json)).toBe(true);
        expect(fs.existsSync(dryRun.artifacts.summary)).toBe(true);

        const jsonPlan = JSON.parse(fs.readFileSync(dryRun.artifacts.json, 'utf8'));
        const cleanPlan = jsonPlan.sets.find(set => set.normalized_phone === cleanPhone);
        const householdPlan = jsonPlan.sets.find(set => set.normalized_phone === householdPhone);
        const stripePlan = jsonPlan.sets.find(set => set.normalized_phone === stripePhone);
        expect(cleanPlan.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(cleanPlan.disposition).toBe('mergeable');
        expect(String(cleanPlan.survivor.id)).toBe(String(ids.cleanWinner));
        expect(cleanPlan.survivor.business_link_count).toBe(3);
        expect(cleanPlan.donors).toHaveLength(2);
        expect(cleanPlan.donors.every(donor => donor.child_counts && donor.external_ids))
            .toBe(true);
        expect(cleanPlan.expected_post_state).toMatchObject({
            survivor_contact_id: ids.cleanWinner,
            donor_disposition: 'soft_deleted',
            donor_reference_count: 0,
        });
        expect(householdPlan).toMatchObject({
            disposition: 'probable_household',
            household: { probable_household: true, signal: 'clearly_different_names' },
        });
        expect(stripePlan.disposition).toBe('quarantine_blocked');
        expect(stripePlan.stripe_saved_card_blockers[0].type).toBe('stripe_customer_conflict');
        expect(stripePlan.stripe_saved_card_blockers[0].customers.some(
            customer => customer.saved_payment_method_count === 1
        )).toBe(true);

        const apply = await run(
            ['--company-id', companyA, '--apply'],
            dependencies()
        );
        expect(warningOutput).toHaveBeenCalledWith(expect.stringContaining(
            'pause the Zenbooker contact import'
        ));
        expect(apply.exit_code).toBe(0);
        expect(apply.failures).toEqual([]);
        expect(apply.contact_totals).toEqual({ before: 7, expected_after: 5, after: 5 });
        expect(apply.aggregate_apply_result).toMatchObject({
            merged_sets: 1,
            merged_donors: 2,
            skipped_sets: 2,
            failed_sets: 0,
            moved_external_identities: 2,
            moved_phone_rows: 2,
        });
        expect(apply.aggregate_apply_result.moved_child_counts).toMatchObject({
            jobs: 1,
            leads: 1,
            invoices: 1,
        });

        const cleanContacts = (await db.query(
            `SELECT id, deleted_at
               FROM contacts
              WHERE company_id = $1 AND id = ANY($2::bigint[])
              ORDER BY id`,
            [companyA, [ids.cleanOld, ids.cleanWinner, ids.cleanOther]]
        )).rows;
        expect(cleanContacts.find(row => String(row.id) === String(ids.cleanWinner)).deleted_at)
            .toBeNull();
        expect(cleanContacts.filter(row => String(row.id) !== String(ids.cleanWinner))
            .every(row => row.deleted_at)).toBe(true);
        const redirects = (await db.query(
            `SELECT old_contact_id, survivor_contact_id, status
               FROM contact_merge_redirects
              WHERE company_id = $1
              ORDER BY old_contact_id`,
            [companyA]
        )).rows;
        expect(redirects).toHaveLength(2);
        expect(redirects.every(row => row.status === 'merged'
            && String(row.survivor_contact_id) === String(ids.cleanWinner))).toBe(true);
        for (const table of ['jobs', 'leads', 'invoices']) {
            const { rows } = await db.query(
                `SELECT COUNT(*)::int AS count
                   FROM ${table}
                  WHERE company_id = $1 AND contact_id = ANY($2::bigint[])`,
                [companyA, [ids.cleanOld, ids.cleanOther]]
            );
            expect({ table, count: rows[0].count }).toEqual({ table, count: 0 });
        }
        const identityOwners = (await db.query(
            `SELECT DISTINCT contact_id
               FROM contact_external_identities
              WHERE company_id = $1 AND external_id LIKE $2`,
            [companyA, `zb-clean-%-${suffix}`]
        )).rows;
        expect(identityOwners.map(row => String(row.contact_id)))
            .toEqual([String(ids.cleanWinner)]);

        for (const contactIds of [
            [ids.householdOne, ids.householdTwo],
            [ids.stripeOne, ids.stripeTwo],
        ]) {
            const { rows } = await db.query(
                `SELECT COUNT(*)::int AS count
                   FROM contacts
                  WHERE company_id = $1
                    AND id = ANY($2::bigint[])
                    AND deleted_at IS NULL`,
                [companyA, contactIds]
            );
            expect(rows[0].count).toBe(2);
        }
        expect(await companySnapshot(companyB)).toBe(beforeB);

        const afterFirstApply = await companySnapshot(companyA);
        const rerun = await run(
            ['--company-id', companyA, '--apply'],
            dependencies()
        );
        expect(rerun.exit_code).toBe(0);
        expect(rerun.totals).toEqual({
            sets: 2,
            mergeable: 0,
            probable_household: 1,
            quarantine_blocked: 1,
            total_donors: 2,
        });
        expect(rerun.aggregate_apply_result).toMatchObject({
            merged_sets: 0,
            merged_donors: 0,
            skipped_sets: 2,
            failed_sets: 0,
        });
        expect(rerun.contact_totals).toEqual({ before: 5, expected_after: 5, after: 5 });
        expect(await companySnapshot(companyA)).toBe(afterFirstApply);
        expect(await companySnapshot(companyB)).toBe(beforeB);
    });

    afterAll(async () => {
        await db.query(
            'DELETE FROM companies WHERE id = ANY($1::uuid[])',
            [[companyA, companyB, fuzzyCompany]]
        ).catch(() => {});
        fs.rmSync(outputDirectory, { recursive: true, force: true });
        try { await db.pool.end(); } catch (_) { /* already closed */ }
    });
});
