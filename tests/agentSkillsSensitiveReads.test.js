/**
 * agentSkillsSensitiveReads.test.js — protected reads through the shared skill gate
 *
 * Mocked-unit proof of L2 job history and the owner-approved L1 finance reads
 * through the real `runSkill` choke-point with the gate granting L2 (which also
 * satisfies L1). Covers:
 *   - ASK-SKILL-HIST-01: summarized timeline, internal/technician-private notes
 *     REDACTED (verbatim text absent), getEntityHistory called with companyId.
 *   - ASK-SKILL-EST-01 / ASK-ISO-05 / E12: customer-safe line items + totals;
 *     foreign/cross-contact estimate → not-found-safe, no amount leak.
 *   - ASK-SKILL-INV-01 / ASK-ISO-06 / E12: balance + status; foreign invoice →
 *     not-found-safe, no amounts leaked; no-card invariant (no PAN/CVV field/path).
 *   - ASK-SEC-01/02/04: no card by voice; no full street address; existence-only
 *     below L2 (proven complementarily in the gate + read suites).
 *
 * ownership is CONTACT-scoped: a job/estimate/invoice under the same company but a
 * different contact must be refused (not just cross-company).
 */

'use strict';

const AGENT = '../backend/src/services/agentSkills';
const CO = '00000000-0000-0000-0000-000000000001';
const CONTACT = 501;
const OTHER_CONTACT = 777;

jest.mock('../backend/src/services/agentSkills/verificationGate', () => {
    const REAL = jest.requireActual('../backend/src/services/agentSkills/verificationGate');
    return { ...REAL, deriveLevel: jest.fn() };
});
const gate = require('../backend/src/services/agentSkills/verificationGate');

jest.mock('../backend/src/services/jobsService', () => ({ getJobById: jest.fn() }));
jest.mock('../backend/src/services/eventService', () => ({ getEntityHistory: jest.fn(async () => []) }));
jest.mock('../backend/src/services/estimatesService', () => ({ listEstimates: jest.fn(async () => ({ rows: [] })), getEstimate: jest.fn() }));
jest.mock('../backend/src/services/invoicesService', () => ({ listInvoices: jest.fn(async () => ({ rows: [] })), getInvoice: jest.fn() }));

const jobsService = require('../backend/src/services/jobsService');
const eventService = require('../backend/src/services/eventService');
const estimatesService = require('../backend/src/services/estimatesService');
const invoicesService = require('../backend/src/services/invoicesService');
const { runSkill } = require(AGENT);

const L2 = { level: 'L2', contactId: CONTACT, customerName: 'Jane Smith', matchedPhone: '6175551212' };

beforeEach(() => {
    jest.clearAllMocks();
    gate.deriveLevel.mockResolvedValue(L2);
});

// ════════════════════════════════════════════════════════════════════════════
// getJobHistory (L2) — redaction
// ════════════════════════════════════════════════════════════════════════════

describe('getJobHistory (L2) — ASK-SKILL-HIST-01 (redaction)', () => {
    const SECRET_NOTE = 'INTERNAL: customer is a known chargeback risk, card ****1234, do not disclose';
    const TECH_NOTE = 'Tech Bob: compressor shot, quoted extra cash on the side';
    const CUSTOMER_NOTE = 'Called customer to confirm the appointment window.';

    test('internal + technician-private notes are dropped; customer-facing note summarized; getEntityHistory scoped to companyId', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 7, contact_id: CONTACT, service_name: 'Refrigerator Repair', notes: [] });
        eventService.getEntityHistory.mockResolvedValue([
            { type: 'note', text: SECRET_NOTE, author: 'system', data: { internal: true }, created_at: '2026-07-01T10:00:00Z' },
            { type: 'note', text: TECH_NOTE, author: 'Bob (Technician)', created_at: '2026-07-02T10:00:00Z' },
            { type: 'note', text: CUSTOMER_NOTE, author: 'AI Phone', created_at: '2026-07-03T10:00:00Z' },
            { type: 'event', description: 'Status changed to Waiting for parts', created_at: '2026-07-03T11:00:00Z' },
        ]);

        const out = await runSkill('getJobHistory', CO, {}, { contactId: CONTACT, jobId: 7 });
        expect(out.ok).toBe(true);
        expect(eventService.getEntityHistory).toHaveBeenCalledWith(CO, 'job', 7, expect.any(Array));

        const dump = JSON.stringify(out);
        // the internal + tech-private verbatim text must NOT appear anywhere
        expect(dump).not.toMatch(/chargeback|card|1234|cash on the side|Bob/i);
        // the customer-facing note IS surfaced (summarized)
        const summaries = out.timeline.map((t) => t.note_summary + ' ' + t.event).join(' ');
        expect(summaries).toMatch(/confirm the appointment/i);
        // the structured status event is kept (code-free description)
        expect(summaries).toMatch(/Waiting for parts/);
    });

    test('cross-contact job (same company, different contact) → refused, no history read', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 7, contact_id: OTHER_CONTACT, notes: [] });
        const out = await runSkill('getJobHistory', CO, {}, { contactId: CONTACT, jobId: 7 });
        expect(out.ok).toBe(false);
        expect(out.speak).toMatch(/don't see that job/i);
        expect(eventService.getEntityHistory).not.toHaveBeenCalled();
    });

    test('foreign job (company-scoped getJobById → null) → refused, no history read', async () => {
        jobsService.getJobById.mockResolvedValue(null);
        const out = await runSkill('getJobHistory', CO, {}, { contactId: CONTACT, jobId: 999 });
        expect(out.ok).toBe(false);
        expect(eventService.getEntityHistory).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// getEstimateSummary (L1) — customer-safe breakdown, ownership, not-found-safe
// ════════════════════════════════════════════════════════════════════════════

describe('getEstimateSummary (L1) — ASK-SKILL-EST-01 / ASK-ISO-05', () => {
    test('EST-01: sent estimate returns customer-facing items + totals and offers the written document', async () => {
        estimatesService.getEstimate.mockResolvedValue({
            id: 'e1', contact_id: CONTACT, estimate_number: 'EST-1001', status: 'sent',
            subtotal: '450.00', discount_amount: '0', tax_amount: '0', total: '450.00',
            items: [
                { name: 'Compressor', description: 'internal diagnosis', quantity: '1', amount: '300.00', metadata: { sku: 'SECRET' } },
                { name: 'Installation labor', quantity: '1', amount: '150.00' },
            ],
        });
        const out = await runSkill('getEstimateSummary', CO, {}, { contactId: CONTACT, estimateId: 'e1' });
        expect(out).toMatchObject({ ok: true, estimateNumber: 'EST-1001', status: 'sent', total: 450, itemCount: 2 });
        expect(out.lineItems).toEqual([
            { name: 'Compressor', quantity: 1, amount: 300 },
            { name: 'Installation labor', quantity: 1, amount: 150 },
        ]);
        expect(out.speak).toMatch(/compressor|installation labor/i);
        expect(JSON.stringify(out)).not.toMatch(/internal diagnosis|SECRET/);
        expect(out.speak).toMatch(/written document/i);
    });

    test('ASK-ISO-05: foreign estimate id (company-scoped getEstimate throws NOT_FOUND) → not-found-safe, no amount', async () => {
        estimatesService.getEstimate.mockRejectedValue(Object.assign(new Error('not found'), { code: 'NOT_FOUND' }));
        const out = await runSkill('getEstimateSummary', CO, {}, { contactId: CONTACT, estimateId: 'foreign' });
        expect(out.ok).toBe(false);
        expect(out.speak).toMatch(/don't see an estimate/i);
        expect(JSON.stringify(out)).not.toMatch(/\$|total|\d{2,}/);
    });

    test('cross-contact estimate (belongs to another contact) → not-found-safe, no cross-read amount', async () => {
        estimatesService.getEstimate.mockResolvedValue({ id: 'e2', contact_id: OTHER_CONTACT, estimate_number: 'EST-2', status: 'sent', total: '999.00', items: [] });
        const out = await runSkill('getEstimateSummary', CO, {}, { contactId: CONTACT, estimateId: 'e2' });
        expect(out.ok).toBe(false);
        expect(JSON.stringify(out)).not.toMatch(/999/);
    });

    test('E12: no estimate on file (empty list, no id) → not-found-safe shape', async () => {
        estimatesService.listEstimates.mockResolvedValue({ rows: [] });
        const out = await runSkill('getEstimateSummary', CO, {}, { contactId: CONTACT });
        expect(out.ok).toBe(false);
        expect(out.speak).toMatch(/don't see an estimate/i);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// getInvoiceSummary (L1) — balance + status, no card, ownership, not-found-safe
// ════════════════════════════════════════════════════════════════════════════

describe('getInvoiceSummary (L1) — ASK-SKILL-INV-01 / ASK-ISO-06 (no-card invariant)', () => {
    test('INV-01: balance + status; payment handoff to link/human; NEVER a card by voice', async () => {
        invoicesService.getInvoice.mockResolvedValue({
            id: 'i1', contact_id: CONTACT, invoice_number: 'INV-500', status: 'sent',
            total: '300.00', amount_paid: '100.00', balance_due: '200.00', items: [],
        });
        const out = await runSkill('getInvoiceSummary', CO, {}, { contactId: CONTACT, invoiceId: 'i1' });
        expect(out).toMatchObject({ ok: true, invoiceNumber: 'INV-500', status: 'sent', total: 300, amountPaid: 100, balanceDue: 200 });
        expect(out.speak).toMatch(/can't take a card over the phone/i);
        expect(out.speak).toMatch(/secure payment link|teammate/i);
        // no card/PAN/CVV field ever appears on the output
        expect(Object.keys(out)).not.toEqual(expect.arrayContaining(['card', 'pan', 'cvv', 'cardNumber']));
    });

    test('paid-in-full invoice → no balance-due wording, states paid', async () => {
        invoicesService.getInvoice.mockResolvedValue({ id: 'i2', contact_id: CONTACT, invoice_number: 'INV-9', status: 'paid', total: '100.00', amount_paid: '100.00', balance_due: '0.00', items: [] });
        const out = await runSkill('getInvoiceSummary', CO, {}, { contactId: CONTACT, invoiceId: 'i2' });
        expect(out.balanceDue).toBe(0);
        expect(out.speak).toMatch(/paid in full/i);
    });

    test('ASK-ISO-06: foreign invoice id (NOT_FOUND) → not-found-safe, amounts never surfaced', async () => {
        invoicesService.getInvoice.mockRejectedValue(Object.assign(new Error('nf'), { code: 'NOT_FOUND' }));
        const out = await runSkill('getInvoiceSummary', CO, {}, { contactId: CONTACT, invoiceId: 'foreign' });
        expect(out.ok).toBe(false);
        expect(out.speak).toMatch(/don't see an invoice/i);
        expect(JSON.stringify(out)).not.toMatch(/\$|balanceDue|\d{2,}/);
    });

    test('cross-contact invoice → not-found-safe, no balance leaked', async () => {
        invoicesService.getInvoice.mockResolvedValue({ id: 'i3', contact_id: OTHER_CONTACT, invoice_number: 'INV-3', status: 'sent', total: '888.00', amount_paid: '0', balance_due: '888.00', items: [] });
        const out = await runSkill('getInvoiceSummary', CO, {}, { contactId: CONTACT, invoiceId: 'i3' });
        expect(out.ok).toBe(false);
        expect(JSON.stringify(out)).not.toMatch(/888/);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// no-card invariant across the sensitive skills (source-level)
// ════════════════════════════════════════════════════════════════════════════

describe('ASK-SEC-01: no skill declares/collects a card/payment field (source scan)', () => {
    const fs = require('fs');
    const path = require('path');
    const SKILLS_DIR = path.join(__dirname, '../backend/src/services/agentSkills/skills');

    test('no card/PAN/CVV capture path in any skill module', () => {
        for (const f of fs.readdirSync(SKILLS_DIR).filter((n) => n.endsWith('.js'))) {
            const src = fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8');
            // Guard against a code path that reads a card/PAN/CVV/track2 off input.
            expect(src).not.toMatch(/input\.(card|pan|cvv|cvc|cardNumber|track2)/i);
            expect(src).not.toMatch(/\b(collectCard|chargeCard|capturePayment|takePayment)\b/);
        }
    });

    test('invoice MCP + skill input schemas expose no card field', () => {
        const reg = require('../backend/src/services/agentSkillsMcpRegistry');
        const inv = reg.getTool('svc.get_invoice_summary');
        const props = Object.keys(inv.inputSchema.properties);
        for (const bad of ['card', 'pan', 'cvv', 'cvc', 'card_number']) expect(props).not.toContain(bad);
    });
});
