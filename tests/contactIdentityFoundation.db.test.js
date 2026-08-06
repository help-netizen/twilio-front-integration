'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const q = require('../backend/src/db/contactIdentityQueries');

jest.setTimeout(30000);

describe('contact identity foundation against real PostgreSQL', () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const suffix = randomUUID();
    const sharedOwnerPhone = '6175550101';
    const householdPhone = '6175550202';
    let contactA1;
    let contactA2;
    let contactAShared;
    let contactABackfill;
    let contactB;

    beforeAll(async () => {
        await db.query(
            `INSERT INTO companies (id, name, slug, status, timezone)
             VALUES ($1, 'Contact identity A', $2, 'active', 'America/New_York'),
                    ($3, 'Contact identity B', $4, 'active', 'America/New_York')`,
            [companyA, `contact-identity-a-${suffix}`, companyB, `contact-identity-b-${suffix}`]
        );

        const inserted = await db.query(
            `INSERT INTO contacts
                (company_id, full_name, phone_e164, secondary_phone, secondary_phone_name)
             VALUES
                ($1, 'A phone owner one', '+1 (617) 555-0101', NULL, NULL),
                ($1, 'A phone owner two', '617.555.0101', NULL, NULL),
                ($1, 'A shared household', '+1 617-555-0202', NULL, NULL),
                ($1, 'A two-slot backfill', '+1 (781) 555-0303',
                     '+1 (857) 555-0404', 'Office'),
                ($2, 'B same phone owner', '1-617-555-0101', NULL, NULL)
             RETURNING id, full_name`,
            [companyA, companyB]
        );
        const contacts = new Map(inserted.rows.map(row => [row.full_name, row.id]));
        contactA1 = contacts.get('A phone owner one');
        contactA2 = contacts.get('A phone owner two');
        contactAShared = contacts.get('A shared household');
        contactABackfill = contacts.get('A two-slot backfill');
        contactB = contacts.get('B same phone owner');

        // Replay migration 241 after these fixtures exist: the guarded backfill is
        // what must inventory both legacy scalar phone slots.
        const migration = fs.readFileSync(path.join(
            __dirname,
            '../backend/db/migrations/242_contact_identity_foundation.sql'
        ), 'utf8');
        await db.query(migration);

        await q.markPhoneShared(companyA, householdPhone, true);
        await q.upsertExternalIdentity({
            companyId: companyA,
            source: 'zenbooker',
            externalId: `zb-shared-${suffix}`,
            contactId: contactA1,
        });
        await q.upsertExternalIdentity({
            companyId: companyB,
            source: 'zenbooker',
            externalId: `zb-shared-${suffix}`,
            contactId: contactB,
        });
        await q.upsertExternalIdentity({
            companyId: companyB,
            source: 'zenbooker',
            externalId: `zb-only-b-${suffix}`,
            contactId: contactB,
        });
    });

    test('external identity upsert and both resolvers round-trip within each company', async () => {
        await expect(q.resolveExternalToContact(
            companyA, 'zenbooker', `zb-shared-${suffix}`
        )).resolves.toBe(contactA1);
        await expect(q.resolveExternalToContact(
            companyB, 'zenbooker', `zb-shared-${suffix}`
        )).resolves.toBe(contactB);
        await expect(q.resolveContactToExternal(companyA, 'zenbooker', contactA1))
            .resolves.toBe(`zb-shared-${suffix}`);

        const original = await q.upsertExternalIdentity({
            companyId: companyA,
            source: 'zenbooker',
            externalId: `zb-shared-${suffix}`,
            contactId: contactA2,
        });
        expect(original.contact_id).toBe(contactA1);
    });

    test('external resolver never crosses into a foreign company', async () => {
        await expect(q.resolveExternalToContact(
            companyA, 'zenbooker', `zb-only-b-${suffix}`
        )).resolves.toBeNull();
    });

    test('same-phone lookup returns every local owner and never the foreign owner', async () => {
        const contactIds = await q.findContactIdsByNormalizedPhone(companyA, sharedOwnerPhone);
        expect(contactIds).toEqual([contactA1, contactA2].sort((a, b) => Number(a) - Number(b)));
        expect(contactIds).not.toContain(contactB);
    });

    test('shared phone rows are excluded by default and included only on request', async () => {
        await expect(q.findContactIdsByNormalizedPhone(companyA, householdPhone))
            .resolves.toEqual([]);
        await expect(q.findContactIdsByNormalizedPhone(
            companyA, householdPhone, { includeShared: true }
        )).resolves.toEqual([contactAShared]);
    });

    test('migration backfill inventories both scalar slots with normalized values', async () => {
        const phones = await q.listPhonesForContact(companyA, contactABackfill);
        expect(phones).toHaveLength(2);
        expect(phones.map(phone => ({
            phone_e164: phone.phone_e164,
            normalized_phone: phone.normalized_phone,
            label: phone.label,
            is_primary: phone.is_primary,
        }))).toEqual([
            {
                phone_e164: '+1 (781) 555-0303',
                normalized_phone: '7815550303',
                label: null,
                is_primary: true,
            },
            {
                phone_e164: '+1 (857) 555-0404',
                normalized_phone: '8575550404',
                label: 'Office',
                is_primary: false,
            },
        ]);
    });

    test('phone upsert is normalized, idempotent, and rejects a foreign contact target', async () => {
        const input = {
            companyId: companyA,
            contactId: contactA1,
            phoneE164: '+1 (339) 555-0505',
            label: 'Mobile',
            isPrimary: false,
        };
        const first = await q.upsertContactPhone(input);
        const second = await q.upsertContactPhone(input);
        expect(first.id).toBe(second.id);
        expect(first.normalized_phone).toBe('3395550505');

        const phones = await q.listPhonesForContact(companyA, contactA1);
        expect(phones.filter(phone => phone.normalized_phone === '3395550505')).toHaveLength(1);
        await expect(q.upsertContactPhone({ ...input, contactId: contactB }))
            .resolves.toBeNull();
    });

    afterAll(async () => {
        await db.query(
            'DELETE FROM contacts WHERE company_id = ANY($1::uuid[])',
            [[companyA, companyB]]
        ).catch(() => {});
        await db.query(
            'DELETE FROM companies WHERE id = ANY($1::uuid[])',
            [[companyA, companyB]]
        ).catch(() => {});
        try { await db.pool.end(); } catch (_) { /* already closed */ }
    });
});
