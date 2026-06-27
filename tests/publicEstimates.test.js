'use strict';

/**
 * SEND-DOC-001 (TASK-SD-15) — Public estimate routes + service view.
 *
 * Covers TC-SD-004..008, 051..052: the customer-safe view (no PII/internal ids),
 * the inline PDF stream, malformed-token / unknown-token → 404 (no DB hit on the
 * malformed guard), void-status passthrough, and cross-tenant token safety.
 *
 * Strategy mirrors slotEngineSettings.test.js: the estimatesService is mocked at
 * the seam the public router consumes (getPublicEstimate / generatePdfByPublicToken),
 * and getEstimateByPublicToken is mocked at the query layer for the service-view
 * unit tests. Routes are exercised through supertest with NO auth (the token is the
 * credential — the public router is mounted before authenticate in production).
 *
 * Run:
 *   npx jest --runTestsByPath tests/publicEstimates.test.js \
 *     --testPathIgnorePatterns "/node_modules/"
 */

const express = require('express');
const request = require('supertest');

// ─── Mock the query + collaborator seams the service/router touch ────────────
const mockGetEstimateByPublicToken = jest.fn();
const mockGetEstimateItems = jest.fn();

jest.mock('../backend/src/db/estimatesQueries', () => ({
    getEstimateByPublicToken: (...a) => mockGetEstimateByPublicToken(...a),
    getEstimateItems: (...a) => mockGetEstimateItems(...a),
    getEstimateById: jest.fn(),
    setPublicToken: jest.fn(),
}));

// estimatePdfService is pulled in transitively; never actually render in unit tests.
jest.mock('../backend/src/services/estimatePdfService', () => ({
    renderEstimatePdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 mock')),
}));

const estimatesService = require('../backend/src/services/estimatesService');
const publicRouter = require('../backend/src/routes/public-estimates');

// Public router is mounted at /api/public in production, with NO auth ahead of it.
function publicApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/public', publicRouter);
    return app;
}

const GOOD_TOKEN = 'abc123XYZ_-'; // 11 chars, base64url — matches TOKEN_RE

beforeEach(() => {
    jest.clearAllMocks();
});

// ─── A. getPublicEstimate — customer-safe view (TC-SD-004) ───────────────────
describe('getPublicEstimate — customer-safe projection', () => {
    const FULL_ROW = {
        id: 99,
        company_id: 'company-A',
        contact_id: 7,
        lead_id: 3,
        job_id: 4,
        estimate_number: 'ESTIMATE 519-1',
        status: 'sent',
        currency: 'USD',
        company_name: 'Boston Masters',
        contact_name: 'Jane Doe',
        contact_email: 'jane@example.com',
        contact_phone: '+15551234567',
        summary: 'Roof work',
        notes: 'thanks',
        subtotal: '100',
        discount_amount: '10',
        tax_amount: '5',
        total: '95',
        cost: '40',
        margin: '55',
        public_token: GOOD_TOKEN,
    };

    it('TC-SD-004: includes doc-safe fields and EXCLUDES PII + internal ids', async () => {
        mockGetEstimateByPublicToken.mockResolvedValue(FULL_ROW);
        mockGetEstimateItems.mockResolvedValue([
            { name: 'Labor', description: 'd', quantity: '2', unit_price: '50', amount: '100' },
        ]);

        const view = await estimatesService.getPublicEstimate(GOOD_TOKEN);

        // exposed
        expect(view.estimate_number).toBe('ESTIMATE 519-1');
        expect(view.status).toBe('sent');
        expect(view.currency).toBe('USD');
        expect(view.company_name).toBe('Boston Masters');
        expect(view.contact_name).toBe('Jane Doe');
        expect(view.subtotal).toBe(100);
        expect(view.discount_amount).toBe(10);
        expect(view.tax_amount).toBe(5);
        expect(view.total).toBe(95);
        expect(view.items).toEqual([
            { title: 'Labor', description: 'd', qty: 2, unit_price: 50, line_total: 100 },
        ]);

        // hidden — PII, internal ids, cost/margin, event history
        const keys = Object.keys(view);
        for (const leak of [
            'contact_email', 'contact_phone', 'company_id', 'contact_id',
            'lead_id', 'job_id', 'cost', 'margin', 'public_token', 'events',
        ]) {
            expect(keys).not.toContain(leak);
        }
        // belt-and-suspenders: no value anywhere equals the PII strings
        const blob = JSON.stringify(view);
        expect(blob).not.toContain('jane@example.com');
        expect(blob).not.toContain('+15551234567');
        expect(blob).not.toContain('company-A');
    });

    it('returns null for an unknown token (no items lookup)', async () => {
        mockGetEstimateByPublicToken.mockResolvedValue(null);
        const view = await estimatesService.getPublicEstimate(GOOD_TOKEN);
        expect(view).toBeNull();
        expect(mockGetEstimateItems).not.toHaveBeenCalled();
    });
});

// ─── B. GET /api/public/estimates/:token — view route (TC-SD-005/008/051) ─────
describe('GET /api/public/estimates/:token', () => {
    it('TC-SD-005: 200 safe view JSON, no auth required (not 401)', async () => {
        mockGetEstimateByPublicToken.mockResolvedValue({
            id: 1, estimate_number: 'E-1', status: 'sent', currency: 'USD',
            company_name: 'Co', contact_name: 'C', contact_email: 'x@y.com',
            subtotal: '10', discount_amount: '0', tax_amount: '0', total: '10',
        });
        mockGetEstimateItems.mockResolvedValue([]);

        const res = await request(publicApp()).get(`/api/public/estimates/${GOOD_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.estimate_number).toBe('E-1');
        expect(JSON.stringify(res.body.data)).not.toContain('x@y.com');
    });

    it('TC-SD-008: unknown well-formed token → 404, no tenant leak', async () => {
        mockGetEstimateByPublicToken.mockResolvedValue(null);
        const res = await request(publicApp()).get(`/api/public/estimates/${GOOD_TOKEN}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
        expect(res.body.data).toBeUndefined();
    });

    it('TC-SD-051: void doc → view returns status:void (still no PII)', async () => {
        mockGetEstimateByPublicToken.mockResolvedValue({
            id: 2, estimate_number: 'E-2', status: 'void', currency: 'USD',
            company_name: 'Co', contact_name: 'C', contact_phone: '+15550000000',
            subtotal: '10', discount_amount: '0', tax_amount: '0', total: '10',
        });
        mockGetEstimateItems.mockResolvedValue([]);
        const res = await request(publicApp()).get(`/api/public/estimates/${GOOD_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('void');
        expect(JSON.stringify(res.body.data)).not.toContain('+15550000000');
    });
});

// ─── C. Malformed-token guard short-circuits BEFORE any DB hit (TC-SD-007) ────
describe('Malformed token guard (TOKEN_RE)', () => {
    it('TC-SD-007: too-short / illegal-char / too-long → 404, getEstimateByPublicToken NOT called', async () => {
        const app = publicApp();
        for (const bad of ['!!short', 'a'.repeat(70), 'ab', 'has space']) {
            const res = await request(app).get(`/api/public/estimates/${encodeURIComponent(bad)}`);
            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe('NOT_FOUND');
        }
        expect(mockGetEstimateByPublicToken).not.toHaveBeenCalled();
    });

    it('TC-SD-007 (pdf): malformed token on /pdf → 404 before DB', async () => {
        const res = await request(publicApp()).get('/api/public/estimates/!!bad/pdf');
        expect(res.status).toBe(404);
        expect(mockGetEstimateByPublicToken).not.toHaveBeenCalled();
    });
});

// ─── D. GET /api/public/estimates/:token/pdf — inline stream (TC-SD-006/008) ──
describe('GET /api/public/estimates/:token/pdf', () => {
    it('TC-SD-006: 200 inline PDF with private cache headers + buffer body', async () => {
        const buffer = Buffer.from('%PDF-1.4 hello');
        const spy = jest.spyOn(estimatesService, 'generatePdfByPublicToken')
            .mockResolvedValue({ estimate: { id: 5, estimate_number: 'E 5' }, buffer });

        const res = await request(publicApp()).get(`/api/public/estimates/${GOOD_TOKEN}/pdf`);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/application\/pdf/);
        expect(res.headers['content-disposition']).toBe('inline; filename="E_5.pdf"');
        expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
        expect(Buffer.from(res.body)).toEqual(buffer);
        spy.mockRestore();
    });

    it('TC-SD-008 (pdf): unknown token → 404 via NOT_FOUND from the service', async () => {
        const spy = jest.spyOn(estimatesService, 'generatePdfByPublicToken')
            .mockRejectedValue(new estimatesService.EstimatesServiceError('NOT_FOUND', 'Estimate not found', 404));
        const res = await request(publicApp()).get(`/api/public/estimates/${GOOD_TOKEN}/pdf`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
        spy.mockRestore();
    });
});

// ─── E. Cross-tenant token safety (TC-SD-052) ────────────────────────────────
describe('Cross-tenant token resolution', () => {
    it('TC-SD-052: a token resolves only its OWN row; view exposes no company_id', async () => {
        // The token is the only key — unscoped lookup returns exactly the row whose
        // token matches. Company A token → company A row; B token → B row.
        mockGetEstimateByPublicToken.mockImplementation(async (tok) => {
            if (tok === 'tokenAAAAAA_') return { id: 1, company_id: 'A', estimate_number: 'E-A', status: 'sent', currency: 'USD', subtotal: '1', discount_amount: '0', tax_amount: '0', total: '1' };
            if (tok === 'tokenBBBBBB_') return { id: 2, company_id: 'B', estimate_number: 'E-B', status: 'sent', currency: 'USD', subtotal: '1', discount_amount: '0', tax_amount: '0', total: '1' };
            return null;
        });
        mockGetEstimateItems.mockResolvedValue([]);

        const a = await estimatesService.getPublicEstimate('tokenAAAAAA_');
        const b = await estimatesService.getPublicEstimate('tokenBBBBBB_');
        expect(a.estimate_number).toBe('E-A');
        expect(b.estimate_number).toBe('E-B');
        expect(a.company_id).toBeUndefined();
        expect(b.company_id).toBeUndefined();
    });
});
