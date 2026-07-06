const express = require('express');
const multer = require('multer');
const { randomUUID } = require('node:crypto');
const router = express.Router();
const contactsService = require('../services/contactsService');
const contactDedupeService = require('../services/contactDedupeService');
const zenbookerSyncService = require('../services/zenbookerSyncService');
const noteAttachmentsService = require('../services/noteAttachmentsService');
const notesMutationService = require('../services/notesMutationService');
const { toE164 } = require('../utils/phoneUtils');
const eventService = require('../services/eventService');
const { requirePermission } = require('../middleware/authorization');
const { getProviderScope } = require('../middleware/providerScope');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: noteAttachmentsService.MAX_FILE_SIZE },
});

// =============================================================================
// Helpers
// =============================================================================
function requestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

function successResponse(data, reqId) {
    return {
        ok: true,
        data,
        meta: {
            request_id: reqId,
            timestamp: new Date().toISOString(),
        },
    };
}

function errorResponse(code, message, reqId) {
    return {
        ok: false,
        error: {
            code,
            message,
            correlation_id: reqId,
        },
    };
}

// CONTACT-EMAIL-MERGE-001: normalize a PATCH `emails[]` payload into a clean,
// de-duped list of { email, is_primary } with EXACTLY ONE primary. Rules:
//   • email_normalized = lower(trim(email)); blank / non-email-shaped dropped.
//   • de-duped by normalized address (first occurrence wins).
//   • exactly one primary: the first entry flagged is_primary wins; if none is
//     flagged, the first surviving entry becomes primary.
// Returns [] for a non-array / all-invalid payload.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeEmailsPayload(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    let flaggedIdx = -1;
    for (const entry of raw) {
        if (!entry || typeof entry.email !== 'string') continue;
        const email = entry.email.toLowerCase().trim();
        if (!email || !EMAIL_SHAPE.test(email)) continue;
        if (seen.has(email)) continue;
        seen.add(email);
        // first-flagged-primary wins
        if (flaggedIdx === -1 && entry.is_primary === true) flaggedIdx = out.length;
        out.push({ email, is_primary: false });
    }
    if (out.length === 0) return out;
    const primaryIdx = flaggedIdx === -1 ? 0 : flaggedIdx;
    out[primaryIdx].is_primary = true;
    return out;
}

// ── CONTACT-MERGE-001 (Decision A) — conflict round-trip helpers ─────────────

// 409 envelope for CONTACT_ATTRIBUTE_CONFLICT (mirrors the leads.js
// CONTACT_AMBIGUOUS precedent: ok:false error envelope + a data sibling).
function conflictResponse(conflicts, reqId) {
    return {
        ok: false,
        error: {
            code: 'CONTACT_ATTRIBUTE_CONFLICT',
            message: 'Submitted phone/email already belongs to another contact',
            correlation_id: reqId,
        },
        conflict: { conflicts },
    };
}

// Strict-echo matching of body `resolutions[]` against DETECTED conflicts:
// a conflict is resolved only by a resolution carrying the SAME owner_contact_id
// AND the SAME detected attribute set (echoed attributes = staleness check, S9).
// A resolution matching NO detected conflict is ignored (idempotency, FR-10);
// a MALFORMED resolution (unknown action / missing owner / attributes not an
// array / bad attribute shape) is simply non-matching — never a 500 (U13).
function matchResolutions(conflicts, rawResolutions) {
    const resolutions = Array.isArray(rawResolutions) ? rawResolutions : [];
    const matched = [];
    let allResolved = true;
    for (const conflict of conflicts) {
        const want = new Set(
            (conflict.attributes || []).map(a => `${a.kind}:${a.normalized}`)
        );
        const resolution = resolutions.find(r => {
            if (!r || typeof r !== 'object') return false;
            if (r.action !== 'merge' && r.action !== 'transfer') return false;
            if (r.owner_contact_id === undefined || r.owner_contact_id === null) return false;
            if (String(r.owner_contact_id) !== String(conflict.owner?.id)) return false;
            if (!Array.isArray(r.attributes) || r.attributes.length === 0) return false;
            const got = new Set();
            for (const a of r.attributes) {
                if (!a || (a.kind !== 'phone' && a.kind !== 'email')) return false;
                const norm = a.kind === 'phone'
                    ? String(a.value || '').replace(/\D/g, '')
                    : String(a.value || '').trim().toLowerCase();
                if (!norm) return false;
                got.add(`${a.kind}:${norm}`);
            }
            if (got.size !== want.size) return false;
            for (const key of want) {
                if (!got.has(key)) return false;
            }
            return true;
        });
        if (resolution) matched.push({ conflict, resolution });
        else allResolved = false;
    }
    return { matched, allResolved };
}

// =============================================================================
// GET /api/contacts — List contacts
// =============================================================================
router.get('/', requirePermission('contacts.view'), async (req, res) => {
    const reqId = requestId();
    try {
        const { search, offset, limit } = req.query;

        const params = {
            search: search || undefined,
            offset: offset ? Number(offset) : 0,
            limit: limit ? Math.min(Number(limit), 100) : 50,
            companyId: req.companyFilter?.company_id,
            providerScope: getProviderScope(req),
        };

        const result = await contactsService.listContacts(params);
        res.json(successResponse(result, reqId));
    } catch (err) {
        console.error(`[ContactsAPI][${reqId}] Error:`, err);
        res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
    }
});

// =============================================================================
// GET /api/contacts/search-candidates — Contact lookup for UI
// =============================================================================
router.get('/search-candidates', requirePermission('contacts.view'), async (req, res) => {
    const reqId = requestId();
    try {
        const { first_name, last_name, phone, email, q } = req.query;

        const companyId = req.companyFilter?.company_id || null;
        const result = await contactDedupeService.searchCandidates(
            { first_name: first_name || '', last_name: last_name || '', phone: phone || null, email: email || null, q: q || null },
            companyId
        );

        res.json(successResponse(result, reqId));
    } catch (err) {
        console.error(`[ContactsAPI][${reqId}] search-candidates error:`, err);
        res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
    }
});

// =============================================================================
// GET /api/contacts/:id — Get contact detail
// =============================================================================
router.get('/:id', requirePermission('contacts.view'), async (req, res) => {
    const reqId = requestId();
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json(errorResponse('INVALID_ID', 'Contact ID must be a number', reqId));
        }

        const companyId = req.companyFilter?.company_id;
        const contact = await contactsService.getContactById(id, companyId, getProviderScope(req));
        const leads = await contactsService.getContactLeads(id, companyId);

        // Surface ALL email addresses (primary + contact_emails) so the Pulse
        // composer's "To" dropdown can offer each one (EMAIL-TIMELINE-001 / TASK-ET-14).
        contact.contact_emails = await contactsService.getContactEmails(id, contact.email);

        // CONTACT-EMAIL-MERGE-001: richer {email,is_primary}[] shape (primary-first,
        // exactly one primary = the scalar) for the multi-email editor (T3). Purely
        // additive — the existing contact_emails string[] above is untouched.
        contact.emails = (contact.contact_emails || []).map((email, i) => ({
            email,
            is_primary: contact.email
                ? email.toLowerCase().trim() === contact.email.toLowerCase().trim()
                : i === 0,
        }));

        // Merge contact_addresses from our DB into contact.addresses
        const contactAddressService = require('../services/contactAddressService');
        const dbAddresses = await contactAddressService.getAddressesForContact(id);
        const mergedAddresses = dbAddresses.map(a => ({
            id: String(a.id),
            line1: a.street_line1,
            line2: a.street_line2 || '',
            city: a.city,
            state: a.state,
            postal_code: a.postal_code,
            lat: a.lat,
            lng: a.lng,
            nickname: a.label || null,
            is_default_address_for_customer: a.is_primary,
            formatted: a.display,
            source: 'local',
        }));
        // Zenbooker addresses stay, local addresses are appended (deduped by line1)
        const zbStreets = new Set((contact.addresses || []).map(a => (a.line1 || '').toLowerCase().trim()));
        const uniqueLocal = mergedAddresses.filter(a => !zbStreets.has((a.line1 || '').toLowerCase().trim()));
        contact.addresses = [...(contact.addresses || []), ...uniqueLocal];

        // Enforce single default: if multiple addresses are flagged as default, keep only the first
        const defaultAddrs = contact.addresses.filter(a => a.is_default_address_for_customer);
        if (defaultAddrs.length > 1) {
            // Keep the first default, clear the rest
            for (let i = 1; i < defaultAddrs.length; i++) {
                defaultAddrs[i].is_default_address_for_customer = false;
            }
        }

        res.json(successResponse({ contact, leads }, reqId));
    } catch (err) {
        if (err.code === 'NOT_FOUND') {
            return res.status(404).json(errorResponse('NOT_FOUND', err.message, reqId));
        }
        console.error(`[ContactsAPI][${reqId}] Error:`, err);
        res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
    }
});

// =============================================================================
// PATCH /api/contacts/:id — Update contact fields
// =============================================================================
router.patch('/:id', requirePermission('contacts.edit'), async (req, res) => {
    const reqId = requestId();
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json(errorResponse('INVALID_ID', 'Contact ID must be a number', reqId));
        }

        const companyId = req.companyFilter?.company_id;
        const existing = await contactsService.getById(id, companyId, getProviderScope(req));
        if (!existing) {
            return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));
        }

        const db = require('../db/connection');

        // CONTACT-EMAIL-MERGE-001: normalize the optional multi-email list up front
        // (before the tx). `emails` is an array, NOT a scalar column, so it is
        // handled OUTSIDE the allowedFields loop. Exactly one primary is enforced
        // here (first-flagged wins; if none flagged, the first entry is primary);
        // blanks / non-email-shaped values are dropped; addresses are lower(trim)'d
        // and de-duped. When `emails` is omitted the whole email path is skipped
        // (back-compatible — behavior is byte-for-byte unchanged).
        const emailsProvided = Array.isArray(req.body.emails);
        const submittedEmails = emailsProvided ? normalizeEmailsPayload(req.body.emails) : [];
        const primaryEmail = submittedEmails.find(e => e.is_primary)?.email || null;

        const allowedFields = ['first_name', 'last_name', 'company_name', 'phone_e164', 'secondary_phone', 'secondary_phone_name', 'email', 'notes'];
        const setClauses = [];
        const params = [];
        let paramIdx = 1;

        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                // When `emails` is provided, the scalar `contacts.email` is driven by
                // the primary of that list — skip any scalar `email` in the body so
                // the two never diverge (Decision C.2 / FR-2).
                if (field === 'email' && emailsProvided) continue;
                let value = req.body[field] || null;
                // Normalize phone fields to E.164
                if ((field === 'phone_e164' || field === 'secondary_phone') && value) {
                    value = toE164(value) || value;
                }
                setClauses.push(`${field} = $${paramIdx}`);
                params.push(value);
                paramIdx++;
            }
        }

        // Keep the scalar `contacts.email` in sync with the primary of `emails[]`.
        // Only forced when the list carries a primary (a removal-only `emails:[]`
        // leaves the scalar untouched here; the FR-8 delete loop handles rows).
        if (emailsProvided && primaryEmail) {
            setClauses.push(`email = $${paramIdx}`);
            params.push(primaryEmail);
            paramIdx++;
        }

        // `emails:[]` (e.g. a removal-only edit) is a VALID update — do not 400.
        if (setClauses.length === 0 && !emailsProvided) {
            return res.status(400).json(errorResponse('NO_FIELDS', 'No valid fields to update', reqId));
        }

        // Recalculate full_name
        const firstName = req.body.first_name !== undefined ? req.body.first_name : null;
        const lastName = req.body.last_name !== undefined ? req.body.last_name : null;

        // ── CONTACT-MERGE-001 detection inputs ──────────────────────────────
        // Added-phone candidates: every submitted phone slot, normalized exactly
        // as the UPDATE will write it. Detection itself excludes values already
        // on the target (S12), so an idempotent re-save never dialogs.
        const contactEmailMergeService = require('../services/contactEmailMergeService');
        const addedPhones = [];
        for (const field of ['phone_e164', 'secondary_phone']) {
            if (req.body[field] !== undefined && req.body[field]) {
                addedPhones.push(toE164(req.body[field]) || req.body[field]);
            }
        }
        // Decision E — scalar `email` WITHOUT emails[]: candidate for server-side
        // handling (detection + contact_emails persistence) when email-shaped.
        // `emails[]`, when present, takes precedence (scalar branch skipped).
        const scalarRaw = (!emailsProvided && req.body.email !== undefined)
            ? String(req.body.email || '').toLowerCase().trim()
            : '';
        const scalarCandidate = (scalarRaw && EMAIL_SHAPE.test(scalarRaw)) ? scalarRaw : null;

        // ── ONE transaction: conflict DETECTION (before ANY write) + resolution
        //    validation + contact UPDATE + contact_emails upsert/removal +
        //    resolution execution + the per-new-address merge are atomic
        //    (Decisions A/C). Round 1 with an unresolved conflict ROLLBACKs
        //    having written NOTHING → 409 with the full dialog payload. The
        //    async legs (leads cascade, phone orphan-merge, ZB push, the
        //    contact_merged event) run AFTER commit, outside the tx.
        const client = await db.pool.connect();
        let scalarNewlyAdded = false;
        const mergedEvents = []; // contact_merged payloads, emitted post-COMMIT (review fix c)
        try {
            await client.query('BEGIN');

            // Decision E: is the scalar a NEWLY-added address (not already on
            // the contact — scalar or contact_emails)? Read-only probe.
            if (scalarCandidate) {
                const additional = await contactDedupeService.getAdditionalEmails(id, client);
                const held = new Set(additional.map(e => (e || '').toLowerCase().trim()));
                if (existing.email) held.add(existing.email.toLowerCase().trim());
                scalarNewlyAdded = !held.has(scalarCandidate);
            }

            // (1) Detection FIRST — before ANY write (Decision C step 1). Locks
            //     the target + every owner row FOR UPDATE (ascending id order).
            const detectEmails = emailsProvided
                ? submittedEmails.map(e => e.email)
                : (scalarNewlyAdded ? [scalarCandidate] : []);
            const detectedConflicts = await contactEmailMergeService.detectAttributeConflicts(
                id, { phones: addedPhones, emails: detectEmails }, companyId, client
            );

            // (2) Strict-echo validation of resolutions[] (Decision C step 2).
            //     ANY detected conflict without a matching resolution → ROLLBACK
            //     (nothing was written) + 409 with the FULL current payload.
            // (1.5) Pre-upsert ownership probe (CM1-T5 harness finding): the
            //     step-3 email upsert makes the TARGET the owner of every
            //     submitted address, so by step 5 findEmailContact resolves to
            //     the target and resolveAddedEmail's owner==target no-op
            //     swallows the D3 inbox-only link — stray inbox messages were
            //     never folded onto the timeline through the route (the
            //     service-level CEM1 harness verified the branch PRE-upsert,
            //     masking this). Read-only, before ANY write: remember which
            //     newly-added addresses are ownerless NOW; step 5 supplements
            //     the (unchanged) resolveAddedEmail call with the idempotent
            //     inbox-only link for exactly those addresses.
            const preOwnerlessEmails = new Set();
            {
                const emailQueries = require('../db/emailQueries');
                const candidates = emailsProvided
                    ? submittedEmails.map(e => e.email)
                    : (scalarNewlyAdded ? [scalarCandidate] : []);
                for (const email of candidates) {
                    const owner = await emailQueries.findEmailContact(email, companyId, client);
                    if (!owner) preOwnerlessEmails.add(email);
                }
            }

            const { matched, allResolved } = matchResolutions(detectedConflicts, req.body.resolutions);
            if (!allResolved) {
                await client.query('ROLLBACK');
                return res.status(409).json(conflictResponse(detectedConflicts, reqId));
            }
            const conflictedEmails = new Set();
            for (const c of detectedConflicts) {
                for (const a of c.attributes) {
                    if (a.kind === 'email') conflictedEmails.add(a.normalized);
                }
            }

            // (2.5) Pre-release colliding owner SCALARS (CM1-T5 harness finding):
            // `uq_contacts_email` is a GLOBAL partial unique index on
            // contacts.email, so the step-3 target UPDATE writing a resolved
            // address as the scalar would collide with the still-alive owner row
            // (the merge delete / transferEmail scalar-sync only run at step 4).
            // For each VALIDATED resolution whose owner's scalar IS one of the
            // resolved addresses, run the transferEmail scalar-sync EARLY: point
            // the owner's scalar at its remaining (non-conflicted)
            // primary-or-first contact_emails row, or NULL. Semantics match
            // transferEmail's own sync (which then no-ops); for a merge the
            // owner is deleted this tx, so the early sync is invisible. Locked
            // rows (detection FOR UPDATE) + same tx → rolled back with the rest.
            for (const { conflict } of matched) {
                const ownEmails = conflict.attributes
                    .filter(a => a.kind === 'email')
                    .map(a => a.normalized);
                if (ownEmails.length === 0) continue;
                await client.query(
                    `UPDATE contacts c
                        SET email = (
                            SELECT ce.email FROM contact_emails ce
                             WHERE ce.contact_id = c.id
                               AND ce.email_normalized <> ALL($3)
                             ORDER BY ce.is_primary DESC, ce.id ASC
                             LIMIT 1),
                            updated_at = now()
                      WHERE c.id = $1 AND c.company_id = $2
                        AND lower(trim(c.email)) = ANY($3)`,
                    [conflict.owner.id, companyId, ownEmails]
                );
            }

            if (firstName !== null || lastName !== null) {
                // Need current values for the ones not being updated.
                const { rows: current } = await client.query('SELECT first_name, last_name FROM contacts WHERE id = $1 AND company_id = $2', [id, companyId]);
                if (current.length === 0) {
                    await client.query('ROLLBACK');
                    return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));
                }
                const fn = firstName !== null ? firstName : current[0].first_name;
                const ln = lastName !== null ? lastName : current[0].last_name;
                const fullName = [fn, ln].filter(Boolean).join(' ') || null;
                setClauses.push(`full_name = $${paramIdx}`);
                params.push(fullName);
                paramIdx++;
            }

            if (setClauses.length > 0) {
                setClauses.push(`updated_at = NOW()`);
                const updateParams = [...params, id, companyId];
                await client.query(
                    `UPDATE contacts SET ${setClauses.join(', ')} WHERE id = $${paramIdx} AND company_id = $${paramIdx + 1}`,
                    updateParams
                );
            }

            // ── (3) Multi-email persistence (inside the tx, on the tx client) ──
            let existingSet = null;
            if (emailsProvided) {
                // Current set = the scalar primary + every contact_emails row, so
                // "newly added in THIS patch" excludes anything already recorded
                // (idempotent re-save does no merge work — TC-CEM-U11).
                const additional = await contactDedupeService.getAdditionalEmails(id, client);
                existingSet = new Set(additional.map(e => (e || '').toLowerCase().trim()));
                if (existing.email) existingSet.add(existing.email.toLowerCase().trim());

                const submittedSet = new Set(submittedEmails.map(e => e.email));

                // (1) Upsert each submitted address (ON CONFLICT DO NOTHING).
                for (const { email } of submittedEmails) {
                    await contactDedupeService.enrichEmail(id, email, client);
                }

                // (2) Reconcile is_primary flags so exactly one row is primary and
                //     it matches the scalar (enrichEmail only sets primary when the
                //     contact had none — it never re-assigns an existing primary).
                if (primaryEmail) {
                    await client.query(
                        `UPDATE contact_emails SET is_primary = (email_normalized = $2) WHERE contact_id = $1`,
                        [id, primaryEmail]
                    );
                }

                // (3) FR-8 non-destructive removal: a row dropped from the list is
                //     deleted, but any already-linked email_messages history stays
                //     put (no reverse-merge, no message un-link — TC-CEM-U13).
                for (const gone of existingSet) {
                    if (!submittedSet.has(gone)) {
                        // Never delete the address we just kept as the scalar primary.
                        if (primaryEmail && gone === primaryEmail) continue;
                        await client.query(
                            `DELETE FROM contact_emails WHERE contact_id = $1 AND email_normalized = $2`,
                            [id, gone]
                        );
                    }
                }
            } else if (scalarNewlyAdded) {
                // Decision E: the scalar path now ALSO persists contact_emails
                // (the 4175/4228 hole — closed for EVERY client of the route).
                // The scalar column itself was written by the UPDATE above.
                await contactDedupeService.enrichEmail(id, scalarCandidate, client);
            }

            // ── (4) Execute the validated resolutions (Decision C step 4) ──
            for (const { conflict, resolution } of matched) {
                const ownerId = conflict.owner.id;
                if (resolution.action === 'merge') {
                    // Returns the contact_merged event payload — emitted only
                    // AFTER COMMIT (review fix c: never survives a ROLLBACK).
                    const mergedEvent = await contactEmailMergeService.mergeContacts(
                        id, ownerId, companyId, client
                    );
                    if (mergedEvent) mergedEvents.push(mergedEvent);
                } else {
                    // FR-3 re-check at EXECUTION time — a stale-allowed transfer
                    // throws the sentinel → ROLLBACK → fresh 409 (never half-run).
                    await contactEmailMergeService.assertTransferAllowed(
                        ownerId, conflict.attributes, companyId, client
                    );
                    for (const attr of conflict.attributes) {
                        if (attr.kind === 'phone') {
                            await contactEmailMergeService.transferPhone(
                                id, ownerId, attr.normalized || attr.value, companyId, client
                            );
                        } else {
                            await contactEmailMergeService.transferEmail(
                                id, ownerId, attr.normalized || attr.value, companyId, client
                            );
                        }
                    }
                }
            }

            // ── (5) For each NEWLY-added NON-conflicted address, resolve its
            //     correspondence and fold it onto this contact's timeline
            //     (inbox-only link / self no-op) — synchronously, on the SAME tx
            //     client. A separate-owner surprise born INSIDE the tx throws
            //     the ContactConflictError sentinel → caught below → fresh 409.
            if (emailsProvided) {
                for (const { email } of submittedEmails) {
                    if (!existingSet.has(email) && !conflictedEmails.has(email)) {
                        await contactEmailMergeService.resolveAddedEmail(id, email, companyId, client);
                        // The D3 inbox-only link for a PRE-upsert-ownerless
                        // address (see step 1.5): resolveAddedEmail above hit
                        // its owner==target no-op (the upsert just made the
                        // target the owner), so fold the stray inbox messages
                        // explicitly — idempotent, same-tx, same semantics as
                        // the service's own inbox-only branch.
                        if (preOwnerlessEmails.has(email)) {
                            await contactEmailMergeService.linkInboxMessages(id, email, companyId, client);
                        }
                    }
                }
            } else if (scalarNewlyAdded && !conflictedEmails.has(scalarCandidate)) {
                await contactEmailMergeService.resolveAddedEmail(id, scalarCandidate, companyId, client);
                if (preOwnerlessEmails.has(scalarCandidate)) {
                    await contactEmailMergeService.linkInboxMessages(id, scalarCandidate, companyId, client);
                }
            }

            await client.query('COMMIT');
        } catch (txErr) {
            await client.query('ROLLBACK').catch(() => {});
            // A conflict born INSIDE the tx (sentinel from step 5 / the FR-3
            // execution-time re-check) or a lock-order deadlock (40P01, review
            // fix a belt-and-braces) → fresh 409, NEVER a 500. The payload is
            // re-detected post-rollback on the pool (current reality, S9/S14).
            if (txErr && (txErr.name === 'ContactConflictError' || txErr.code === '40P01')) {
                let freshConflicts = [];
                try {
                    const detectEmails = emailsProvided
                        ? submittedEmails.map(e => e.email)
                        : (scalarCandidate ? [scalarCandidate] : []);
                    freshConflicts = await contactEmailMergeService.detectAttributeConflicts(
                        id, { phones: addedPhones, emails: detectEmails }, companyId
                    );
                } catch (redetectErr) {
                    console.warn(`[ContactsAPI][${reqId}] fresh-409 re-detection failed (returning empty payload):`, redetectErr.message);
                }
                return res.status(409).json(conflictResponse(freshConflicts, reqId));
            }
            throw txErr;
        } finally {
            client.release();
        }

        // CONTACT-MERGE-001 (review fix c): the contact_merged audit event is
        // emitted strictly AFTER COMMIT, so it can never survive a ROLLBACK.
        for (const mergedEvent of mergedEvents) {
            eventService.logEvent(companyId, 'contact', id, 'contact_merged', mergedEvent);
        }

        // Cascade contact fields to linked leads (post-commit, on the pool — an
        // async best-effort leg, unchanged; reflects the post-merge state).
        const updated = await contactsService.getContactById(id, companyId);
        await db.query(
            `UPDATE leads
             SET first_name = $1, last_name = $2, phone = $3, email = $4,
                 second_phone = $5, second_phone_name = $6, company = $7, updated_at = NOW()
             WHERE contact_id = $8 AND company_id = $9`,
            [updated.first_name || '', updated.last_name || '', updated.phone_e164 || '', updated.email || '',
            updated.secondary_phone || null, updated.secondary_phone_name || null, updated.company_name || null, id, companyId]
        );
        console.log(`[ContactsAPI][${reqId}] Cascaded contact fields to linked leads for contact ${id}`);

        // Async: merge orphan timelines matching this contact's phones
        (async () => {
            try {
                const { mergeOrphanTimelines } = require('../services/timelineMergeService');
                await mergeOrphanTimelines(id, [updated.phone_e164, updated.secondary_phone], `[ContactsAPI][${reqId}]`);
            } catch (mergeErr) {
                console.warn(`[ContactsAPI][${reqId}] Timeline merge error (non-blocking):`, mergeErr.message);
            }
        })();

        // Return updated contact
        res.json(successResponse({ contact: updated }, reqId));

        // Async: push to Zenbooker if linked
        if (zenbookerSyncService.FEATURE_ENABLED && updated.zenbooker_customer_id) {
            zenbookerSyncService.syncContactToZenbooker(id).catch(err =>
                console.error(`[ContactsAPI][${reqId}] Zenbooker sync error (non-blocking):`, err.message)
            );
        }
    } catch (err) {
        if (err.code === 'NOT_FOUND') {
            return res.status(404).json(errorResponse('NOT_FOUND', err.message, reqId));
        }
        console.error(`[ContactsAPI][${reqId}] Error:`, err);
        res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
    }
});

// =============================================================================
// GET /api/contacts/:id/addresses — List contact addresses
// =============================================================================
router.get('/:id/addresses', requirePermission('contacts.view'), async (req, res) => {
    const reqId = requestId();
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json(errorResponse('INVALID_ID', 'Contact ID must be a number', reqId));
        }

        const owned = await contactsService.getById(id, req.companyFilter?.company_id, getProviderScope(req));
        if (!owned) return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));

        const contactAddressService = require('../services/contactAddressService');
        const addresses = await contactAddressService.getAddressesForContact(id);
        res.json(successResponse({ addresses }, reqId));
    } catch (err) {
        console.error(`[ContactsAPI][${reqId}] Error:`, err);
        res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
    }
});

// =============================================================================
// PATCH /api/contacts/:id/addresses/:addressId — Update contact address
// =============================================================================
router.patch('/:id/addresses/:addressId', requirePermission('contacts.edit'), async (req, res) => {
    const reqId = requestId();
    try {
        const contactId = Number(req.params.id);
        const addressId = Number(req.params.addressId);
        if (isNaN(contactId) || isNaN(addressId)) {
            return res.status(400).json(errorResponse('INVALID_ID', 'IDs must be numbers', reqId));
        }

        const ownedContact = await contactsService.getById(contactId, req.companyFilter?.company_id, getProviderScope(req));
        if (!ownedContact) return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));

        const contactAddressService = require('../services/contactAddressService');
        const db = require('../db/connection');

        // Verify address belongs to contact
        const valid = await contactAddressService.validateAddressBelongsToContact(addressId, contactId);
        if (!valid) {
            return res.status(404).json(errorResponse('NOT_FOUND', 'Address not found for this contact', reqId));
        }

        const { street, apt, city, state, zip, lat, lng, placeId } = req.body;
        const hash = contactAddressService.computeNormalizedHash({ street, city, state, zip });

        await db.query(
            `UPDATE contact_addresses
             SET street_line1 = $1, street_line2 = $2, city = $3, state = $4, postal_code = $5,
                 lat = $6, lng = $7, google_place_id = $8, address_normalized_hash = $9, updated_at = NOW()
             WHERE id = $10`,
            [street || '', apt || null, city || '', state || '', zip || '',
            lat || null, lng || null, placeId || null, hash, addressId]
        );

        // Cascade address fields to linked leads
        await db.query(
            `UPDATE leads
             SET address = $1, unit = $2, city = $3, state = $4, postal_code = $5, updated_at = NOW()
             WHERE contact_address_id = $6`,
            [street || '', apt || '', city || '', state || '', zip || '', addressId]
        );
        console.log(`[ContactsAPI][${reqId}] Cascaded address fields to leads with contact_address_id ${addressId}`);

        const addresses = await contactAddressService.getAddressesForContact(contactId);
        res.json(successResponse({ addresses }, reqId));

        // Async: push address to Zenbooker if linked
        if (zenbookerSyncService.FEATURE_ENABLED) {
            zenbookerSyncService.syncAddressToZenbooker(contactId, addressId).catch(err =>
                console.error(`[ContactsAPI][${reqId}] Zenbooker address sync error (non-blocking):`, err.message)
            );
        }
    } catch (err) {
        console.error(`[ContactsAPI][${reqId}] Error:`, err);
        res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
    }
});

// =============================================================================
// PUT /api/contacts/:id/addresses/:addressId/default — Set default address
// =============================================================================
router.put('/:id/addresses/:addressId/default', requirePermission('contacts.edit'), async (req, res) => {
    const reqId = requestId();
    try {
        const contactId = Number(req.params.id);
        const addressId = Number(req.params.addressId);
        if (isNaN(contactId) || isNaN(addressId)) {
            return res.status(400).json(errorResponse('INVALID_ID', 'IDs must be numbers', reqId));
        }

        const ownedContact2 = await contactsService.getById(contactId, req.companyFilter?.company_id, getProviderScope(req));
        if (!ownedContact2) return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));

        const contactAddressService = require('../services/contactAddressService');

        // Verify address belongs to contact
        const valid = await contactAddressService.validateAddressBelongsToContact(addressId, contactId);
        if (!valid) {
            return res.status(404).json(errorResponse('NOT_FOUND', 'Address not found for this contact', reqId));
        }

        await contactAddressService.setDefaultAddress(contactId, addressId);
        const addresses = await contactAddressService.getAddressesForContact(contactId);
        res.json(successResponse({ addresses }, reqId));
    } catch (err) {
        console.error(`[ContactsAPI][${reqId}] Error:`, err);
        res.status(500).json(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', reqId));
    }
});

// =============================================================================
// Structured Notes (with file attachments)
// =============================================================================

router.get('/:id/history', requirePermission('contacts.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const contactId = parseInt(req.params.id, 10);
        const contact = await contactsService.getById(contactId, companyId, getProviderScope(req));
        if (!contact) return res.status(404).json({ ok: false, error: 'Contact not found' });

        const history = await eventService.getEntityHistory(companyId, 'contact', contactId, contact.structured_notes || []);
        res.json({ ok: true, data: history });
    } catch (err) {
        console.error('[Contacts] History error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Note-mutation helpers (shared by PATCH/DELETE note routes, NOTES-001) ────

function isAdminActor(req) {
    return req.user?._devMode
        || req.authz?.membership?.role_key === 'tenant_admin'
        || (req.user?.roles || []).includes('company_admin');
}

function buildNoteActor(req) {
    return {
        sub: req.user?.sub || null,
        // Real crm_users.id so a non-admin author is recognised when created_by was
        // stamped with the crm_users.id (NOTE-AUTHOR-FIX-001).
        crmUserId: req.user?.crmUser?.id || req.user?.sub || null,
        name: req.user?.name || null,
        isAdmin: isAdminActor(req),
    };
}

function parseRemoveAttachmentIds(raw) {
    if (raw == null || raw === '') return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
            if (parsed == null) return [];
            return [parsed];
        } catch {
            return [raw];
        }
    }
    return [raw];
}

// Build the GET-shaped, soft-delete-excluded notes list for a contact.
async function enrichContactNotes(companyId, contactId, notes, actor = null) {
    const attachments = await noteAttachmentsService.getAttachmentsForEntity(companyId, 'contact', contactId);
    const byNoteId = {};
    const byNoteIndex = {};
    for (const a of attachments) {
        if (a.noteId) (byNoteId[a.noteId] ||= []).push(a);
        else (byNoteIndex[a.noteIndex] ||= []).push(a);
    }
    return (notes || [])
        .map((n, i) => ({ n, i }))
        .filter(({ n }) => !n.deleted_at)
        .map(({ n, i }) => ({
            ...n,
            id: n.id || null,
            created_by: n.created_by || null,
            source: n.source || null,
            zb_note_id: n.zb_note_id || null,
            attachments: (n.id && byNoteId[n.id]) || byNoteIndex[i] || [],
            // Server-authoritative edit/delete permission (NOTE-AUTHOR-FIX-001).
            can_edit: actor
                ? notesMutationService.canMutateNote(n, { isAdmin: actor.isAdmin, actorSub: actor.sub, actorCrmUserId: actor.crmUserId })
                : undefined,
        }));
}

router.get('/:id/notes', requirePermission('contacts.view'), async (req, res) => {
    const reqId = requestId();
    try {
        const companyId = req.companyFilter?.company_id;
        const contactId = parseInt(req.params.id, 10);
        const contact = await contactsService.getById(contactId, companyId, getProviderScope(req));
        if (!contact) return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));

        const enriched = await enrichContactNotes(companyId, contactId, contact.structured_notes || [], buildNoteActor(req));
        res.json(successResponse(enriched, reqId));
    } catch (err) {
        console.error(`[ContactsAPI][${reqId}] Get notes error:`, err.message);
        res.status(500).json(errorResponse('INTERNAL_ERROR', err.message, reqId));
    }
});

router.post('/:id/notes', requirePermission('contacts.edit'), upload.array('attachments', noteAttachmentsService.MAX_FILES_PER_NOTE), async (req, res) => {
    const reqId = requestId();
    try {
        const companyId = req.companyFilter?.company_id;
        const userId = req.user?.crmUser?.id || req.user?.sub || null;
        const contactId = parseInt(req.params.id, 10);
        const contact = await contactsService.getById(contactId, companyId, getProviderScope(req));
        if (!contact) return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));

        const text = (req.body.text || '').trim();
        const files = req.files || [];
        const attachmentIds = parseRemoveAttachmentIds(req.body.attachment_ids); // tolerant id-array parse
        if (!text && files.length === 0 && attachmentIds.length === 0) return res.status(400).json(errorResponse('BAD_REQUEST', 'text or attachments required', reqId));

        const existingNotes = contact.structured_notes || [];

        // Migrate legacy notes text on first structured note
        if (existingNotes.length === 0 && contact.notes?.trim()) {
            existingNotes.push({ text: contact.notes.trim(), created: contact.created_at || new Date().toISOString(), migrated: true });
        }

        const noteIndex = existingNotes.length;
        const noteId = randomUUID();
        let attachmentsMeta = [];
        if (attachmentIds.length > 0) {
            // NOTE-ATTACH-UPLOAD-001: files pre-uploaded (staged) — link them to the note.
            attachmentsMeta = await noteAttachmentsService.associateStagedAttachments(
                companyId, 'contact', contactId, attachmentIds, noteId, noteIndex
            );
        } else if (files.length > 0) {
            attachmentsMeta = await noteAttachmentsService.createAttachments(
                companyId, 'contact', contactId, noteIndex, files, userId, { noteId }
            );
        }

        const author = req.user?.name?.split(' ')[0] || req.user?.email || null;
        const note = { id: noteId, text, created: new Date().toISOString(), created_by: userId, ...(author && { author }) };
        if (attachmentsMeta.length > 0) {
            note.attachments = attachmentsMeta.map(a => ({
                id: a.id, fileName: a.file_name, contentType: a.content_type, fileSize: a.file_size,
            }));
        }

        const updatedNotes = [...existingNotes, note];
        const db = require('../db/connection');
        await db.query(
            'UPDATE contacts SET structured_notes = $1::jsonb, updated_at = NOW() WHERE id = $2 AND company_id = $3',
            [JSON.stringify(updatedNotes), contactId, companyId]
        );

        res.json(successResponse({ notes: updatedNotes }, reqId));
    } catch (err) {
        console.error(`[ContactsAPI][${reqId}] Add note error:`, err.message);
        const status = err.status || 500;
        res.status(status).json(errorResponse('INTERNAL_ERROR', err.message, reqId));
    }
});

// ─── Edit / Delete Note (NOTES-001) ──────────────────────────────────────────

function buildContactNoteAdapter(companyId, contactId, scope) {
    const db = require('../db/connection');
    return {
        entityType: 'contact',
        attachmentEntityId: contactId,
        async loadNotes() {
            const contact = await contactsService.getById(contactId, companyId, scope);
            return contact ? (contact.structured_notes || []) : null;
        },
        async saveNotes(notes) {
            await db.query(
                'UPDATE contacts SET structured_notes = $1::jsonb, updated_at = NOW() WHERE id = $2 AND company_id = $3',
                [JSON.stringify(notes), contactId, companyId]
            );
        },
    };
}

router.patch('/:id/notes/:noteId', requirePermission('contacts.edit'), upload.array('attachments', noteAttachmentsService.MAX_FILES_PER_NOTE), async (req, res) => {
    const reqId = requestId();
    try {
        const companyId = req.companyFilter?.company_id;
        const contactId = parseInt(req.params.id, 10);
        const scope = getProviderScope(req);
        const contact = await contactsService.getById(contactId, companyId, scope);
        if (!contact) return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));

        const adapter = buildContactNoteAdapter(companyId, contactId, scope);
        const { note, oldText, addedNames, removedNames } = await notesMutationService.editNote(
            adapter,
            req.params.noteId,
            {
                text: req.body.text,
                removeAttachmentIds: parseRemoveAttachmentIds(req.body.remove_attachment_ids),
                attachmentIds: parseRemoveAttachmentIds(req.body.attachment_ids),
                files: req.files || [],
                actor: buildNoteActor(req),
                companyId,
            }
        );

        eventService.logEvent(companyId, 'contact', contactId, 'note_edited', {
            note_id: note.id, old_text: oldText, new_text: note.text,
            added: addedNames, removed: removedNames, actor_name: eventService.actorName(req),
        }, 'user', req.user?.sub);

        const enriched = await enrichContactNotes(companyId, contactId, await adapter.loadNotes(), buildNoteActor(req));
        res.json(successResponse({ notes: enriched }, reqId));
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error(`[ContactsAPI][${reqId}] Edit note error:`, err.message);
        res.status(status).json(errorResponse(status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR', err.message, reqId));
    }
});

router.delete('/:id/notes/:noteId', requirePermission('contacts.edit'), async (req, res) => {
    const reqId = requestId();
    try {
        const companyId = req.companyFilter?.company_id;
        const contactId = parseInt(req.params.id, 10);
        const scope = getProviderScope(req);
        const contact = await contactsService.getById(contactId, companyId, scope);
        if (!contact) return res.status(404).json(errorResponse('NOT_FOUND', 'Contact not found', reqId));

        const adapter = buildContactNoteAdapter(companyId, contactId, scope);
        const { note } = await notesMutationService.softDeleteNote(adapter, req.params.noteId, {
            actor: buildNoteActor(req),
            companyId,
        });

        eventService.logEvent(companyId, 'contact', contactId, 'note_deleted', {
            note_id: note.id, deleted_text: note.text || '', actor_name: eventService.actorName(req),
        }, 'user', req.user?.sub);

        const enriched = await enrichContactNotes(companyId, contactId, await adapter.loadNotes(), buildNoteActor(req));
        res.json(successResponse({ notes: enriched }, reqId));
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error(`[ContactsAPI][${reqId}] Delete note error:`, err.message);
        res.status(status).json(errorResponse(status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR', err.message, reqId));
    }
});

module.exports = router;
