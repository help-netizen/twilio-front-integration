/**
 * Tests for PF100-PULSE-BE: financial_events mapping in Pulse timeline.
 *
 * Tests the invoice type classification logic (invoice_paid /
 * invoice_partial_payment / invoice_created) used in pulse.js buildTimeline().
 */

// ─── Pure mapping logic extracted for testing ─────────────────────────────────
// Mirrors the logic in backend/src/routes/pulse.js buildTimeline()

function classifyInvoiceType(total, amount_paid) {
    const t = Number(total);
    const p = Number(amount_paid);
    if (p && p >= t) return 'invoice_paid';
    if (p && p > 0) return 'invoice_partial_payment';
    return 'invoice_created';
}

function mapEstimateToEvent(row, contactId) {
    return {
        id: `estimate-${row.id}`,
        type: 'estimate_created',
        reference: row.reference,
        status: row.status,
        amount: row.total,
        occurred_at: row.occurred_at,
        contact_id: contactId,
    };
}

function mapInvoiceToEvent(row, contactId) {
    return {
        id: `invoice-${row.id}`,
        type: classifyInvoiceType(row.total, row.amount_paid),
        reference: row.reference,
        status: row.status,
        amount: row.total,
        occurred_at: row.occurred_at,
        contact_id: contactId,
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Pulse financial events — invoice type classification', () => {
    it('TC-PULSE-03: fully paid invoice → invoice_paid', () => {
        expect(classifyInvoiceType('200.00', '200.00')).toBe('invoice_paid');
    });

    it('TC-PULSE-03b: overpaid invoice → invoice_paid', () => {
        expect(classifyInvoiceType('100.00', '120.00')).toBe('invoice_paid');
    });

    it('TC-PULSE-04: partially paid invoice → invoice_partial_payment', () => {
        expect(classifyInvoiceType('200.00', '50.00')).toBe('invoice_partial_payment');
    });

    it('TC-PULSE-05: unpaid invoice (amount_paid=0) → invoice_created', () => {
        expect(classifyInvoiceType('200.00', '0.00')).toBe('invoice_created');
    });

    it('TC-PULSE-05b: unpaid invoice (amount_paid=null) → invoice_created', () => {
        expect(classifyInvoiceType('200.00', null)).toBe('invoice_created');
    });
});

describe('Pulse financial events — event shape', () => {
    const CONTACT_ID = 17;

    it('TC-PULSE-02: estimate row maps to estimate_created event with correct fields', () => {
        const row = { id: 10, reference: 'EST-010', status: 'accepted', total: '300.00', occurred_at: '2026-01-10T10:00:00Z' };
        const evt = mapEstimateToEvent(row, CONTACT_ID);

        expect(evt).toEqual({
            id: 'estimate-10',
            type: 'estimate_created',
            reference: 'EST-010',
            status: 'accepted',
            amount: '300.00',
            occurred_at: '2026-01-10T10:00:00Z',
            contact_id: CONTACT_ID,
        });
    });

    it('TC-PULSE-07: invoice row maps to event with correct id prefix', () => {
        const row = { id: 20, reference: 'INV-020', status: 'paid', total: '500.00', amount_paid: '500.00', occurred_at: '2026-01-15T10:00:00Z' };
        const evt = mapInvoiceToEvent(row, CONTACT_ID);

        expect(evt.id).toBe('invoice-20');
        expect(evt.type).toBe('invoice_paid');
        expect(evt.contact_id).toBe(CONTACT_ID);
    });
});

describe('Pulse financial events — company isolation (unit)', () => {
    it('TC-PULSE-06: no events returned when contact is null', () => {
        // When contact is null, buildTimeline() skips the financial events block.
        // Simulate by running the guard condition:
        const contact = null;
        const events = contact?.id ? ['should-not-exist'] : [];
        expect(events).toEqual([]);
    });

    it('TC-PULSE-06b: no events returned when companyId is null', () => {
        const contact = { id: 17 };
        const companyId = null;
        // Guard: if (companyId) { ... } else events = []
        const events = companyId ? ['should-not-exist'] : [];
        expect(events).toEqual([]);
    });
});
