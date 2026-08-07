'use strict';

/**
 * ZB-DECOUPLE-001 Phase B / B4.
 *
 * Plans and, only with an explicit --apply, executes lossless duplicate-contact
 * merges for one company. Discovery and reporting live here; all mutations are
 * delegated to B3's contactEmailMergeService.mergeContacts.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const connectionDb = require('../backend/src/db/connection');
const mergeService = require('../backend/src/services/contactEmailMergeService');

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NORMALIZED_PHONE_SHAPE = /^[0-9]{10}$/;
const PLAN_VERSION = 1;
const MAX_FUZZY_NAME_DISTANCE = 2;
const BUSINESS_LINK_KEYS = [
    'jobs',
    'leads',
    'invoices',
    'estimates',
    'payment_transactions',
    'tasks',
];
// Keep this identical to the B2 survivor-completeness definition. B4 does not
// change the live resolver; it merely uses the same frozen contact scalars.
const COMPLETENESS_SCALARS = [
    'full_name',
    'first_name',
    'last_name',
    'company_name',
    'title',
    'phone_e164',
    'secondary_phone',
    'email',
    'notes',
];
const CONFLICT_SCALARS = [
    ...COMPLETENESS_SCALARS,
    'secondary_phone_name',
    'zenbooker_customer_id',
];
const CONTACT_SELECT_COLUMNS = [
    'id',
    'company_id',
    'full_name',
    'first_name',
    'last_name',
    'company_name',
    'title',
    'phone_e164',
    'secondary_phone',
    'secondary_phone_name',
    'email',
    'notes',
    'structured_notes',
    'zenbooker_customer_id',
    'created_at',
    'updated_at',
    'deleted_at',
];

const DISCOVERY_CTE = `
    WITH raw_phone_claims AS (
        SELECT contact.company_id,
               contact.id AS contact_id,
               RIGHT(REGEXP_REPLACE(phone.value, '[^0-9]', '', 'g'), 10) AS normalized_phone
          FROM contacts contact
          CROSS JOIN LATERAL (VALUES (contact.phone_e164), (contact.secondary_phone)) phone(value)
         WHERE contact.company_id = $1
           AND contact.deleted_at IS NULL
           AND NULLIF(BTRIM(phone.value), '') IS NOT NULL
           AND LENGTH(REGEXP_REPLACE(phone.value, '[^0-9]', '', 'g')) >= 10
        UNION
        SELECT contact.company_id, contact.id, inventory.normalized_phone
          FROM contacts contact
          JOIN contact_phones inventory
            ON inventory.company_id = contact.company_id
           AND inventory.contact_id = contact.id
         WHERE contact.company_id = $1
           AND contact.deleted_at IS NULL
           AND inventory.normalized_phone ~ '^[0-9]{10}$'
    ), eligible_claims AS (
        SELECT DISTINCT claim.contact_id, claim.normalized_phone
          FROM raw_phone_claims claim
          LEFT JOIN contact_phones shared
            ON shared.company_id = $1
           AND shared.normalized_phone = claim.normalized_phone
           AND shared.is_shared = TRUE
         WHERE shared.id IS NULL
    )`;

class BulkMergeError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'BulkMergeError';
        this.code = code;
    }
}

function isBlank(value) {
    return value === null || value === undefined || String(value).trim() === '';
}

function normalizePhone(value) {
    const digits = String(value || '').replace(/[^0-9]/g, '');
    return digits.length >= 10 ? digits.slice(-10) : null;
}

function parseArgs(argv) {
    const parsed = {
        companyId: null,
        dryRun: false,
        apply: false,
        fuzzy: false,
        limit: null,
        set: null,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--dry-run') parsed.dryRun = true;
        else if (arg === '--apply') parsed.apply = true;
        else if (arg === '--fuzzy') parsed.fuzzy = true;
        else if (arg === '--company-id') {
            parsed.companyId = argv[index + 1] || null;
            index += 1;
        } else if (arg.startsWith('--company-id=')) {
            parsed.companyId = arg.slice('--company-id='.length);
        } else if (arg === '--limit') {
            parsed.limit = argv[index + 1] || null;
            index += 1;
        } else if (arg.startsWith('--limit=')) {
            parsed.limit = arg.slice('--limit='.length);
        } else if (arg === '--set') {
            parsed.set = argv[index + 1] || null;
            index += 1;
        } else if (arg.startsWith('--set=')) {
            parsed.set = arg.slice('--set='.length);
        } else {
            throw new BulkMergeError('INVALID_ARGUMENT', `Unknown argument: ${arg}`);
        }
    }

    if (!UUID_SHAPE.test(parsed.companyId || '')) {
        throw new BulkMergeError('COMPANY_REQUIRED', '--company-id <uuid> is required');
    }
    if (parsed.apply === parsed.dryRun) {
        throw new BulkMergeError(
            'MODE_REQUIRED',
            'Choose exactly one explicit mode: --dry-run or --apply'
        );
    }
    if (parsed.limit !== null) {
        if (!/^[1-9][0-9]*$/.test(String(parsed.limit))) {
            throw new BulkMergeError('INVALID_LIMIT', '--limit must be a positive integer');
        }
        parsed.limit = Number(parsed.limit);
        if (!Number.isSafeInteger(parsed.limit)) {
            throw new BulkMergeError('INVALID_LIMIT', '--limit is too large');
        }
    }
    if (parsed.set !== null && !NORMALIZED_PHONE_SHAPE.test(String(parsed.set))) {
        throw new BulkMergeError(
            'INVALID_SET',
            '--set must be one normalized 10-digit phone number'
        );
    }
    return parsed;
}

function stableJson(value) {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${stableJson(value[key])}`
        ).join(',')}}`;
    }
    return JSON.stringify(value);
}

function fingerprint(value) {
    return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function compareIds(left, right) {
    const a = BigInt(String(left));
    const b = BigInt(String(right));
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareSurvivorCandidates(left, right) {
    if (left.business_link_count !== right.business_link_count) {
        return right.business_link_count - left.business_link_count;
    }
    if (left.completeness_count !== right.completeness_count) {
        return right.completeness_count - left.completeness_count;
    }
    const leftCreated = left.created_at ? new Date(left.created_at).getTime() : Number.POSITIVE_INFINITY;
    const rightCreated = right.created_at ? new Date(right.created_at).getTime() : Number.POSITIVE_INFINITY;
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    return compareIds(left.id, right.id);
}

function chooseSurvivor(candidates) {
    return [...candidates].sort(compareSurvivorCandidates)[0] || null;
}

function normalizeNameParts(value) {
    return String(value || '')
        .normalize('NFKD')
        .toLocaleLowerCase('en-US')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

const NAME_PREFIXES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr']);
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
const FUZZY_NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii']);
const PLACEHOLDER_NAMES = new Set([
    'customer',
    'customer notes',
    'n a',
    'na',
    'no name',
    'none',
    'placeholder',
    'test',
    'test customer',
    'unknown',
    'unknown customer',
]);
const PLACEHOLDER_GIVEN_NAMES = new Set(['customer', 'placeholder', 'test', 'unknown']);
const GENDERING_SUFFIXES = ['ette', 'ina', 'tte', 'ne', 'a', 'e'];
const NICKNAME_PAIRS = [
    ['judy', 'judith'],
    ['mike', 'michael'],
    ['bob', 'robert'],
    ['jim', 'james'],
    ['bill', 'william'],
    ['dave', 'david'],
    ['tom', 'thomas'],
    ['kathy', 'katherine'],
    ['liz', 'elizabeth'],
    ['dan', 'daniel'],
    ['chris', 'christopher'],
    ['joe', 'joseph'],
    ['sue', 'susan'],
    ['rick', 'richard'],
    ['steve', 'steven'],
];
const NICKNAME_LOOKUP = new Set(NICKNAME_PAIRS.flatMap(([left, right]) => [
    `${left}:${right}`,
    `${right}:${left}`,
]));

function nameIdentity(contact) {
    let given = normalizeNameParts(contact.first_name);
    let family = normalizeNameParts(contact.last_name);
    let tokens = normalizeNameParts(contact.full_name);
    if (tokens[0] && NAME_PREFIXES.has(tokens[0])) tokens = tokens.slice(1);
    if (tokens.at(-1) && NAME_SUFFIXES.has(tokens.at(-1))) tokens = tokens.slice(0, -1);

    if (given.length === 0 && family.length === 0 && tokens.length > 0) {
        const raw = String(contact.full_name || '');
        if (raw.includes(',')) {
            const [familyRaw, ...givenRaw] = raw.split(',');
            family = normalizeNameParts(familyRaw);
            given = normalizeNameParts(givenRaw.join(' '));
        } else if (tokens.length === 1) {
            given = tokens;
        } else {
            given = tokens.slice(0, -1);
            family = tokens.slice(-1);
        }
    }
    if (tokens.length === 0) tokens = [...given, ...family];
    const uniqueTokens = [...new Set(tokens)].sort();
    return {
        contact_id: contact.id,
        name: contact.full_name || [contact.first_name, contact.last_name].filter(Boolean).join(' ') || null,
        given: given[0] || null,
        family: family.at(-1) || null,
        tokens: uniqueTokens,
    };
}

function tokenSubset(left, right) {
    const rightSet = new Set(right);
    return left.every(token => rightSet.has(token));
}

function namesClearlyDifferent(left, right) {
    if (left.tokens.length === 0 || right.tokens.length === 0) return false;
    if (stableJson(left.tokens) === stableJson(right.tokens)) return false;
    if (tokenSubset(left.tokens, right.tokens) || tokenSubset(right.tokens, left.tokens)) return false;

    const sameGiven = left.given && right.given && left.given === right.given;
    const sameFamily = left.family && right.family && left.family === right.family;
    const initialVariant = left.given && right.given
        && left.given[0] === right.given[0]
        && (left.given.length === 1 || right.given.length === 1);
    if (sameGiven && sameFamily) return false;
    if (sameFamily && initialVariant) return false;
    if (sameFamily && left.given && right.given && !sameGiven) return true;
    if (left.given && right.given && left.family && right.family && !sameGiven && !sameFamily) {
        return true;
    }
    return !left.tokens.some(token => right.tokens.includes(token));
}

function nameDivergence(contacts) {
    const identities = contacts.map(nameIdentity);
    const divergentPairs = [];
    for (let leftIndex = 0; leftIndex < identities.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < identities.length; rightIndex += 1) {
            const left = identities[leftIndex];
            const right = identities[rightIndex];
            if (namesClearlyDifferent(left, right)) {
                divergentPairs.push({
                    contact_ids: [left.contact_id, right.contact_id],
                    names: [left.name, right.name],
                });
            }
        }
    }
    return {
        probable_household: divergentPairs.length > 0,
        signal: divergentPairs.length > 0 ? 'clearly_different_names' : 'consistent_or_unknown_names',
        members: identities.map(identity => ({
            contact_id: identity.contact_id,
            name: identity.name,
        })),
        divergent_pairs: divergentPairs,
    };
}

function fuzzyNameIdentity(contact) {
    const rawName = !isBlank(contact.full_name)
        ? contact.full_name
        : [contact.first_name, contact.last_name].filter(value => !isBlank(value)).join(' ');
    const tokens = normalizeNameParts(rawName);
    if (tokens.at(-1) && FUZZY_NAME_SUFFIXES.has(tokens.at(-1))) tokens.pop();

    const ordinaryIdentity = nameIdentity(contact);
    return {
        full: tokens.join(' '),
        given: ordinaryIdentity.given,
        family: ordinaryIdentity.family,
    };
}

function isPlaceholderName(identity) {
    return !identity.full
        || PLACEHOLDER_NAMES.has(identity.full)
        || PLACEHOLDER_GIVEN_NAMES.has(identity.given);
}

function levenshteinDistance(left, right) {
    if (left === right) return 0;
    if (left.length === 0) return right.length;
    if (right.length === 0) return left.length;

    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            current[rightIndex] = Math.min(
                current[rightIndex - 1] + 1,
                previous[rightIndex] + 1,
                previous[rightIndex - 1]
                    + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
            );
        }
        previous = current;
    }
    return previous[right.length];
}

function stripGenderingSuffix(name, suffix) {
    if (!name.endsWith(suffix) || name.length === suffix.length) return null;
    return name.slice(0, -suffix.length);
}

function isGenderVariant(left, right) {
    if (!left || !right || left === right) return false;
    const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
    for (const suffix of GENDERING_SUFFIXES) {
        if (longer === `${shorter}${suffix}`) return true;
        if (longer === `${shorter}${shorter.at(-1)}${suffix}`) return true;
    }
    for (const leftSuffix of GENDERING_SUFFIXES) {
        const leftRoot = stripGenderingSuffix(left, leftSuffix);
        if (!leftRoot) continue;
        for (const rightSuffix of GENDERING_SUFFIXES) {
            if (leftSuffix === rightSuffix) continue;
            const rightRoot = stripGenderingSuffix(right, rightSuffix);
            if (rightRoot && leftRoot === rightRoot) return true;
        }
    }
    return false;
}

function fuzzyPairReason(left, right) {
    if (isPlaceholderName(left) || isPlaceholderName(right)) return null;
    if (isGenderVariant(left.given, right.given)) return null;

    if (levenshteinDistance(left.full, right.full) <= MAX_FUZZY_NAME_DISTANCE) {
        return 'levenshtein';
    }
    if (left.family && left.family === right.family
        && left.given && right.given
        && NICKNAME_LOOKUP.has(`${left.given}:${right.given}`)) {
        return 'nickname';
    }
    return null;
}

function fuzzySetReason(contacts) {
    const identities = contacts.map(fuzzyNameIdentity);
    let nicknameRequired = false;
    for (let leftIndex = 0; leftIndex < identities.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < identities.length; rightIndex += 1) {
            const reason = fuzzyPairReason(identities[leftIndex], identities[rightIndex]);
            if (!reason) return null;
            if (reason === 'nickname') nicknameRequired = true;
        }
    }
    return nicknameRequired ? 'nickname' : 'levenshtein';
}

function normalizedScalar(field, value) {
    if (isBlank(value)) return null;
    if (field === 'phone_e164' || field === 'secondary_phone') return normalizePhone(value);
    if (field === 'email') return String(value).trim().toLocaleLowerCase('en-US');
    return String(value).trim().toLocaleLowerCase('en-US');
}

function scalarConflicts(survivor, donor) {
    const conflicts = [];
    for (const field of CONFLICT_SCALARS) {
        const survivorNormalized = normalizedScalar(field, survivor[field]);
        const donorNormalized = normalizedScalar(field, donor[field]);
        if (!survivorNormalized || !donorNormalized || survivorNormalized === donorNormalized) continue;
        conflicts.push({
            field,
            survivor_value: survivor[field],
            donor_value: donor[field],
        });
    }
    return conflicts;
}

async function assertCompany(queryable, companyId) {
    const { rows } = await queryable.query(
        'SELECT id FROM companies WHERE id = $1',
        [companyId]
    );
    if (rows.length !== 1) {
        throw new BulkMergeError('COMPANY_NOT_FOUND', `Company ${companyId} was not found`);
    }
}

async function readActiveContactTotal(queryable, companyId) {
    const { rows } = await queryable.query(
        `SELECT COUNT(*)::int AS count
           FROM contacts
          WHERE company_id = $1 AND deleted_at IS NULL`,
        [companyId]
    );
    return Number(rows[0]?.count || 0);
}

async function discoverDuplicateSets(queryable, { companyId, limit, set }) {
    const params = [companyId];
    let setPredicate = '';
    if (set) {
        params.push(set);
        setPredicate = `\n         WHERE normalized_phone = $${params.length}`;
    }
    let limitClause = '';
    if (limit) {
        params.push(limit);
        limitClause = `\n         LIMIT $${params.length}`;
    }
    const { rows } = await queryable.query(
        `${DISCOVERY_CTE}
         SELECT normalized_phone,
                ARRAY_AGG(contact_id ORDER BY contact_id) AS member_ids
           FROM eligible_claims${setPredicate}
          GROUP BY normalized_phone
         HAVING COUNT(*) > 1
          ORDER BY normalized_phone${limitClause}`,
        params
    );
    return rows.map(row => ({
        normalized_phone: row.normalized_phone,
        member_ids: row.member_ids.map(String),
    }));
}

async function readContacts(queryable, companyId, memberIds) {
    const { rows } = await queryable.query(
        `SELECT ${CONTACT_SELECT_COLUMNS.join(', ')}
           FROM contacts
          WHERE company_id = $1
            AND id = ANY($2::bigint[])
            AND deleted_at IS NULL
          ORDER BY id`,
        [companyId, memberIds]
    );
    return rows;
}

function childCountQueries() {
    const direct = mergeService.CONTACT_FK_INVENTORY.map(descriptor => {
        if (descriptor.hasCompanyId) {
            return `SELECT '${descriptor.table}'::text AS ref_key,
                           child.contact_id::text AS contact_id,
                           COUNT(*)::int AS count
                      FROM ${descriptor.table} child
                     WHERE child.company_id = $1
                       AND child.contact_id = ANY($2::bigint[])
                     GROUP BY child.contact_id`;
        }
        return `SELECT '${descriptor.table}'::text AS ref_key,
                       child.contact_id::text AS contact_id,
                       COUNT(*)::int AS count
                  FROM ${descriptor.table} child
                  JOIN contacts owner
                    ON owner.id = child.contact_id AND owner.company_id = $1
                 WHERE child.contact_id = ANY($2::bigint[])
                 GROUP BY child.contact_id`;
    });
    const polymorphic = mergeService.POLYMORPHIC_CONTACT_REFS.map(descriptor => {
        const key = `${descriptor.table}.${descriptor.idColumn}`;
        const idExpression = descriptor.textId
            ? `child.${descriptor.idColumn}`
            : `child.${descriptor.idColumn}::text`;
        return `SELECT '${key}'::text AS ref_key,
                       ${idExpression} AS contact_id,
                       COUNT(*)::int AS count
                  FROM ${descriptor.table} child
                 WHERE child.company_id = $1
                   AND child.${descriptor.typeColumn} = '${descriptor.type}'
                   AND ${descriptor.textId
        ? `child.${descriptor.idColumn} = ANY(SELECT value::text FROM UNNEST($2::bigint[]) value)`
        : `child.${descriptor.idColumn} = ANY($2::bigint[])`}
                 GROUP BY child.${descriptor.idColumn}`;
    });
    return [...direct, ...polymorphic];
}

async function readChildCounts(queryable, companyId, memberIds) {
    const keys = [
        ...mergeService.CONTACT_FK_INVENTORY.map(row => row.table),
        ...mergeService.POLYMORPHIC_CONTACT_REFS.map(row => `${row.table}.${row.idColumn}`),
    ];
    const byContact = new Map(memberIds.map(id => [String(id), Object.fromEntries(
        keys.map(key => [key, 0])
    )]));
    const { rows } = await queryable.query(
        childCountQueries().join('\nUNION ALL\n'),
        [companyId, memberIds]
    );
    for (const row of rows) {
        const counts = byContact.get(String(row.contact_id));
        if (counts) counts[row.ref_key] = Number(row.count || 0);
    }
    return byContact;
}

async function readInventories(queryable, companyId, memberIds) {
    const identities = await queryable.query(
        `SELECT source, external_id, contact_id
           FROM contact_external_identities
          WHERE company_id = $1 AND contact_id = ANY($2::bigint[])
          ORDER BY source, external_id, contact_id`,
        [companyId, memberIds]
    );
    const phones = await queryable.query(
        `SELECT id, contact_id, phone_e164, normalized_phone, label,
                is_primary, is_shared, created_at
           FROM contact_phones
          WHERE company_id = $1 AND contact_id = ANY($2::bigint[])
          ORDER BY normalized_phone, contact_id, id`,
        [companyId, memberIds]
    );
    const emails = await queryable.query(
        `SELECT email_row.id, email_row.contact_id, email_row.email,
                email_row.email_normalized, email_row.is_primary
           FROM contact_emails email_row
           JOIN contacts owner
             ON owner.id = email_row.contact_id AND owner.company_id = $1
          WHERE email_row.contact_id = ANY($2::bigint[])
          ORDER BY email_row.email_normalized, email_row.contact_id, email_row.id`,
        [companyId, memberIds]
    );
    const stripe = await queryable.query(
        `SELECT customer.id, customer.contact_id, customer.stripe_account_id,
                customer.stripe_customer_id,
                COUNT(method.id)::int AS saved_payment_method_count
           FROM stripe_contact_customers customer
           LEFT JOIN stripe_saved_payment_methods method
             ON method.stripe_contact_customer_id = customer.id
            AND method.company_id = customer.company_id
            AND method.contact_id = customer.contact_id
          WHERE customer.company_id = $1
            AND customer.contact_id = ANY($2::bigint[])
          GROUP BY customer.id, customer.contact_id, customer.stripe_account_id,
                   customer.stripe_customer_id
          ORDER BY customer.contact_id, customer.id`,
        [companyId, memberIds]
    );
    return {
        identities: identities.rows,
        phones: phones.rows,
        emails: emails.rows,
        stripe: stripe.rows,
    };
}

function augmentInventoriesWithContactScalars(contacts, inventories) {
    const augmented = {
        identities: inventories.identities.map(row => ({
            ...row,
            storage: 'contact_external_identities',
        })),
        phones: inventories.phones.map(row => ({ ...row, storage: 'contact_phones' })),
        emails: inventories.emails.map(row => ({ ...row, storage: 'contact_emails' })),
        stripe: inventories.stripe,
    };
    for (const contact of contacts) {
        const externalId = String(contact.zenbooker_customer_id || '').trim();
        if (externalId && !augmented.identities.some(row =>
            String(row.contact_id) === String(contact.id)
            && row.source === 'zenbooker'
            && row.external_id === externalId
        )) {
            augmented.identities.push({
                source: 'zenbooker',
                external_id: externalId,
                contact_id: contact.id,
                storage: 'contacts.zenbooker_customer_id',
            });
        }
        for (const scalarPhone of [
            { value: contact.phone_e164, label: null, is_primary: true, column: 'phone_e164' },
            {
                value: contact.secondary_phone,
                label: contact.secondary_phone_name || null,
                is_primary: false,
                column: 'secondary_phone',
            },
        ]) {
            const normalized = normalizePhone(scalarPhone.value);
            if (!normalized || augmented.phones.some(row =>
                String(row.contact_id) === String(contact.id)
                && row.normalized_phone === normalized
            )) continue;
            augmented.phones.push({
                id: null,
                contact_id: contact.id,
                phone_e164: scalarPhone.value,
                normalized_phone: normalized,
                label: scalarPhone.label,
                is_primary: scalarPhone.is_primary,
                is_shared: false,
                created_at: null,
                storage: `contacts.${scalarPhone.column}`,
            });
        }
        const normalizedEmail = String(contact.email || '').trim().toLocaleLowerCase('en-US');
        if (normalizedEmail && !augmented.emails.some(row =>
            String(row.contact_id) === String(contact.id)
            && row.email_normalized === normalizedEmail
        )) {
            augmented.emails.push({
                id: null,
                contact_id: contact.id,
                email: contact.email,
                email_normalized: normalizedEmail,
                is_primary: true,
                storage: 'contacts.email',
            });
        }
    }
    augmented.identities.sort((left, right) =>
        left.source.localeCompare(right.source)
        || left.external_id.localeCompare(right.external_id)
        || compareIds(left.contact_id, right.contact_id)
    );
    augmented.phones.sort((left, right) =>
        left.normalized_phone.localeCompare(right.normalized_phone)
        || compareIds(left.contact_id, right.contact_id)
        || Number(left.id || 0) - Number(right.id || 0)
    );
    augmented.emails.sort((left, right) =>
        left.email_normalized.localeCompare(right.email_normalized)
        || compareIds(left.contact_id, right.contact_id)
        || Number(left.id || 0) - Number(right.id || 0)
    );
    return augmented;
}

async function readBlockers(queryable, companyId, contacts, memberIds, inventories) {
    const blockers = [];
    const stripeOwners = [...new Set(inventories.stripe.map(row => String(row.contact_id)))];
    if (stripeOwners.length > 1) {
        blockers.push({
            type: 'stripe_customer_conflict',
            contact_ids: stripeOwners,
            customers: inventories.stripe,
        });
    }

    const masking = await queryable.query(
        `SELECT contact_id, code
           FROM contact_call_masking_codes
          WHERE company_id = $1 AND contact_id = ANY($2::bigint[])
          ORDER BY contact_id, code`,
        [companyId, memberIds]
    );
    if (masking.rows.length > 1) {
        blockers.push({ type: 'call_masking_code_conflict', codes: masking.rows });
    }

    const relationships = await queryable.query(
        `SELECT account_id,
                ARRAY_AGG(DISTINCT relationship_type ORDER BY relationship_type) AS relationship_types,
                ARRAY_AGG(contact_id ORDER BY contact_id) AS contact_ids
           FROM crm_account_contacts
          WHERE company_id = $1
            AND contact_id = ANY($2::bigint[])
            AND NULLIF(BTRIM(relationship_type), '') IS NOT NULL
          GROUP BY account_id
         HAVING COUNT(DISTINCT relationship_type) > 1
          ORDER BY account_id`,
        [companyId, memberIds]
    );
    for (const relationship of relationships.rows) {
        blockers.push({ type: 'account_relationship_conflict', ...relationship });
    }

    for (const contact of contacts) {
        for (const column of ['phone_e164', 'secondary_phone']) {
            if (!isBlank(contact[column]) && !normalizePhone(contact[column])) {
                blockers.push({
                    type: 'invalid_phone_inventory',
                    contact_id: contact.id,
                    column,
                });
            }
        }
    }

    const scalarExternalIds = contacts
        .map(contact => String(contact.zenbooker_customer_id || '').trim())
        .filter(Boolean);
    if (scalarExternalIds.length > 0) {
        const owners = await queryable.query(
            `SELECT source, external_id, contact_id
               FROM contact_external_identities
              WHERE company_id = $1
                AND source = 'zenbooker'
                AND external_id = ANY($2::text[])
              ORDER BY external_id, contact_id`,
            [companyId, scalarExternalIds]
        );
        const expectedOwnerByExternal = new Map(contacts
            .filter(contact => String(contact.zenbooker_customer_id || '').trim())
            .map(contact => [String(contact.zenbooker_customer_id).trim(), String(contact.id)]));
        for (const owner of owners.rows) {
            if (String(owner.contact_id) !== expectedOwnerByExternal.get(owner.external_id)) {
                blockers.push({
                    type: 'external_identity_conflict',
                    source: owner.source,
                    external_id: owner.external_id,
                    expected_contact_id: expectedOwnerByExternal.get(owner.external_id),
                    owner_contact_id: owner.contact_id,
                });
            }
        }
    }
    return blockers;
}

function rowsByContact(rows) {
    const mapped = new Map();
    for (const row of rows) {
        const key = String(row.contact_id);
        if (!mapped.has(key)) mapped.set(key, []);
        mapped.get(key).push(row);
    }
    return mapped;
}

function collisionSummary(inventories) {
    const collisions = { phones: [], emails: [] };
    const phoneGroups = new Map();
    for (const phone of inventories.phones) {
        if (!phoneGroups.has(phone.normalized_phone)) phoneGroups.set(phone.normalized_phone, []);
        phoneGroups.get(phone.normalized_phone).push(phone);
    }
    for (const [normalizedPhone, rows] of phoneGroups) {
        if (new Set(rows.map(row => String(row.contact_id))).size > 1) {
            collisions.phones.push({ normalized_phone: normalizedPhone, row_count: rows.length });
        }
    }
    const emailGroups = new Map();
    for (const email of inventories.emails) {
        if (!emailGroups.has(email.email_normalized)) emailGroups.set(email.email_normalized, []);
        emailGroups.get(email.email_normalized).push(email);
    }
    for (const [normalizedEmail, rows] of emailGroups) {
        if (new Set(rows.map(row => String(row.contact_id))).size > 1) {
            collisions.emails.push({ normalized_email: normalizedEmail, row_count: rows.length });
        }
    }
    return collisions;
}

async function buildSetPlan(queryable, companyId, duplicateSet, fuzzy = false) {
    const contacts = await readContacts(queryable, companyId, duplicateSet.member_ids);
    if (contacts.length !== duplicateSet.member_ids.length) {
        throw new BulkMergeError(
            'SET_MEMBER_CHANGED',
            `Duplicate set ${duplicateSet.normalized_phone} has a missing or archived member`
        );
    }
    const childCounts = await readChildCounts(queryable, companyId, duplicateSet.member_ids);
    const storedInventories = await readInventories(queryable, companyId, duplicateSet.member_ids);
    const inventories = augmentInventoriesWithContactScalars(contacts, storedInventories);
    const identitiesByContact = rowsByContact(inventories.identities);
    const phonesByContact = rowsByContact(inventories.phones);
    const emailsByContact = rowsByContact(inventories.emails);
    const stripeByContact = rowsByContact(inventories.stripe);

    const candidates = contacts.map(contact => {
        const counts = childCounts.get(String(contact.id));
        return {
            ...contact,
            business_link_count: BUSINESS_LINK_KEYS.reduce(
                (total, key) => total + Number(counts[key] || 0),
                0
            ),
            completeness_count: COMPLETENESS_SCALARS.reduce(
                (total, field) => total + (isBlank(contact[field]) ? 0 : 1),
                0
            ),
        };
    });
    const survivorCandidate = chooseSurvivor(candidates);
    const donorCandidates = candidates
        .filter(contact => String(contact.id) !== String(survivorCandidate.id))
        .sort((left, right) => compareIds(left.id, right.id));
    const household = nameDivergence(candidates);
    const blockers = await readBlockers(
        queryable,
        companyId,
        contacts,
        duplicateSet.member_ids,
        storedInventories
    );
    const baseDisposition = household.probable_household
        ? 'probable_household'
        : blockers.length > 0 ? 'quarantine_blocked' : 'mergeable';
    const fuzzyReason = fuzzy && baseDisposition === 'probable_household' && blockers.length === 0
        ? fuzzySetReason(candidates)
        : null;
    const disposition = fuzzyReason ? 'mergeable' : baseDisposition;

    const contactReport = contact => ({
        id: contact.id,
        full_name: contact.full_name || null,
        first_name: contact.first_name || null,
        last_name: contact.last_name || null,
        created_at: contact.created_at,
        updated_at: contact.updated_at,
        business_link_count: contact.business_link_count,
        completeness_count: contact.completeness_count,
        child_counts: childCounts.get(String(contact.id)),
        external_ids: identitiesByContact.get(String(contact.id)) || [],
        phones: phonesByContact.get(String(contact.id)) || [],
        emails: emailsByContact.get(String(contact.id)) || [],
        stripe_customers: stripeByContact.get(String(contact.id)) || [],
    });

    const survivor = contactReport(survivorCandidate);
    const donors = donorCandidates.map(contact => ({
        ...contactReport(contact),
        scalar_conflicts: scalarConflicts(survivorCandidate, contact),
    }));
    const collisions = collisionSummary(inventories);
    const fingerprintState = {
        version: PLAN_VERSION,
        company_id: companyId,
        normalized_phone: duplicateSet.normalized_phone,
        member_ids: duplicateSet.member_ids.map(String),
        disposition,
        survivor,
        donors,
        household,
        blockers,
        collisions,
        ...(fuzzyReason ? { fuzzy_reason: fuzzyReason } : {}),
        contact_rows: candidates.map(contact => Object.fromEntries(
            CONTACT_SELECT_COLUMNS.map(column => [column, contact[column]])
        )),
    };
    return {
        normalized_phone: duplicateSet.normalized_phone,
        fingerprint: fingerprint(fingerprintState),
        disposition,
        ...(fuzzyReason ? { fuzzy_reason: fuzzyReason } : {}),
        shared_phone: false,
        survivor,
        donors,
        household,
        blockers,
        stripe_saved_card_blockers: blockers.filter(blocker =>
            blocker.type === 'stripe_customer_conflict'
        ),
        collisions,
        expected_post_state: disposition === 'mergeable' ? {
            active_contact_count_delta: -donors.length,
            survivor_contact_id: survivor.id,
            survivor_deleted_at: null,
            donor_contact_ids: donors.map(donor => donor.id),
            donor_disposition: 'soft_deleted',
            donor_reference_count: 0,
            redirects: donors.map(donor => ({
                old_contact_id: donor.id,
                survivor_contact_id: survivor.id,
                status: 'merged',
            })),
            identities_rehomed_to: survivor.id,
            phones_rehomed_to: survivor.id,
        } : {
            active_contact_count_delta: 0,
            contacts_unchanged: true,
            disposition,
        },
    };
}

function summarizeTotals(sets) {
    return {
        sets: sets.length,
        mergeable: sets.filter(set => set.disposition === 'mergeable').length,
        probable_household: sets.filter(set => set.disposition === 'probable_household').length,
        quarantine_blocked: sets.filter(set => set.disposition === 'quarantine_blocked').length,
        total_donors: sets.reduce((total, set) => total + set.donors.length, 0),
    };
}

async function buildPlan(queryable, args, generatedAt) {
    await assertCompany(queryable, args.companyId);
    const before = await readActiveContactTotal(queryable, args.companyId);
    const duplicateSets = await discoverDuplicateSets(queryable, args);
    const sets = [];
    for (const duplicateSet of duplicateSets) {
        sets.push(await buildSetPlan(queryable, args.companyId, duplicateSet, args.fuzzy));
    }
    const mergeableDonors = sets
        .filter(set => set.disposition === 'mergeable')
        .reduce((total, set) => total + set.donors.length, 0);
    return {
        plan_version: PLAN_VERSION,
        generated_at: generatedAt,
        company_id: args.companyId,
        mode: args.apply ? 'apply' : 'dry-run',
        filters: { limit: args.limit, set: args.set, fuzzy: args.fuzzy },
        totals: summarizeTotals(sets),
        contact_totals: {
            before,
            expected_after: before - mergeableDonors,
            after: args.apply ? null : before,
        },
        sets,
        aggregate_apply_result: {
            moved_child_counts: {},
            moved_external_identities: 0,
            moved_phone_rows: 0,
            phone_collisions: 0,
            email_collisions: 0,
            merged_sets: 0,
            merged_donors: 0,
            already_redirected_sets: 0,
            skipped_sets: 0,
            failed_sets: 0,
        },
        failures: [],
    };
}

function addCount(target, key, count) {
    target[key] = Number(target[key] || 0) + Number(count || 0);
}

function addSuccessfulSetCounts(aggregate, setPlan) {
    aggregate.merged_sets += 1;
    aggregate.merged_donors += setPlan.donors.length;
    aggregate.phone_collisions += setPlan.collisions.phones.length;
    aggregate.email_collisions += setPlan.collisions.emails.length;
    for (const donor of setPlan.donors) {
        aggregate.moved_external_identities += donor.external_ids.length;
        aggregate.moved_phone_rows += donor.phones.length;
        for (const [key, count] of Object.entries(donor.child_counts)) {
            addCount(aggregate.moved_child_counts, key, count);
        }
    }
}

async function matchingRedirects(client, companyId, setPlan) {
    const donorIds = setPlan.donors.map(donor => donor.id);
    const { rows } = await client.query(
        `SELECT old_contact_id, survivor_contact_id, status
           FROM contact_merge_redirects
          WHERE company_id = $1 AND old_contact_id = ANY($2::bigint[])
          ORDER BY old_contact_id`,
        [companyId, donorIds]
    );
    return rows.filter(row => row.status === 'merged'
        && String(row.survivor_contact_id) === String(setPlan.survivor.id));
}

async function applySet(database, companyId, setPlan, mergeContacts) {
    const client = await database.getClient();
    let transactionOpen = false;
    try {
        await client.query('BEGIN');
        transactionOpen = true;
        // Same critical section as B2. The explicit operational pause remains
        // required because this lock is released between duplicate sets.
        await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [`contact-resolver:${companyId}`]
        );
        const memberIds = [setPlan.survivor.id, ...setPlan.donors.map(donor => donor.id)]
            .map(String)
            .sort(compareIds);
        const { rows: locked } = await client.query(
            `SELECT id, deleted_at
               FROM contacts
              WHERE company_id = $1 AND id = ANY($2::bigint[])
              ORDER BY id
              FOR UPDATE`,
            [companyId, memberIds]
        );
        const activeIds = new Set(
            locked.filter(row => !row.deleted_at).map(row => String(row.id))
        );
        const redirects = await matchingRedirects(client, companyId, setPlan);
        const redirectedIds = new Set(redirects.map(row => String(row.old_contact_id)));
        const missingWithoutRedirect = setPlan.donors.filter(donor =>
            !activeIds.has(String(donor.id)) && !redirectedIds.has(String(donor.id))
        );
        if (missingWithoutRedirect.length > 0) {
            throw new BulkMergeError(
                'MISSING_DONOR_WITHOUT_REDIRECT',
                `Donor(s) ${missingWithoutRedirect.map(donor => donor.id).join(',')} are missing or archived without a matching redirect`
            );
        }
        if (!activeIds.has(String(setPlan.survivor.id))) {
            throw new BulkMergeError(
                'SURVIVOR_MISSING',
                `Survivor ${setPlan.survivor.id} is missing or archived`
            );
        }
        if (redirectedIds.size === setPlan.donors.length) {
            await client.query('COMMIT');
            transactionOpen = false;
            return { status: 'already_redirected', redirects };
        }
        if (redirectedIds.size > 0) {
            throw new BulkMergeError(
                'PARTIAL_REDIRECT_SET',
                `Set ${setPlan.normalized_phone} is only partially redirected`
            );
        }
        if (locked.length !== memberIds.length) {
            throw new BulkMergeError(
                'SET_MEMBER_MISSING',
                `Set ${setPlan.normalized_phone} no longer contains every planned member`
            );
        }

        const liveSet = (await discoverDuplicateSets(client, {
            companyId,
            limit: null,
            set: setPlan.normalized_phone,
        }))[0];
        if (!liveSet) {
            throw new BulkMergeError(
                'SET_NO_LONGER_DUPLICATE',
                `Set ${setPlan.normalized_phone} is no longer a duplicate set`
            );
        }
        const revalidated = await buildSetPlan(
            client,
            companyId,
            liveSet,
            Boolean(setPlan.fuzzy_reason)
        );
        if (revalidated.fingerprint !== setPlan.fingerprint) {
            throw new BulkMergeError(
                'PLAN_FINGERPRINT_CHANGED',
                `Set ${setPlan.normalized_phone} changed after planning`
            );
        }

        const mergeResults = [];
        for (const donor of setPlan.donors) {
            const result = await mergeContacts(
                setPlan.survivor.id,
                donor.id,
                companyId,
                client
            );
            if (!result || result.status !== 'merged') {
                const error = new BulkMergeError(
                    'MERGE_QUARANTINED_DURING_APPLY',
                    `B3 refused donor ${donor.id} during apply`
                );
                error.mergeResult = result;
                throw error;
            }
            mergeResults.push(result);
        }
        await client.query('COMMIT');
        transactionOpen = false;
        return { status: 'merged', merge_results: mergeResults };
    } catch (error) {
        if (transactionOpen) {
            try { await client.query('ROLLBACK'); } catch (_) { /* preserve original failure */ }
        }
        throw error;
    } finally {
        client.release();
    }
}

function errorReport(error) {
    return {
        code: error.code || 'SET_APPLY_FAILED',
        message: error.message,
        merge_result: error.mergeResult || null,
    };
}

async function applyPlan(database, plan, mergeContacts) {
    for (const setPlan of plan.sets) {
        if (setPlan.disposition !== 'mergeable') {
            setPlan.apply_result = {
                status: 'skipped',
                reason: setPlan.disposition,
            };
            plan.aggregate_apply_result.skipped_sets += 1;
            continue;
        }
        try {
            const result = await applySet(database, plan.company_id, setPlan, mergeContacts);
            setPlan.apply_result = result;
            if (result.status === 'merged') {
                addSuccessfulSetCounts(plan.aggregate_apply_result, setPlan);
            } else {
                plan.aggregate_apply_result.already_redirected_sets += 1;
            }
        } catch (error) {
            const failure = {
                normalized_phone: setPlan.normalized_phone,
                survivor_contact_id: setPlan.survivor.id,
                donor_contact_ids: setPlan.donors.map(donor => donor.id),
                ...errorReport(error),
            };
            setPlan.apply_result = { status: 'failed', ...failure };
            plan.failures.push(failure);
            plan.aggregate_apply_result.failed_sets += 1;
        }
    }
    plan.contact_totals.after = await readActiveContactTotal(database, plan.company_id);
    plan.exit_code = plan.failures.length > 0 ? 1 : 0;
    return plan;
}

function humanSummary(report) {
    const lines = [
        `Bulk contact merge ${report.mode.toUpperCase()} — company ${report.company_id}`,
        `Generated: ${report.generated_at}`,
        `Sets: ${report.totals.sets}; mergeable: ${report.totals.mergeable}; probable household: ${report.totals.probable_household}; quarantine-blocked: ${report.totals.quarantine_blocked}; donors: ${report.totals.total_donors}`,
        `Active contacts: before ${report.contact_totals.before}; expected after ${report.contact_totals.expected_after}; actual after ${report.contact_totals.after}`,
    ];
    if (report.mode === 'apply') {
        const aggregate = report.aggregate_apply_result;
        lines.push(
            `Apply: merged sets ${aggregate.merged_sets}; donors ${aggregate.merged_donors}; skipped ${aggregate.skipped_sets}; failed ${aggregate.failed_sets}`,
            `Moved: external identities ${aggregate.moved_external_identities}; phone rows ${aggregate.moved_phone_rows}; phone collisions ${aggregate.phone_collisions}; email collisions ${aggregate.email_collisions}`,
            `Moved child rows: ${Object.entries(aggregate.moved_child_counts).map(([key, count]) => `${key}=${count}`).join(', ') || 'none'}`
        );
    }
    if (report.filters.fuzzy) {
        const fuzzySets = report.sets.filter(set => set.fuzzy_reason);
        lines.push('', `FUZZY → mergeable (${fuzzySets.length})`);
        for (const set of fuzzySets) {
            lines.push(
                `  ${set.normalized_phone} [${set.fuzzy_reason}] ${set.household.members.map(member => member.name || '(unnamed)').join(' <> ')}`
            );
        }
    }
    lines.push('');
    for (const set of report.sets) {
        lines.push(
            `${set.normalized_phone} [${set.disposition}] fingerprint=${set.fingerprint}`,
            `  survivor: ${set.survivor.id} ${set.survivor.full_name || '(unnamed)'}; donors: ${set.donors.map(donor => donor.id).join(', ')}`,
            `  external identities: ${set.donors.reduce((total, donor) => total + donor.external_ids.length, 0)}; phone rows: ${set.donors.reduce((total, donor) => total + donor.phones.length, 0)}; scalar conflicts: ${set.donors.reduce((total, donor) => total + donor.scalar_conflicts.length, 0)}`
        );
        if (set.household.probable_household) {
            lines.push(`  household signal: ${set.household.divergent_pairs.map(pair => pair.names.join(' <> ')).join('; ')}`);
        }
        if (set.blockers.length > 0) {
            lines.push(`  blockers: ${set.blockers.map(blocker => blocker.type).join(', ')}`);
        }
        if (set.apply_result) lines.push(`  apply: ${set.apply_result.status}`);
    }
    if (report.failures.length > 0) {
        lines.push('', 'Failures:');
        for (const failure of report.failures) {
            lines.push(`  ${failure.normalized_phone}: ${failure.code} — ${failure.message}`);
        }
    }
    return `${lines.join('\n')}\n`;
}

function artifactBase(report) {
    const timestamp = report.generated_at.replace(/[:.]/g, '-');
    return `bulk-merge-contacts-${report.company_id}-${report.mode}-${timestamp}`;
}

function writeArtifacts(report, outputDirectory = process.cwd()) {
    const base = artifactBase(report);
    const jsonPath = path.resolve(outputDirectory, `${base}.json`);
    const summaryPath = path.resolve(outputDirectory, `${base}.txt`);
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    fs.writeFileSync(summaryPath, humanSummary(report), { flag: 'wx' });
    return { json: jsonPath, summary: summaryPath };
}

async function run(argv = process.argv.slice(2), dependencies = {}) {
    const args = parseArgs(argv);
    const database = dependencies.db || connectionDb;
    const mergeContacts = dependencies.mergeContacts || mergeService.mergeContacts;
    const output = dependencies.output || (message => process.stdout.write(`${message}\n`));
    const warningOutput = dependencies.warningOutput
        || (message => process.stderr.write(`${message}\n`));
    const generatedAt = (dependencies.now ? dependencies.now() : new Date()).toISOString();

    if (args.apply) {
        warningOutput(
            'WARNING: pause the Zenbooker contact import before --apply; a live ZB writer can resurrect an archived donor between sets.'
        );
    }
    const plan = await buildPlan(database, args, generatedAt);
    const report = args.apply
        ? await applyPlan(database, plan, mergeContacts)
        : { ...plan, exit_code: 0 };
    const artifacts = writeArtifacts(report, dependencies.outputDirectory || process.cwd());
    report.artifacts = artifacts;
    output(humanSummary(report).trimEnd());
    output(`JSON plan/report: ${artifacts.json}`);
    output(`Human summary: ${artifacts.summary}`);
    return report;
}

if (require.main === module) {
    run()
        .then(report => {
            if (report.failures.length > 0) process.exitCode = 1;
        })
        .catch(error => {
            const code = error.code ? ` [${error.code}]` : '';
            process.stderr.write(`Bulk contact merge refused${code}: ${error.message}\n`);
            process.exitCode = 1;
        })
        .finally(async () => {
            try { await connectionDb.pool.end(); } catch (_) { /* pool already closed */ }
        });
}

module.exports = {
    BUSINESS_LINK_KEYS,
    BulkMergeError,
    COMPLETENESS_SCALARS,
    applyPlan,
    applySet,
    buildPlan,
    buildSetPlan,
    chooseSurvivor,
    compareSurvivorCandidates,
    discoverDuplicateSets,
    fingerprint,
    humanSummary,
    fuzzySetReason,
    levenshteinDistance,
    nameDivergence,
    parseArgs,
    run,
    stableJson,
    writeArtifacts,
};
