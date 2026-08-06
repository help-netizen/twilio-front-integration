/**
 * ZB-DECOUPLE-001 Phase B / B2 — one tenant-scoped contact resolver for
 * Zenbooker imports. It chooses the contact; callers retain responsibility for
 * fill-empty enrichment and their existing notes/address side effects.
 */

'use strict';

const db = require('../db/connection');
const contactIdentityQueries = require('../db/contactIdentityQueries');
const { toE164 } = require('../utils/phoneUtils');

function normalizeEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    return email.includes('@') ? email : null;
}

function contactNames(details) {
    let firstName = String(details.first_name || '').trim() || null;
    let lastName = String(details.last_name || '').trim() || null;
    let fullName = String(details.full_name || details.name || '').trim() || null;

    if (!firstName && !lastName && fullName) {
        const parts = fullName.split(/\s+/);
        firstName = parts[0] || null;
        lastName = parts.length > 1 ? parts.slice(1).join(' ') : null;
    }
    if (!fullName && (firstName || lastName)) {
        fullName = [firstName, lastName].filter(Boolean).join(' ');
    }
    return { firstName, lastName, fullName };
}

function contactPhones(details) {
    const candidates = [
        { value: details.phone || details.phone_e164, label: null, isPrimary: true },
        {
            value: details.secondary_phone,
            label: details.secondary_phone_name || null,
            isPrimary: false,
        },
    ];
    const seen = new Set();
    return candidates.flatMap(candidate => {
        const normalized = contactIdentityQueries.normalizePhone(candidate.value);
        if (!normalized || seen.has(normalized)) return [];
        seen.add(normalized);
        return [{
            ...candidate,
            value: toE164(candidate.value) || String(candidate.value).trim(),
            normalized,
        }];
    });
}

async function findEmailOwners(client, companyId, email) {
    if (!email) return [];
    const { rows } = await client.query(
        `SELECT DISTINCT owner.id
         FROM contacts owner
         LEFT JOIN contact_emails contact_email
           ON contact_email.contact_id = owner.id
         WHERE owner.company_id = $1
           AND owner.deleted_at IS NULL
           AND (
               LOWER(BTRIM(COALESCE(owner.email, ''))) = $2
               OR contact_email.email_normalized = $2
           )
         ORDER BY owner.id ASC`,
        [companyId, email]
    );
    return rows.map(row => row.id);
}

async function chooseSurvivor(client, companyId, contactIds) {
    const { rows } = await client.query(
        `SELECT candidate.id
         FROM (
             SELECT contact.id,
                    contact.created_at,
                    (
                        (SELECT COUNT(*) FROM jobs row_ref
                         WHERE row_ref.company_id = $1 AND row_ref.contact_id = contact.id) +
                        (SELECT COUNT(*) FROM leads row_ref
                         WHERE row_ref.company_id = $1 AND row_ref.contact_id = contact.id) +
                        (SELECT COUNT(*) FROM estimates row_ref
                         WHERE row_ref.company_id = $1 AND row_ref.contact_id = contact.id) +
                        (SELECT COUNT(*) FROM invoices row_ref
                         WHERE row_ref.company_id = $1 AND row_ref.contact_id = contact.id) +
                        (SELECT COUNT(*) FROM crm_account_contacts row_ref
                         WHERE row_ref.company_id = $1 AND row_ref.contact_id = contact.id) +
                        (SELECT COUNT(*) FROM crm_deal_contacts row_ref
                         WHERE row_ref.company_id = $1 AND row_ref.contact_id = contact.id)
                    ) AS business_links,
                    (CASE WHEN NULLIF(BTRIM(contact.full_name), '') IS NULL THEN 0 ELSE 1 END +
                     CASE WHEN NULLIF(BTRIM(contact.first_name), '') IS NULL THEN 0 ELSE 1 END +
                     CASE WHEN NULLIF(BTRIM(contact.last_name), '') IS NULL THEN 0 ELSE 1 END +
                     CASE WHEN NULLIF(BTRIM(contact.company_name), '') IS NULL THEN 0 ELSE 1 END +
                     CASE WHEN NULLIF(BTRIM(contact.title), '') IS NULL THEN 0 ELSE 1 END +
                     CASE WHEN NULLIF(BTRIM(contact.phone_e164), '') IS NULL THEN 0 ELSE 1 END +
                     CASE WHEN NULLIF(BTRIM(contact.secondary_phone), '') IS NULL THEN 0 ELSE 1 END +
                     CASE WHEN NULLIF(BTRIM(contact.email), '') IS NULL THEN 0 ELSE 1 END +
                     CASE WHEN NULLIF(BTRIM(contact.notes), '') IS NULL THEN 0 ELSE 1 END
                    ) AS completeness
             FROM contacts contact
             WHERE contact.company_id = $1
               AND contact.deleted_at IS NULL
               AND contact.id = ANY($2::bigint[])
         ) candidate
         ORDER BY candidate.business_links DESC,
                  candidate.completeness DESC,
                  candidate.created_at ASC NULLS LAST,
                  candidate.id ASC
         LIMIT 1`,
        [companyId, contactIds]
    );
    return rows[0]?.id || null;
}

async function createContact(client, companyId, details, phones, email) {
    const { firstName, lastName, fullName } = contactNames(details);
    const primaryPhone = phones.find(phone => phone.isPrimary)?.value || null;
    const secondaryPhone = phones.find(phone => !phone.isPrimary)?.value || null;
    const secondaryPhoneName = phones.find(phone => !phone.isPrimary)?.label || null;
    const { rows } = await client.query(
        `INSERT INTO contacts
            (company_id, full_name, first_name, last_name, phone_e164,
             secondary_phone, secondary_phone_name, email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
            companyId,
            fullName,
            firstName,
            lastName,
            primaryPhone,
            secondaryPhone,
            secondaryPhoneName,
            email,
        ]
    );
    return rows[0].id;
}

async function claimLegacyZenbookerId(client, companyId, contactId, externalId) {
    await client.query('SAVEPOINT contact_resolver_legacy_id');
    try {
        await client.query(
            `UPDATE contacts
             SET zenbooker_customer_id = $3
             WHERE company_id = $1
               AND id = $2
               AND NULLIF(BTRIM(zenbooker_customer_id), '') IS NULL`,
            [companyId, contactId, externalId]
        );
    } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT contact_resolver_legacy_id');
        if (error.code !== '23505') throw error;
        // The legacy column still has a global unique index. The new identity
        // table is tenant-scoped and authoritative, so a foreign tenant using
        // the same external id must not block this resolver transaction.
    } finally {
        await client.query('RELEASE SAVEPOINT contact_resolver_legacy_id');
    }
}

/**
 * Resolve exact external identity → non-shared phone → unique email → create.
 * The advisory transaction lock makes resolve→create and all identity claims a
 * single per-company critical section, including concurrent webhook retries.
 */
async function resolveOrCreateContact({
    companyId,
    externalId,
    source = 'zenbooker',
    contact = {},
}) {
    if (!companyId) {
        throw Object.assign(new Error('Tenant context required'), {
            code: 'TENANT_CONTEXT_REQUIRED',
            httpStatus: 403,
        });
    }
    const normalizedExternalId = String(externalId || '').trim();
    if (!normalizedExternalId) {
        throw Object.assign(new Error('External contact id is required'), {
            code: 'EXTERNAL_ID_REQUIRED',
            httpStatus: 400,
        });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [`contact-resolver:${companyId}`]
        );

        const phones = contactPhones(contact);
        const email = normalizeEmail(contact.email);
        const sharedPhones = new Set();
        let contactId = await contactIdentityQueries.resolveExternalToContact(
            companyId,
            source,
            normalizedExternalId,
            client
        );
        let matchedBy = contactId ? 'external_id' : null;
        let created = false;

        // B1's map is authoritative. This company-scoped compatibility bridge
        // claims pre-B1 rows on first touch so a contact with only the legacy
        // scalar id cannot be duplicated during a phased rollout.
        if (!contactId && source === 'zenbooker') {
            const { rows: legacyRows } = await client.query(
                `SELECT id
                 FROM contacts
                 WHERE company_id = $1
                   AND zenbooker_customer_id = $2
                   AND deleted_at IS NULL
                 LIMIT 1
                 FOR UPDATE`,
                [companyId, normalizedExternalId]
            );
            if (legacyRows[0]) {
                contactId = legacyRows[0].id;
                matchedBy = 'external_id';
            }
        }

        if (!contactId) {
            const phoneOwners = new Set();
            for (const phone of phones) {
                const [nonSharedOwners, allOwners] = await Promise.all([
                    contactIdentityQueries.findContactIdsByNormalizedPhone(
                        companyId,
                        phone.normalized,
                        { includeShared: false, client }
                    ),
                    contactIdentityQueries.findContactIdsByNormalizedPhone(
                        companyId,
                        phone.normalized,
                        { includeShared: true, client }
                    ),
                ]);
                if (allOwners.length > nonSharedOwners.length) {
                    sharedPhones.add(phone.normalized);
                    continue;
                }
                nonSharedOwners.forEach(ownerId => phoneOwners.add(String(ownerId)));
            }

            if (phoneOwners.size === 1) {
                [contactId] = [...phoneOwners];
                matchedBy = 'phone';
            } else if (phoneOwners.size > 1) {
                contactId = await chooseSurvivor(client, companyId, [...phoneOwners]);
                matchedBy = 'phone_survivor';
            }
        }

        if (!contactId) {
            const emailOwners = await findEmailOwners(client, companyId, email);
            if (emailOwners.length === 1) {
                [contactId] = emailOwners;
                matchedBy = 'email';
            }
        }

        if (!contactId) {
            contactId = await createContact(client, companyId, contact, phones, email);
            created = true;
            matchedBy = 'created';
        }

        const identity = await contactIdentityQueries.upsertExternalIdentity({
            companyId,
            source,
            externalId: normalizedExternalId,
            contactId,
            client,
        });
        if (!identity) throw new Error('Unable to claim contact external identity');

        if (String(identity.contact_id) !== String(contactId)) {
            if (created) {
                await client.query(
                    'DELETE FROM contacts WHERE company_id = $1 AND id = $2',
                    [companyId, contactId]
                );
                created = false;
            }
            contactId = identity.contact_id;
            matchedBy = 'external_id';
        }

        if (source === 'zenbooker') {
            await claimLegacyZenbookerId(
                client,
                companyId,
                contactId,
                normalizedExternalId
            );
        }

        for (const phone of phones) {
            const isShared = sharedPhones.has(phone.normalized);
            await contactIdentityQueries.upsertContactPhone({
                companyId,
                contactId,
                phoneE164: phone.value,
                label: phone.label,
                isPrimary: phone.isPrimary,
                isShared,
                client,
            });
            if (isShared) {
                await contactIdentityQueries.markPhoneShared(
                    companyId,
                    phone.normalized,
                    true,
                    client
                );
            }
        }

        await client.query('COMMIT');
        return { contact_id: contactId, created, matched_by: matchedBy };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    resolveOrCreateContact,
};
