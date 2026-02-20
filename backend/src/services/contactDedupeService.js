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

async function searchCandidates({ first_name, last_name, phone, email }, companyId = null) {
    const fnNorm = normalizeName(first_name);
    const lnNorm = normalizeName(last_name);
    const phoneNorm = normalizePhone(phone);
    const emailNorm = normalizeEmail(email);

    if (!fnNorm || !lnNorm) return { candidates: [], match_hint: 'none' };

    const candidates = await findCandidatesByName(fnNorm, lnNorm, companyId);

    if (candidates.length === 0) return { candidates: [], match_hint: 'none' };

    // Enrich each candidate with additional_emails
    for (const c of candidates) {
        c.additional_emails = await getAdditionalEmails(c.id);
    }

    // Determine match_hint
    let matchHint = 'name_only';
    if (phoneNorm) {
        const phoneMatches = candidates.filter(c => normalizePhone(c.phone_e164) === phoneNorm);
        if (phoneMatches.length === 1) matchHint = 'phone';
        else if (phoneMatches.length > 1) matchHint = 'phone_ambiguous';
    } else if (emailNorm) {
        const emailMatches = await filterByEmail(candidates, emailNorm);
        if (emailMatches.length === 1) matchHint = 'email';
        else if (emailMatches.length > 1) matchHint = 'email_ambiguous';
    }

    // Check if email enrichment will happen
    let will_enrich_email = false;
    if (matchHint === 'phone' && emailNorm) {
        const match = candidates.find(c => normalizePhone(c.phone_e164) === phoneNorm);
        if (match) {
            const allEmails = [match.email, ...(match.additional_emails || [])].filter(Boolean).map(e => e.toLowerCase().trim());
            if (!allEmails.includes(emailNorm)) {
                will_enrich_email = true;
            }
        }
    }

    return {
        candidates: candidates.map(c => ({
            id: c.id,
            full_name: c.full_name,
            first_name: c.first_name,
            last_name: c.last_name,
            phone_e164: c.phone_e164,
            email: c.email,
            additional_emails: c.additional_emails || [],
            phone_match: phoneNorm ? normalizePhone(c.phone_e164) === phoneNorm : false,
            email_match: emailNorm ? (
                (c.email && c.email.toLowerCase().trim() === emailNorm) ||
                (c.additional_emails || []).some(e => e.toLowerCase().trim() === emailNorm)
            ) : false,
        })),
        match_hint: matchHint,
        will_enrich_email,
    };
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

    const sql = `
        INSERT INTO contacts (full_name, first_name, last_name, phone_e164, email, company_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
    `;
    const { rows } = await db.query(sql, [
        fullName,
        first_name || null,
        last_name || null,
        phone || null,
        email || null,
        effectiveCompanyId,
    ]);
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
};
