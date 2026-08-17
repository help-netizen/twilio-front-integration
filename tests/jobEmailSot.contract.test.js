'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const EFFECTIVE_EMAIL = "COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, ''))";
const EFFECTIVE_PHONE = "COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, ''))";
const OWNED_CONTACT_JOIN = /c\.id = j\.contact_id\s+AND c\.company_id = j\.company_id/;

describe('JOB-EMAIL-SOT-001 contact-first job identity contract', () => {
    test.each([
        'backend/src/services/jobsService.js',
        'backend/src/db/scheduleQueries.js',
        'backend/src/db/syncQueries.js',
    ])('%s projects effective email/phone through a same-company contact join', relativePath => {
        const source = read(relativePath);
        expect(source).toContain(EFFECTIVE_EMAIL);
        expect(source).toContain(EFFECTIVE_PHONE);
        expect(source).toMatch(OWNED_CONTACT_JOIN);
    });

    test('agentHandlers does not maintain a second Job customer-identity projection', () => {
        const source = read('backend/src/services/agentHandlers.js');
        expect(source).not.toMatch(/j\.customer_(?:email|phone)/);
        expect(source).not.toMatch(/FROM jobs j[\s\S]{0,500}JOIN contacts c/);
    });

    test.each([
        ['backend/src/db/invoicesQueries.js', 'i'],
        ['backend/src/db/estimatesQueries.js', 'e'],
    ])('%s exposes the job contact to document send prefills without a cross-tenant join', (relativePath, documentAlias) => {
        const source = read(relativePath);
        expect(source).toContain(`${EFFECTIVE_EMAIL} AS contact_email`);
        expect(source).toContain(`${EFFECTIVE_PHONE} AS contact_phone`);
        expect(source).toContain(`c.company_id = ${documentAlias}.company_id`);
        expect(source).toContain(`COALESCE(j.contact_id, ${documentAlias}.contact_id)`);
    });

    test('Rate Me and job payment actions consume the shared effective job fields', () => {
        const jobsRoute = read('backend/src/routes/jobs.js');
        const stripePayments = read('backend/src/services/stripePaymentsService.js');
        const rateLinkStart = jobsRoute.indexOf("router.post('/:id/rate-link'");
        const rateStatusStart = jobsRoute.indexOf("router.get('/:id/rate-status'", rateLinkStart);
        const rateLink = jobsRoute.slice(rateLinkStart, rateStatusStart);

        expect(rateLink).toContain('jobsService.getJobById(jobId, companyId');
        expect(rateLink).toContain("const customerEmail = (job.customer_email || '').trim()");
        expect(rateLink).toContain("toE164((job.customer_phone || '').trim())");
        expect(stripePayments).toContain('const email = job.customer_email || null');
        expect(stripePayments).toContain('const phone = job.customer_phone || null');
    });

    test('receipt context gives the job contact precedence and keeps the tenant boundary', () => {
        const source = read('backend/src/db/paymentsQueries.js');
        expect(source).toContain('COALESCE(j.contact_id, t.contact_id, stripe_session.contact_id, i.contact_id)');
        expect(source).toContain(EFFECTIVE_EMAIL);
        expect(source).toContain('c.company_id = t.company_id');
    });
});
