'use strict';

const CO = '00000000-0000-0000-0000-000000000001';
const CO_B = '00000000-0000-0000-0000-000000000002';
const CONTACT_A = 501;
const CONTACT_B = 777;
const PHONE = '6175551212';

jest.mock('../backend/src/services/agentSkills/verificationGate', () => {
    const actual = jest.requireActual('../backend/src/services/agentSkills/verificationGate');
    return { ...actual, deriveLevel: jest.fn() };
});
jest.mock('../backend/src/services/agentSkills/identityResolver', () => {
    const actual = jest.requireActual('../backend/src/services/agentSkills/identityResolver');
    return { ...actual, resolve: jest.fn() };
});
jest.mock('../backend/src/services/jobsService', () => ({ getJobById: jest.fn() }));
jest.mock('../backend/src/services/leadsService', () => ({
    getLeadByUUID: jest.fn(),
    getLeadById: jest.fn(),
}));
jest.mock('../backend/src/services/estimatesService', () => ({
    listEstimates: jest.fn(async () => ({ rows: [] })),
    getEstimate: jest.fn(),
}));
jest.mock('../backend/src/services/invoicesService', () => ({
    listInvoices: jest.fn(async () => ({ rows: [] })),
    getInvoice: jest.fn(),
}));
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const gate = require('../backend/src/services/agentSkills/verificationGate');
const identityResolver = require('../backend/src/services/agentSkills/identityResolver');
const jobsService = require('../backend/src/services/jobsService');
const leadsService = require('../backend/src/services/leadsService');
const estimatesService = require('../backend/src/services/estimatesService');
const invoicesService = require('../backend/src/services/invoicesService');
const db = require('../backend/src/db/connection');
const { runSkill } = require('../backend/src/services/agentSkills');
const financeDefinitions = require('../backend/src/services/agentSkills/financeToolDefinitions');
const mcpRegistry = require('../backend/src/services/agentSkillsMcpRegistry');
const vapiCallContextService = require('../backend/src/services/vapiCallContextService');
const { buildSkillInput } = require('../backend/src/routes/vapi-tools');

const SINGLE = {
    level: 'L1',
    contactId: CONTACT_A,
    customerName: 'Alex A',
    matchedPhone: PHONE,
    phoneCandidateCount: 1,
};
const SHARED = { ...SINGLE, contactId: CONTACT_B, customerName: 'Blair B', phoneCandidateCount: 2 };

function estimate(overrides = {}) {
    return {
        id: 'est-a',
        company_id: CO,
        contact_id: CONTACT_A,
        job_id: 101,
        estimate_number: 'EST-A',
        status: 'approved',
        subtotal: '600.00',
        discount_amount: '30.00',
        tax_amount: '37.50',
        total: '607.50',
        items: [{ name: 'Control board', quantity: '1', amount: '420.00' }],
        ...overrides,
    };
}

function invoice(overrides = {}) {
    return {
        id: 'inv-a',
        company_id: CO,
        contact_id: CONTACT_A,
        job_id: 101,
        invoice_number: 'INV-A',
        status: 'sent',
        subtotal: '600.00',
        discount_amount: '30.00',
        tax_amount: '37.50',
        total: '607.50',
        amount_paid: '100.00',
        balance_due: '507.50',
        items: [{ name: 'Control board', quantity: '1', amount: '420.00' }],
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    gate.deriveLevel.mockResolvedValue(SINGLE);
    identityResolver.resolve.mockResolvedValue({
        matchType: 'existing',
        contactId: CONTACT_A,
        matchedPhone: PHONE,
    });
    jobsService.getJobById.mockResolvedValue({ id: 101, contact_id: CONTACT_A, lead_id: 201 });
    leadsService.getLeadByUUID.mockResolvedValue({
        UUID: 'LEAD-A', ClientId: 201, ContactId: CONTACT_A, Phone: PHONE,
    });
    leadsService.getLeadById.mockResolvedValue({
        UUID: 'LEAD-A', ClientId: 201, ContactId: CONTACT_A, Phone: PHONE,
    });
    estimatesService.listEstimates.mockResolvedValue({ rows: [] });
    invoicesService.listInvoices.mockResolvedValue({ rows: [] });
    db.query.mockResolvedValue({ rows: [] });
});

describe('finance-only shared-phone subject guard', () => {
    test('SAB-FIN-CROSS-CUSTOMER: shared phone without exact repair refuses and leaks neither customer amount', async () => {
        gate.deriveLevel.mockResolvedValue(SHARED);
        estimatesService.getEstimate.mockResolvedValue(estimate({ contact_id: CONTACT_B, total: '999.99' }));

        const out = await runSkill('getEstimateSummary', CO, {}, { estimateId: 'est-b' });

        expect(out).toMatchObject({ ok: false, subjectAmbiguous: true });
        expect(JSON.stringify(out)).not.toMatch(/607\.50|999\.99|EST-/);
        expect(estimatesService.getEstimate).not.toHaveBeenCalled();
    });

    test('shared phone + exact job may select that job contact, but never a different job estimate', async () => {
        gate.deriveLevel.mockResolvedValue(SHARED);
        identityResolver.resolve.mockResolvedValue({ matchType: 'existing', contactId: CONTACT_A, matchedPhone: PHONE });
        estimatesService.getEstimate.mockResolvedValue(estimate({ id: 'est-b', job_id: 999, total: '999.99' }));

        const out = await runSkill('getEstimateSummary', CO, {}, { jobId: 101, estimateId: 'est-b' });

        expect(out.ok).toBe(false);
        expect(JSON.stringify(out)).not.toMatch(/999\.99/);
        expect(identityResolver.resolve).toHaveBeenCalledWith(CO, { phone: PHONE, contactId: CONTACT_A });
    });

    test('shared phone + exact associated job discloses the selected repair only', async () => {
        gate.deriveLevel.mockResolvedValue(SHARED);
        identityResolver.resolve.mockResolvedValue({ matchType: 'existing', contactId: CONTACT_A, matchedPhone: PHONE });
        estimatesService.getEstimate.mockResolvedValue(estimate());

        const out = await runSkill('getEstimateSummary', CO, {}, { jobId: 101, estimateId: 'est-a' });

        expect(out).toMatchObject({ ok: true, total: 607.5, estimateNumber: 'EST-A' });
        expect(out.speak).toMatch(/control board/i);
    });
});

describe('estimate disclosure policy', () => {
    test('SAB-FIN-DRAFT-SILENCE: an explicitly requested draft never exposes amount, item, or number', async () => {
        estimatesService.getEstimate.mockResolvedValue(estimate({
            status: 'draft',
            estimate_number: 'DRAFT-SECRET',
            total: '888.88',
            items: [{ name: 'Secret repair', quantity: 1, amount: '888.88' }],
        }));

        const out = await runSkill('getEstimateSummary', CO, {}, { estimateId: 'draft-id' });

        expect(out).toMatchObject({ ok: false, draftPending: true });
        expect(JSON.stringify(out)).not.toMatch(/888|Secret repair|DRAFT-SECRET|total|lineItems|itemCount/i);
    });

    test('approved beats sent; equally ranked approved estimates require selection', async () => {
        const sent = estimate({ id: 'sent', status: 'sent', estimate_number: 'EST-SENT' });
        const approved = estimate({ id: 'approved', status: 'approved', estimate_number: 'EST-APP' });
        estimatesService.listEstimates.mockResolvedValue({ rows: [sent, approved] });
        estimatesService.getEstimate.mockResolvedValue(approved);

        const preferred = await runSkill('getEstimateSummary', CO, {}, {});
        expect(preferred).toMatchObject({ ok: true, estimateNumber: 'EST-APP' });
        expect(estimatesService.getEstimate).toHaveBeenCalledWith(CO, 'approved');

        estimatesService.listEstimates.mockResolvedValue({
            rows: [approved, estimate({ id: 'approved-2', estimate_number: 'EST-APP-2' })],
        });
        const ambiguous = await runSkill('getEstimateSummary', CO, {}, {});
        expect(ambiguous).toMatchObject({ ok: false, selectionRequired: true });
        expect(ambiguous.candidates).toHaveLength(2);
    });

    test('customer-safe breakdown is capped at five and excludes descriptions, metadata, and codes', async () => {
        const items = Array.from({ length: 7 }, (_, index) => ({
            name: index === 0 ? 'Control board WPW10310240' : `Repair item ${index + 1}`,
            description: `TECH SECRET ${index + 1}`,
            quantity: '1',
            amount: String(10 + index),
            metadata: { sku: `SKU-${index}` },
        }));
        estimatesService.getEstimate.mockResolvedValue(estimate({ items }));

        const out = await runSkill('getEstimateSummary', CO, {}, { estimateId: 'est-a' });

        expect(out.lineItems).toHaveLength(5);
        expect(out).toMatchObject({ itemCount: 7, remainingItemCount: 2 });
        expect(JSON.stringify(out)).not.toMatch(/TECH SECRET|SKU-|WPW10310240/);
        expect(out.lineItems[0].name).toBe('Control board');
        expect(out.speak).not.toMatch(/Repair item 6|Repair item 7/);
    });
});

describe('invoice ranking and lead context', () => {
    test('OWNER-L1-NO-CHALLENGE: failed phone match refuses both finance skills without asking for name, ZIP, or code', async () => {
        gate.deriveLevel.mockResolvedValue({
            level: 'L0', contactId: null, customerName: null, matchedPhone: null, phoneCandidateCount: 0,
        });

        for (const skillName of ['getEstimateSummary', 'getInvoiceSummary']) {
            const out = await runSkill(skillName, CO, {}, { phone: '+15550000000' });
            expect(out).toMatchObject({ ok: false, phoneMatchRequired: true });
            expect(out.needsVerification).toBeUndefined();
            expect(out.speak).not.toMatch(/name|zip|code|verify/i);
        }
        expect(estimatesService.listEstimates).not.toHaveBeenCalled();
        expect(estimatesService.getEstimate).not.toHaveBeenCalled();
        expect(invoicesService.listInvoices).not.toHaveBeenCalled();
        expect(invoicesService.getInvoice).not.toHaveBeenCalled();
    });

    test('invoice with a balance is preferred and hydrated for its safe breakdown', async () => {
        const paid = invoice({ id: 'paid', status: 'paid', balance_due: '0' });
        const due = invoice({ id: 'due', invoice_number: 'INV-DUE' });
        invoicesService.listInvoices.mockResolvedValue({ rows: [paid, due] });
        invoicesService.getInvoice.mockResolvedValue(due);

        const out = await runSkill('getInvoiceSummary', CO, {}, {});

        expect(out).toMatchObject({ ok: true, invoiceNumber: 'INV-DUE', balanceDue: 507.5 });
        expect(invoicesService.getInvoice).toHaveBeenCalledWith(CO, 'due');
    });

    test('void/refunded invoices never outrank an active balance or return a stale amount due', async () => {
        const voided = invoice({ id: 'voided', status: 'voided', balance_due: '999.99' });
        const due = invoice({ id: 'due', invoice_number: 'INV-DUE' });
        invoicesService.listInvoices.mockResolvedValue({ rows: [voided, due] });
        invoicesService.getInvoice.mockResolvedValue(due);

        const preferred = await runSkill('getInvoiceSummary', CO, {}, {});
        expect(preferred).toMatchObject({ ok: true, invoiceNumber: 'INV-DUE', balanceDue: 507.5 });

        invoicesService.getInvoice.mockResolvedValue(voided);
        const explicitVoid = await runSkill('getInvoiceSummary', CO, {}, { invoiceId: 'voided' });
        expect(explicitVoid).toMatchObject({ ok: true, status: 'voided', balanceDue: 0 });
        expect(explicitVoid.speak).toMatch(/void.*no balance due/i);
        expect(explicitVoid.speak).not.toMatch(/999\.99/);
    });

    test('contactless exact lead + matching caller phone derives finance-only L1', async () => {
        gate.deriveLevel.mockResolvedValue({
            level: 'L0', contactId: null, customerName: null, matchedPhone: PHONE, phoneCandidateCount: 0,
        });
        leadsService.getLeadByUUID.mockResolvedValue({
            UUID: 'LEAD-NO-CONTACT', ClientId: 333, ContactId: null, Phone: PHONE,
            FirstName: 'Casey', LastName: 'Caller',
        });
        estimatesService.listEstimates.mockResolvedValue({
            rows: [estimate({ id: 'lead-est', contact_id: null, job_id: null, lead_id: 333 })],
        });
        estimatesService.getEstimate.mockResolvedValue(
            estimate({ id: 'lead-est', contact_id: null, job_id: null, lead_id: 333 }),
        );

        const out = await runSkill('getEstimateSummary', CO, {}, {
            phone: PHONE,
            leadUuid: 'LEAD-NO-CONTACT',
        });

        expect(out).toMatchObject({ ok: true, estimateNumber: 'EST-A' });
        expect(estimatesService.listEstimates).toHaveBeenCalledWith(CO, { leadId: 333 });
    });
});

describe('shared schemas and trusted outbound context', () => {
    test('SAB-FIN-L1-POLICY + SAB-FIN-MCP-PARITY: finance definitions project L1 schemas into MCP', () => {
        for (const definition of financeDefinitions.FINANCE_TOOL_DEFINITIONS) {
            expect(definition.requiredLevel).toBe('L1');
            const mcp = mcpRegistry.getTool(definition.mcpName);
            expect(mcp).toMatchObject({ skill: definition.skillName, requiredLevel: 'L1' });
            expect(mcp.inputSchema).toEqual(financeDefinitions.buildMcpInputSchema(definition));
            expect(mcp.inputSchema.required).toEqual([]);
        }
    });

    test('SAB-FIN-OUTBOUND-SPOOF: stored attempt values override model and echoed variable values', async () => {
        db.query.mockResolvedValue({ rows: [{
            company_id: CO,
            job_id: 101,
            lead_uuid: null,
            contact_id: CONTACT_A,
            phone: '+16175551212',
            scenario: 'parts_visit',
        }] });
        const call = {
            id: 'vapi-call-a',
            customer: { number: '+16175551212' },
            assistantOverrides: { variableValues: { companyId: CO_B, jobId: 999, contactId: CONTACT_B, scenario: 'parts_visit' } },
        };

        const context = await vapiCallContextService.resolve(call);
        const input = buildSkillInput(
            'getInvoiceSummary',
            { companyId: CO_B, jobId: 888, contactId: CONTACT_B },
            call,
            context.values,
        );

        expect(context).toMatchObject({ matched: true, companyId: CO });
        expect(input).toMatchObject({ companyId: CO, jobId: 101, contactId: CONTACT_A, phone: '+16175551212' });
        expect(db.query.mock.calls[0][0]).toMatch(/WHERE vapi_call_id = \$1/);
    });

    test('same external VAPI call id across companies fails closed', async () => {
        db.query.mockResolvedValue({ rows: [
            { company_id: CO, job_id: 101 },
            { company_id: CO_B, job_id: 202 },
        ] });
        const context = await vapiCallContextService.resolve({
            id: 'shared-call-id',
            assistantOverrides: { variableValues: { scenario: 'parts_visit', jobId: 101 } },
        });
        expect(context).toEqual({ matched: false, ambiguous: true });
    });
});
