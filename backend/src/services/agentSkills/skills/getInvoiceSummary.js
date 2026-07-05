/**
 * agentSkills / skills / getInvoiceSummary — read, L2 (sensitive)
 * (AGENT-SKILLS-001, spec §4.9 / task T6 · FR-S9 / FR-C5)
 *
 * "What's my balance?" — state the balance + status; hand PAYMENT to a secure link
 * or a human. Returns `{ ok, invoiceNumber, status, total, amountPaid, balanceDue, speak }`.
 *
 * PRIVACY / GUARDRAILS (P0):
 *   - L2-only (amounts are L2 — spec §2.5). The gate already enforced L2 before
 *     `run`; we re-check (defense-in-depth): non-L2 / no contactId → soft needs-verify.
 *   - Company isolation + contact ownership. Every getter is company-scoped, and
 *     the resolved invoice MUST belong to the verified contact. A foreign/other-
 *     company invoice id → company-scoped getter throws NOT_FOUND → not-found-safe.
 *     A cross-contact invoice → treated as not-found (amounts NEVER guessed, NEVER
 *     read for a document that isn't the caller's).
 *   - **NO CARD / PAYMENT CAPTURE BY VOICE — EVER (P0, spec §9).** This skill takes
 *     NO card/PAN/CVV/payment field, returns NO payment-collection field, and its
 *     `speak` routes payment to a SECURE LINK (SEND-DOC-001) or a human — never a
 *     spoken card handoff. There is deliberately no code path here that accepts or
 *     forwards payment details.
 *
 * Service calls (real signatures, verified):
 *   - invoicesService.listInvoices(companyId, { contactId }) → { rows, total }.
 *   - invoicesService.getInvoice(companyId, id) → { ...invoice, items } (THROWS
 *     InvoicesServiceError NOT_FOUND when absent/foreign — company-scoped).
 */

'use strict';

const invoicesService = require('../../invoicesService');
const resultShapes = require('../resultShapes');

/**
 * Belt-and-braces L2 + contact-ownership guard (see getJobHistory for the same
 * rationale). True → a verified (L2) identity bound to a concrete contactId.
 * @param {{ level?:string, contactId?:number|null }} ctx verifiedContext.
 * @returns {boolean}
 */
function isVerifiedContact(ctx) {
    return Boolean(ctx && ctx.level === 'L2' && ctx.contactId != null && ctx.contactId !== '');
}

/** Coerce a money-ish column to a finite Number (defaults 0). NUMERIC comes back as a string from pg. */
function toAmount(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Same-owner check: does this invoice belong to the verified contact? Direct
 * contact match only (the invoice shape is contact-scoped; §4.9 input is
 * contactId + invoiceId). Anything else is NOT the caller's document.
 * @param {object} inv An invoice row / detail.
 * @param {number|string} contactId Verified contact id.
 * @returns {boolean}
 */
function invoiceBelongsToContact(inv, contactId) {
    return Boolean(inv && inv.contact_id != null && String(inv.contact_id) === String(contactId));
}

/** The canonical not-found-safe refusal for this skill (no amount, no disclosure). */
function notFound() {
    return resultShapes.refusal("I don't see an invoice on file for that. I can have a teammate follow up if you'd like.");
}

/**
 * Build the speech-safe success shape from an invoice detail. States balance +
 * status; routes payment to a secure link / human (NEVER a card by voice). No
 * line items are surfaced.
 * @param {object} inv Invoice detail / row.
 * @returns {object}
 */
function summarize(inv) {
    const total = toAmount(inv.total);
    const amountPaid = toAmount(inv.amount_paid);
    const balanceDue = toAmount(inv.balance_due);
    const invoiceNumber = inv.invoice_number || '';
    const status = inv.status || '';
    const numberPhrase = invoiceNumber ? `Invoice ${invoiceNumber}` : 'Your invoice';

    let speak;
    if (balanceDue > 0) {
        speak =
            `${numberPhrase} has a balance of $${balanceDue.toFixed(2)} on a total of $${total.toFixed(2)}. ` +
            `I can't take a card over the phone, but I can text you a secure payment link, or connect you with a teammate — which would you prefer?`;
    } else {
        speak = `${numberPhrase} is paid in full — there's no balance due. Is there anything else I can help with?`;
    }

    return resultShapes.ok(speak, {
        invoiceNumber,
        status,
        total,
        amountPaid,
        balanceDue,
    });
}

/**
 * getInvoiceSummary — L2 sensitive read. See file header.
 * @param {string} companyId Tenant scope (server-provided).
 * @param {{ level:'L0'|'L1'|'L2', contactId:number|null }} verifiedContext Server-derived.
 * @param {{ invoiceId?:string|number, invoice_id?:string|number }} input Skill payload.
 * @returns {Promise<object>} speech-safe summary / not-found-safe / soft refusal.
 */
async function run(companyId, verifiedContext, input = {}) {
    if (!isVerifiedContact(verifiedContext)) {
        return resultShapes.needsVerification();
    }

    const contactId = verifiedContext.contactId;
    const invoiceId = input.invoiceId != null ? input.invoiceId : input.invoice_id;

    // (A) Specific invoice id → company-scoped fetch, then confirm ownership.
    if (invoiceId != null && invoiceId !== '') {
        let inv;
        try {
            inv = await invoicesService.getInvoice(companyId, invoiceId);
        } catch (err) {
            // NOT_FOUND (foreign/unknown, company-scoped) → not-found-safe. Any other
            // internal error bubbles to the choke-point's SAFE_FALLBACK.
            if (err && (err.code === 'NOT_FOUND' || err.status === 404)) return notFound();
            throw err;
        }
        if (!invoiceBelongsToContact(inv, contactId)) return notFound();
        return summarize(inv);
    }

    // (B) No id → list the contact's invoices (already contact-scoped), pick most
    //     recent with a balance-relevant view. listInvoices orders newest-first.
    const { rows } = await invoicesService.listInvoices(companyId, { contactId });
    if (!Array.isArray(rows) || rows.length === 0) return notFound();

    const row = rows.find((r) => invoiceBelongsToContact(r, contactId));
    if (!row) return notFound();

    // List rows already carry the money columns (i.*), so summarize directly —
    // no line items are read regardless.
    return summarize(row);
}

module.exports = { run };
