/**
 * Contact Deduplication Service
 *
 * Implements name→phone→email matching to prevent duplicate contacts
 * when creating leads (UI or API).
 *
 * Algorithm:
 * 1. Normalize names/phone/email
 * 2. Find candidates by first_name + last_name
 * 3. If phone present → match among candidates → 0 create, 1 match, 2+ ambiguous
 * 4. If no phone but email → match among candidates (primary or additional)
 * 5. Email enrichment: if matched by phone and email differs → add to contact_emails
 */

const db = require('../db/connection');
const { toE164 } = require('../utils/phoneUtils');

// =============================================================================
// Normalization helpers
// =============================================================================

function normalizeName(name) {
    if (!name) return '';
    return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizePhone(phone) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '');
    // For US numbers, take last 10 digits
    return digits.length >= 10 ? digits.slice(-10) : digits || null;
}

function normalizeEmail(email) {
    if (!email) return null;
    return email.trim().toLowerCase().replace(/^<|>$/g, '') || null;
}

// =============================================================================
// resolveContact — main dedupe entry point
// =============================================================================

/**
 * Resolve or create a contact for lead creation.
 *
 * @param {Object} input - { first_name, last_name, phone, email }
 * @param {string|null} companyId
 * @returns {Object} { contact_id, status, matched_by, email_enriched, warnings }
 */
async function resolveContact({ first_name, last_name, phone, email }, companyId = null) {
    const fnNorm = normalizeName(first_name);
    const lnNorm = normalizeName(last_name);
    const phoneNorm = normalizePhone(phone);
    const emailNorm = normalizeEmail(email);

    const warnings = [];

    // Step 1: Find candidates by normalized name
    const candidates = await findCandidatesByName(fnNorm, lnNorm, companyId);

    if (candidates.length === 0) {
        // No name match → create new contact
        const contactId = await createNewContact({ first_name, last_name, phone, email }, companyId);
        return { contact_id: contactId, status: 'created', matched_by: 'none', email_enriched: false, warnings };
    }

    // Step 2: If phone is present, try phone match among candidates
    if (phoneNorm) {
        const phoneMatches = candidates.filter(c => normalizePhone(c.phone_e164) === phoneNorm);

        if (phoneMatches.length === 1) {
            // Exact match
            const matched = phoneMatches[0];
            const enriched = await enrichEmail(matched.id, emailNorm);
            return { contact_id: matched.id, status: 'matched', matched_by: 'phone', email_enriched: enriched, warnings };
        }

        if (phoneMatches.length > 1) {
            warnings.push(`Multiple contacts found with same name and phone (${phoneMatches.length}). Manual selection required.`);
            return {
                contact_id: null,
                status: 'ambiguous',
                matched_by: 'phone',
                email_enriched: false,
                warnings,
                candidates: phoneMatches.map(c => ({ id: c.id, full_name: c.full_name, phone_e164: c.phone_e164, email: c.email })),
            };
        }

        // No phone match among candidates → create new
        const contactId = await createNewContact({ first_name, last_name, phone, email }, companyId);
        return { contact_id: contactId, status: 'created', matched_by: 'none', email_enriched: false, warnings };
    }

    // Step 3: No phone → try email match if email is present
    if (emailNorm) {
        const emailMatches = await filterByEmail(candidates, emailNorm);

        if (emailMatches.length === 1) {
            return { contact_id: emailMatches[0].id, status: 'matched', matched_by: 'email', email_enriched: false, warnings };
        }

        if (emailMatches.length > 1) {
            warnings.push(`Multiple contacts found with same name and email (${emailMatches.length}). Manual selection required.`);
            return {
                contact_id: null,
                status: 'ambiguous',
                matched_by: 'email',
                email_enriched: false,
                warnings,
                candidates: emailMatches.map(c => ({ id: c.id, full_name: c.full_name, phone_e164: c.phone_e164, email: c.email })),
            };
        }

        // No email match → create new
        const contactId = await createNewContact({ first_name, last_name, phone, email }, companyId);
        return { contact_id: contactId, status: 'created', matched_by: 'none', email_enriched: false, warnings };
    }

    // Step 4: No phone and no email, but name match exists → ambiguous
    if (candidates.length > 0) {
        warnings.push('Name matches existing contact(s) but no phone/email to confirm. Treating as ambiguous.');
        return {
            contact_id: null,
            status: 'ambiguous',
            matched_by: 'none',
            email_enriched: false,
            warnings,
            candidates: candidates.map(c => ({ id: c.id, full_name: c.full_name, phone_e164: c.phone_e164, email: c.email })),
        };
    }

    // Unreachable but safe fallback
    const contactId = await createNewContact({ first_name, last_name, phone, email }, companyId);
    return { contact_id: contactId, status: 'created', matched_by: 'none', email_enriched: false, warnings };
}

// =============================================================================
// searchCandidates — for UI auto-search (no side effects)
// =============================================================================

async function searchCandidates({ first_name, last_name, phone, email, q }, companyId = null) {
    const qNorm = typeof q === 'string' ? q.trim() : '';

    // Broad search mode: a single free-text `q` matches across name / email / phone.
    if (qNorm.length >= 2) {
        return broadSearchCandidates(qNorm, companyId);
    }

    const fnNorm = normalizeName(first_name);
    const lnNorm = normalizeName(last_name);
    const phoneNorm = normalizePhone(phone);
    const emailNorm = normalizeEmail(email);

    // Must have at least one searchable criterion
    const hasName = (fnNorm && fnNorm.length >= 2) || (lnNorm && lnNorm.length >= 2);
    const hasPhone = phoneNorm && phoneNorm.length >= 4;
    const hasEmail = emailNorm && emailNorm.length >= 3;

    if (!hasName && !hasPhone && !hasEmail) {
        return { candidates: [] };
    }

    // Build union queries for each criterion
    const queries = [];
    const allParams = [];
    let paramIdx = 1;

    // Company filter — parameterized, never string-interpolated (PF007)
    let companyCondition = '';
    if (companyId) {
        companyCondition = `AND c.company_id = $${paramIdx}`;
        allParams.push(companyId);
        paramIdx += 1;
    }

    // 1. Name search (requires at least one name, min 2 chars)
    if (hasName) {
        const nameConditions = [];
        if (fnNorm && fnNorm.length >= 2) {
            nameConditions.push(`LOWER(TRIM(c.first_name)) = $${paramIdx}`);
            allParams.push(fnNorm);
            paramIdx += 1;
        }
        if (lnNorm && lnNorm.length >= 2) {
            nameConditions.push(`LOWER(TRIM(c.last_name)) = $${paramIdx}`);
            allParams.push(lnNorm);
            paramIdx += 1;
        }
        queries.push(`
            SELECT c.id, c.full_name, c.first_name, c.last_name,
                   c.phone_e164, c.secondary_phone, c.secondary_phone_name, c.email, c.company_name,
                   TRUE AS name_match, FALSE AS phone_match, FALSE AS email_match
            FROM contacts c
            WHERE ${nameConditions.join(' AND ')}
              ${companyCondition}
        `);
    }

    // 2. Phone search (independent — min 4 digits)
    if (hasPhone) {
        // Match last 10 digits against phone_e164 and secondary_phone
        queries.push(`
            SELECT c.id, c.full_name, c.first_name, c.last_name,
                   c.phone_e164, c.secondary_phone, c.secondary_phone_name, c.email, c.company_name,
                   FALSE AS name_match, TRUE AS phone_match, FALSE AS email_match
            FROM contacts c
            WHERE (
                RIGHT(REGEXP_REPLACE(c.phone_e164, '[^0-9]', '', 'g'), 10) = $${paramIdx}
                OR RIGHT(REGEXP_REPLACE(COALESCE(c.secondary_phone, ''), '[^0-9]', '', 'g'), 10) = $${paramIdx}
            )
            ${companyCondition}
        `);
        allParams.push(phoneNorm.slice(-10));
        paramIdx += 1;
    }

    // 3. Email search (independent — min 3 chars)
    if (hasEmail) {
        queries.push(`
            SELECT c.id, c.full_name, c.first_name, c.last_name,
                   c.phone_e164, c.secondary_phone, c.secondary_phone_name, c.email, c.company_name,
                   FALSE AS name_match, FALSE AS phone_match, TRUE AS email_match
            FROM contacts c
            WHERE LOWER(TRIM(c.email)) = $${paramIdx}
            ${companyCondition}
        `);
        allParams.push(emailNorm);
        paramIdx += 1;
    }

    if (queries.length === 0) {
        return { candidates: [] };
    }

    const unionSql = `
        WITH matches AS (
            ${queries.join('\n            UNION ALL\n            ')}
        )
        SELECT id, full_name, first_name, last_name, phone_e164, secondary_phone, secondary_phone_name, email, company_name,
               BOOL_OR(name_match) AS name_match,
               BOOL_OR(phone_match) AS phone_match,
               BOOL_OR(email_match) AS email_match
        FROM matches
        GROUP BY id, full_name, first_name, last_name, phone_e164, secondary_phone, secondary_phone_name, email, company_name
        ORDER BY phone_match DESC, email_match DESC, name_match DESC
        LIMIT 10
    `;

    const { rows: candidates } = await db.query(unionSql, allParams);

    return { candidates: await mapCandidatesWithAddresses(candidates) };
}

// =============================================================================
// broadSearchCandidates — free-text `q` lookup across name / email / phone
// =============================================================================

/**
 * Broad case-insensitive search driven by a single free-text query.
 * Matches any of: name (first/last/full/company), email, phone.
 * Always parameterized; company filter applied when companyId is provided.
 *
 * @param {string} q - trimmed query (length >= 2 guaranteed by caller)
 * @param {string|null} companyId
 * @returns {{ candidates: Array }}
 */
async function broadSearchCandidates(q, companyId = null) {
    const params = [];
    const orConditions = [];

    // Helper to register a param and return its $N placeholder.
    const addParam = (value) => {
        params.push(value);
        return `$${params.length}`;
    };

    // --- Name matching ---
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
        const firstToken = tokens[0];
        const lastToken = tokens[tokens.length - 1];
        const fnP = addParam(`${firstToken}%`);
        const lnP = addParam(`${lastToken}%`);
        const fullP = addParam(`%${q}%`);
        orConditions.push(`(c.first_name ILIKE ${fnP} AND c.last_name ILIKE ${lnP})`);
        orConditions.push(`c.full_name ILIKE ${fullP}`);
    } else {
        const prefixP = addParam(`${q}%`);
        const containsP = addParam(`%${q}%`);
        orConditions.push(`c.first_name ILIKE ${prefixP}`);
        orConditions.push(`c.last_name ILIKE ${prefixP}`);
        orConditions.push(`c.full_name ILIKE ${containsP}`);
        orConditions.push(`COALESCE(c.company_name, '') ILIKE ${containsP}`);
    }

    // --- Email matching (only if q looks like / contains an email fragment) ---
    const hasEmailMatch = q.includes('@');
    if (hasEmailMatch) {
        const emailP = addParam(`%${q.toLowerCase()}%`);
        orConditions.push(`LOWER(COALESCE(c.email, '')) ILIKE ${emailP}`);
    }

    // --- Phone matching (only if q has >= 4 digits) ---
    const digits = q.replace(/\D/g, '');
    const hasPhoneMatch = digits.length >= 4;
    if (hasPhoneMatch) {
        const phoneP = addParam(`%${digits}%`);
        orConditions.push(`REGEXP_REPLACE(COALESCE(c.phone_e164, ''), '[^0-9]', '', 'g') LIKE ${phoneP}`);
        orConditions.push(`REGEXP_REPLACE(COALESCE(c.secondary_phone, ''), '[^0-9]', '', 'g') LIKE ${phoneP}`);
    }

    if (orConditions.length === 0) {
        return { candidates: [] };
    }

    // Company filter — parameterized, never string-interpolated (PF007)
    let companyCondition = '';
    if (companyId) {
        companyCondition = `AND c.company_id = ${addParam(companyId)}`;
    }

    const sql = `
        SELECT c.id, c.full_name, c.first_name, c.last_name,
               c.phone_e164, c.secondary_phone, c.secondary_phone_name, c.email, c.company_name
        FROM contacts c
        WHERE (${orConditions.join(' OR ')})
        ${companyCondition}
        LIMIT 10
    `;

    const { rows } = await db.query(sql, params);

    // Best-effort match flags (re-derived per row for the returned payload).
    const qLower = q.toLowerCase();
    const candidates = rows.map((c) => {
        const fullLower = (c.full_name || '').toLowerCase();
        const fnLower = (c.first_name || '').toLowerCase();
        const lnLower = (c.last_name || '').toLowerCase();
        const companyLower = (c.company_name || '').toLowerCase();
        const nameMatch =
            fullLower.includes(qLower) ||
            fnLower.startsWith(tokens[0]?.toLowerCase() || qLower) ||
            lnLower.startsWith((tokens[tokens.length - 1] || q).toLowerCase()) ||
            companyLower.includes(qLower);

        const emailMatch = hasEmailMatch && (c.email || '').toLowerCase().includes(qLower);

        let phoneMatch = false;
        if (hasPhoneMatch) {
            const primaryDigits = (c.phone_e164 || '').replace(/\D/g, '');
            const secondaryDigits = (c.secondary_phone || '').replace(/\D/g, '');
            phoneMatch = primaryDigits.includes(digits) || secondaryDigits.includes(digits);
        }

        return {
            ...c,
            name_match: Boolean(nameMatch),
            phone_match: Boolean(phoneMatch),
            email_match: Boolean(emailMatch),
        };
    });

    return { candidates: await mapCandidatesWithAddresses(candidates) };
}

// =============================================================================
// mapCandidatesWithAddresses — attach full addresses to candidate rows
// =============================================================================

/**
 * Attach an `addresses` array (full address objects) to each candidate and
 * keep top-level city/state (from primary address) for backward compatibility.
 */
async function mapCandidatesWithAddresses(candidateRows) {
    if (candidateRows.length === 0) return [];

    const contactIds = candidateRows.map(c => c.id);
    const { rows: addresses } = await db.query(`
        SELECT contact_id,
               street_line1 AS line1, street_line2 AS line2,
               city, state, postal_code, lat, lng
        FROM contact_addresses
        WHERE contact_id = ANY($1)
        ORDER BY contact_id, is_primary DESC, created_at ASC
    `, [contactIds]);

    const addrMap = {};
    for (const a of addresses) {
        if (!addrMap[a.contact_id]) addrMap[a.contact_id] = [];
        addrMap[a.contact_id].push({
            line1: a.line1 || '',
            line2: a.line2 || '',
            city: a.city || '',
            state: a.state || '',
            postal_code: a.postal_code || '',
            lat: a.lat ?? null,
            lng: a.lng ?? null,
        });
    }

    return candidateRows.map((c) => {
        const addrs = addrMap[c.id] || [];
        const primary = addrs[0] || null;
        return {
            id: c.id,
            full_name: c.full_name,
            first_name: c.first_name,
            last_name: c.last_name,
            phone_e164: c.phone_e164,
            secondary_phone: c.secondary_phone || null,
            secondary_phone_name: c.secondary_phone_name || null,
            email: c.email,
            company_name: c.company_name || null,
            city: primary?.city || null,
            state: primary?.state || null,
            addresses: addrs,
            name_match: c.name_match,
            phone_match: c.phone_match,
            email_match: c.email_match,
        };
    });
}

// =============================================================================
// Internal helpers
// =============================================================================

async function findCandidatesByName(fnNorm, lnNorm, companyId) {
    const conditions = [
        'LOWER(TRIM(c.first_name)) = $1',
        'LOWER(TRIM(c.last_name)) = $2',
    ];
    const params = [fnNorm, lnNorm];

    if (companyId) {
        conditions.push('c.company_id = $3');
        params.push(companyId);
    }

    const sql = `
        SELECT c.id, c.full_name, c.first_name, c.last_name,
               c.phone_e164, c.email
        FROM contacts c
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.updated_at DESC
        LIMIT 20
    `;

    const { rows } = await db.query(sql, params);
    return rows;
}

async function filterByEmail(candidates, emailNorm) {
    if (candidates.length === 0 || !emailNorm) return [];

    const contactIds = candidates.map(c => c.id);
    // Check primary email on contact + contact_emails table
    const { rows } = await db.query(`
        SELECT DISTINCT c.id
        FROM contacts c
        LEFT JOIN contact_emails ce ON ce.contact_id = c.id
        WHERE c.id = ANY($1)
          AND (LOWER(TRIM(c.email)) = $2 OR ce.email_normalized = $2)
    `, [contactIds, emailNorm]);

    const matchedIds = new Set(rows.map(r => String(r.id)));
    return candidates.filter(c => matchedIds.has(String(c.id)));
}

async function getAdditionalEmails(contactId) {
    const { rows } = await db.query(
        'SELECT email FROM contact_emails WHERE contact_id = $1 ORDER BY is_primary DESC, created_at',
        [contactId]
    );
    return rows.map(r => r.email);
}

async function enrichEmail(contactId, emailNorm) {
    if (!emailNorm) return false;

    // Check if this email already exists for this contact
    const { rows: existing } = await db.query(
        'SELECT 1 FROM contact_emails WHERE contact_id = $1 AND email_normalized = $2',
        [contactId, emailNorm]
    );
    if (existing.length > 0) return false;

    // Also check contact.email directly
    const { rows: contact } = await db.query(
        'SELECT email FROM contacts WHERE id = $1',
        [contactId]
    );
    if (contact.length > 0 && contact[0].email && contact[0].email.toLowerCase().trim() === emailNorm) {
        return false;
    }

    // If contact has no primary email, set it
    if (contact.length > 0 && !contact[0].email) {
        await db.query('UPDATE contacts SET email = $1 WHERE id = $2', [emailNorm, contactId]);
        await db.query(
            `INSERT INTO contact_emails (contact_id, email, email_normalized, is_primary)
             VALUES ($1, $2, $3, true)
             ON CONFLICT (contact_id, email_normalized) DO NOTHING`,
            [contactId, emailNorm, emailNorm]
        );
    } else {
        // Add as additional email
        await db.query(
            `INSERT INTO contact_emails (contact_id, email, email_normalized, is_primary)
             VALUES ($1, $2, $3, false)
             ON CONFLICT (contact_id, email_normalized) DO NOTHING`,
            [contactId, emailNorm, emailNorm]
        );
    }

    return true;
}

async function createNewContact({ first_name, last_name, phone, email }, companyId) {
    const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
    const fullName = [first_name, last_name].filter(Boolean).join(' ') || null;
    const emailNorm = normalizeEmail(email);
    const effectiveCompanyId = companyId || DEFAULT_COMPANY_ID;

    const { rows } = await db.query(`
        INSERT INTO contacts (full_name, first_name, last_name, phone_e164, email, company_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
    `, [fullName, first_name || null, last_name || null, toE164(phone), email || null, effectiveCompanyId]);
    const contactId = rows[0].id;

    // Also insert into contact_emails if email is present
    if (emailNorm) {
        await db.query(
            `INSERT INTO contact_emails (contact_id, email, email_normalized, is_primary)
             VALUES ($1, $2, $3, true)
             ON CONFLICT (contact_id, email_normalized) DO NOTHING`,
            [contactId, email, emailNorm]
        );
    }

    // Async: auto-create in Zenbooker if feature is enabled
    try {
        const zenbookerSyncService = require('./zenbookerSyncService');
        if (zenbookerSyncService.FEATURE_ENABLED) {
            zenbookerSyncService.pushContactToZenbooker(contactId).catch(err =>
                console.error(`[ContactDedupe] Zenbooker auto-create error (non-blocking):`, err.message)
            );
        }
    } catch (e) { /* zenbookerSyncService not available */ }

    // Auto-adopt orphan timelines matching this contact's phone
    const phoneE164 = toE164(phone);
    if (phoneE164) {
        try {
            const phoneDigits = phoneE164.replace(/\D/g, '');
            const adopted = await db.query(
                `UPDATE timelines SET contact_id = $1, phone_e164 = NULL, updated_at = now()
                 WHERE contact_id IS NULL
                   AND regexp_replace(phone_e164, '\\D', '', 'g') = $2`,
                [contactId, phoneDigits]
            );
            if (adopted.rowCount > 0) {
                // Also link calls on adopted timelines
                await db.query(
                    `UPDATE calls SET contact_id = $1
                     WHERE timeline_id IN (SELECT id FROM timelines WHERE contact_id = $1)
                       AND contact_id IS NULL`,
                    [contactId]
                );
                console.log(`[ContactDedupe] Adopted ${adopted.rowCount} orphan timeline(s) for new contact ${contactId} (${phoneE164})`);
            }
        } catch (err) {
            console.error(`[ContactDedupe] Orphan timeline adoption error (non-blocking):`, err.message);
        }
    }

    return contactId;
}

// =============================================================================
// Exports
// =============================================================================
module.exports = {
    resolveContact,
    searchCandidates,
    normalizePhone,
    normalizeEmail,
    normalizeName,
    createNewContactPublic: createNewContact,
};
