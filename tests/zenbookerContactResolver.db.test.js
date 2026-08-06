'use strict';

process.env.FEATURE_ZENBOOKER_SYNC = 'true';

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const contactIdentityQueries = require('../backend/src/db/contactIdentityQueries');
const { resolveOrCreateContact } = require('../backend/src/services/contactResolverService');
const contactsService = require('../backend/src/services/contactsService');
const zenbookerSyncService = require('../backend/src/services/zenbookerSyncService');

jest.setTimeout(30000);

describe('ZB-DECOUPLE-001 B2 contact resolver against real PostgreSQL', () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const suffix = randomUUID();

    async function insertContact(companyId, fields = {}) {
        const { rows } = await db.query(
            `INSERT INTO contacts
                (company_id, full_name, first_name, last_name, company_name, title,
                 phone_e164, secondary_phone, email, notes, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                     COALESCE($11::timestamptz, NOW()))
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
                fields.email || null,
                fields.notes || null,
                fields.created_at || null,
            ]
        );
        return rows[0];
    }

    async function inventoryPhone(companyId, contactId, phone, opts = {}) {
        return contactIdentityQueries.upsertContactPhone({
            companyId,
            contactId,
            phoneE164: phone,
            isPrimary: true,
            ...opts,
        });
    }

    async function contactCount(companyId, where = '', params = []) {
        const { rows } = await db.query(
            `SELECT COUNT(*)::int AS count
             FROM contacts
             WHERE company_id = $1 ${where}`,
            [companyId, ...params]
        );
        return rows[0].count;
    }

    beforeAll(async () => {
        await db.query(
            `INSERT INTO companies (id, name, slug, status, timezone)
             VALUES ($1, 'B2 resolver A', $2, 'active', 'America/New_York'),
                    ($3, 'B2 resolver B', $4, 'active', 'America/New_York')`,
            [companyA, `b2-resolver-a-${suffix}`, companyB, `b2-resolver-b-${suffix}`]
        );
    });

    test('returning normalized-phone customer links, claims identity, fills blanks, and never steals non-blanks', async () => {
        const phone = '+1 (617) 555-1101';
        const existing = await insertContact(companyA, {
            full_name: 'Albusto Master Name',
            phone_e164: phone,
            email: 'owner@example.test',
        });
        await inventoryPhone(companyA, existing.id, phone);
        const before = await contactCount(companyA);

        const resolved = await contactsService.upsertFromZenbooker({
            id: `returning-${suffix}`,
            first_name: 'Zenbooker',
            last_name: 'Rename Attempt',
            phone: '617-555-1101',
            email: 'incoming@example.test',
        }, companyA);

        expect(resolved.id).toBe(existing.id);
        expect(await contactCount(companyA)).toBe(before);
        const { rows: [after] } = await db.query(
            `SELECT full_name, first_name, last_name, phone_e164, email
             FROM contacts WHERE company_id = $1 AND id = $2`,
            [companyA, existing.id]
        );
        expect(after).toEqual({
            full_name: 'Albusto Master Name',
            first_name: 'Zenbooker',
            last_name: 'Rename Attempt',
            phone_e164: phone,
            email: 'owner@example.test',
        });
        await expect(contactIdentityQueries.resolveExternalToContact(
            companyA, 'zenbooker', `returning-${suffix}`
        )).resolves.toBe(existing.id);
    });

    test('brand-new concurrent resolutions create exactly once and claim identity plus phone inventory', async () => {
        const externalId = `new-${suffix}`;
        const before = await contactCount(companyA);
        const input = {
            companyId: companyA,
            externalId,
            contact: { name: 'Brand New', phone: '+1 617 555 1102', email: 'new@example.test' },
        };

        const results = await Promise.all([
            resolveOrCreateContact(input),
            resolveOrCreateContact(input),
        ]);

        expect(new Set(results.map(result => String(result.contact_id))).size).toBe(1);
        expect(results.filter(result => result.created)).toHaveLength(1);
        expect(await contactCount(companyA)).toBe(before + 1);
        const contactId = results[0].contact_id;
        await expect(contactIdentityQueries.resolveExternalToContact(
            companyA, 'zenbooker', externalId
        )).resolves.toBe(contactId);
        await expect(contactIdentityQueries.listPhonesForContact(companyA, contactId))
            .resolves.toEqual([
                expect.objectContaining({
                    normalized_phone: '6175551102',
                    is_primary: true,
                    is_shared: false,
                }),
            ]);
    });

    test('a pre-B1 legacy Zenbooker id is claimed without creating a contact', async () => {
        const externalId = `legacy-${suffix}`;
        const existing = await insertContact(companyA, { full_name: 'Legacy Exact Owner' });
        await db.query(
            `UPDATE contacts
             SET zenbooker_customer_id = $1
             WHERE company_id = $2 AND id = $3`,
            [externalId, companyA, existing.id]
        );
        const before = await contactCount(companyA);

        const result = await resolveOrCreateContact({
            companyId: companyA,
            externalId,
            contact: { name: 'Name Must Not Matter' },
        });

        expect(result).toMatchObject({
            contact_id: existing.id,
            created: false,
            matched_by: 'external_id',
        });
        expect(await contactCount(companyA)).toBe(before);
        await expect(contactIdentityQueries.resolveExternalToContact(
            companyA, 'zenbooker', externalId
        )).resolves.toBe(existing.id);
    });

    test('a shared household number never auto-links and remains shared on the new contact inventory', async () => {
        const phone = '+1 617 555 1103';
        const householdOne = await insertContact(companyA, { full_name: 'Household One', phone_e164: phone });
        const householdTwo = await insertContact(companyA, { full_name: 'Household Two', phone_e164: phone });
        await inventoryPhone(companyA, householdOne.id, phone, { isShared: true });
        await inventoryPhone(companyA, householdTwo.id, phone, { isShared: true });
        await contactIdentityQueries.markPhoneShared(companyA, phone, true);
        const before = await contactCount(companyA);

        const result = await resolveOrCreateContact({
            companyId: companyA,
            externalId: `household-${suffix}`,
            contact: { name: 'Household Three', phone },
        });

        expect(result.created).toBe(true);
        expect([String(householdOne.id), String(householdTwo.id)])
            .not.toContain(String(result.contact_id));
        expect(await contactCount(companyA)).toBe(before + 1);
        const phones = await contactIdentityQueries.listPhonesForContact(companyA, result.contact_id);
        expect(phones).toHaveLength(1);
        expect(phones[0].is_shared).toBe(true);
    });

    test('multi-owner pre-merge phone resolves by business-links, completeness, age, then lowest id', async () => {
        const phone = '+1 617 555 1104';
        const complete = {
            first_name: 'Complete', last_name: 'Owner', company_name: 'Acme',
            title: 'Buyer', phone_e164: phone, email: 'complete@example.test', notes: 'Known',
            created_at: '2020-01-01T00:00:00.000Z',
        };
        const winner = await insertContact(companyA, { ...complete, full_name: 'Winner' });
        const sameScoreHigherId = await insertContact(companyA, { ...complete, full_name: 'Same Score' });
        const newer = await insertContact(companyA, {
            ...complete, full_name: 'Newer', email: 'newer@example.test',
            created_at: '2021-01-01T00:00:00.000Z',
        });
        const lessComplete = await insertContact(companyA, {
            full_name: 'Less Complete', phone_e164: phone,
            created_at: '2019-01-01T00:00:00.000Z',
        });
        const fewerLinks = await insertContact(companyA, {
            ...complete, full_name: 'Fewer Links', email: 'fewer@example.test',
            created_at: '2018-01-01T00:00:00.000Z',
        });
        const owners = [winner, sameScoreHigherId, newer, lessComplete, fewerLinks];
        for (const owner of owners) await inventoryPhone(companyA, owner.id, phone);
        for (const owner of [winner, sameScoreHigherId, newer, lessComplete]) {
            await db.query(
                `INSERT INTO jobs (company_id, contact_id, zenbooker_job_id)
                 VALUES ($1, $2, $3), ($1, $2, $4)`,
                [companyA, owner.id, `score-1-${owner.id}-${suffix}`, `score-2-${owner.id}-${suffix}`]
            );
        }
        await db.query(
            `INSERT INTO jobs (company_id, contact_id, zenbooker_job_id)
             VALUES ($1, $2, $3)`,
            [companyA, fewerLinks.id, `score-1-${fewerLinks.id}-${suffix}`]
        );

        const result = await resolveOrCreateContact({
            companyId: companyA,
            externalId: `multi-${suffix}`,
            contact: { name: 'Ignored Name', phone },
        });

        expect(result).toMatchObject({
            contact_id: winner.id,
            created: false,
            matched_by: 'phone_survivor',
        });
        expect(Number(winner.id)).toBeLessThan(Number(sameScoreHigherId.id));
    });

    test('foreign external id and phone never resolve across tenants and the foreign row is unchanged', async () => {
        const phone = '+1 617 555 1105';
        const externalId = `tenant-shared-${suffix}`;
        const foreign = await insertContact(companyB, {
            full_name: 'Foreign Owner', phone_e164: phone, email: 'foreign@example.test',
        });
        await inventoryPhone(companyB, foreign.id, phone);
        await contactIdentityQueries.upsertExternalIdentity({
            companyId: companyB,
            source: 'zenbooker',
            externalId,
            contactId: foreign.id,
        });
        await db.query(
            `UPDATE contacts
             SET zenbooker_customer_id = $1
             WHERE company_id = $2 AND id = $3`,
            [externalId, companyB, foreign.id]
        );
        const { rows: [before] } = await db.query(
            'SELECT to_jsonb(contact.*) AS value FROM contacts contact WHERE id = $1 AND company_id = $2',
            [foreign.id, companyB]
        );

        const local = await resolveOrCreateContact({
            companyId: companyA,
            externalId,
            contact: { name: 'Local Owner', phone },
        });

        expect(String(local.contact_id)).not.toBe(String(foreign.id));
        expect(local.created).toBe(true);
        await expect(contactIdentityQueries.resolveExternalToContact(companyA, 'zenbooker', externalId))
            .resolves.toBe(local.contact_id);
        await expect(contactIdentityQueries.resolveExternalToContact(companyB, 'zenbooker', externalId))
            .resolves.toBe(foreign.id);
        const { rows: [localRow] } = await db.query(
            'SELECT zenbooker_customer_id FROM contacts WHERE company_id = $1 AND id = $2',
            [companyA, local.contact_id]
        );
        expect(localRow.zenbooker_customer_id).toBeNull();
        const { rows: [after] } = await db.query(
            'SELECT to_jsonb(contact.*) AS value FROM contacts contact WHERE id = $1 AND company_id = $2',
            [foreign.id, companyB]
        );
        expect(after.value).toEqual(before.value);
    });

    test('unique email links when no non-shared phone owner exists', async () => {
        const existing = await insertContact(companyA, {
            full_name: 'Email Owner', email: 'email-owner@example.test',
        });
        const before = await contactCount(companyA);

        const result = await resolveOrCreateContact({
            companyId: companyA,
            externalId: `email-${suffix}`,
            contact: { name: 'Different Name', email: ' EMAIL-OWNER@example.test ' },
        });

        expect(result).toMatchObject({ contact_id: existing.id, created: false, matched_by: 'email' });
        expect(await contactCount(companyA)).toBe(before);
    });

    test('name alone never links an existing contact', async () => {
        const existing = await insertContact(companyA, { full_name: 'Same Name Only' });
        const before = await contactCount(companyA);

        const result = await resolveOrCreateContact({
            companyId: companyA,
            externalId: `name-only-${suffix}`,
            contact: { name: 'Same Name Only' },
        });

        expect(result.created).toBe(true);
        expect(String(result.contact_id)).not.toBe(String(existing.id));
        expect(await contactCount(companyA)).toBe(before + 1);
    });

    test('same webhook twice is idempotent: one contact, one identity, one phone row', async () => {
        const externalId = `webhook-${suffix}`;
        const payload = {
            event: 'customer.edited',
            account: `account-${suffix}`,
            data: {
                id: externalId,
                name: 'Webhook Customer',
                phone: '+1 617 555 1106',
                email: 'webhook@example.test',
            },
        };

        const first = await zenbookerSyncService.handleWebhookPayload(payload, companyA);
        const second = await zenbookerSyncService.handleWebhookPayload(payload, companyA);

        expect(second.contact_id).toBe(first.contact_id);
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        const { rows: [counts] } = await db.query(
            `SELECT
                (SELECT COUNT(*)::int FROM contacts
                 WHERE company_id = $1 AND id = $2) AS contacts,
                (SELECT COUNT(*)::int FROM contact_external_identities
                 WHERE company_id = $1 AND source = 'zenbooker' AND external_id = $3) AS identities,
                (SELECT COUNT(*)::int FROM contact_phones
                 WHERE company_id = $1 AND contact_id = $2) AS phones`,
            [companyA, first.contact_id, externalId]
        );
        expect(counts).toEqual({ contacts: 1, identities: 1, phones: 1 });
    });

    afterAll(async () => {
        await db.query(
            'DELETE FROM companies WHERE id = ANY($1::uuid[])',
            [[companyA, companyB]]
        ).catch(() => {});
        try { await db.pool.end(); } catch (_) { /* already closed */ }
    });
});
