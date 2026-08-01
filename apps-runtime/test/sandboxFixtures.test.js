'use strict';

const { validateAndDryRun } = require('../src/builderDryRun');
const { sourceSha256 } = require('../src/runner');
const {
    generateSandboxFixtures,
    projectSandboxTool,
    summarizeSandboxFixtures,
} = require('../src/sandboxFixtures');
const { referenceSource } = require('./helpers');

describe('APP-SANDBOX-001 synthetic fixture graph', () => {
    test('one seed is byte-deterministic and a different seed changes the graph', () => {
        const first = generateSandboxFixtures('deterministic-seed');
        const repeated = generateSandboxFixtures('deterministic-seed');
        const different = generateSandboxFixtures('different-seed');

        expect(JSON.stringify(repeated)).toBe(JSON.stringify(first));
        expect(different).not.toEqual(first);
    });

    test('SAB APP-SANDBOX-001 fixture connectivity: every child has its synthetic parent and consistent dates', () => {
        const fixtures = generateSandboxFixtures('connectivity-seed');
        const contactIds = new Set(fixtures.contacts.map(contact => contact.id));
        const leadIds = new Set(fixtures.leads.map(lead => lead.id));
        const jobIds = new Set(fixtures.jobs.map(job => job.id));
        const invoiceIds = new Set(fixtures.invoices.map(invoice => invoice.id));

        expect(fixtures.contacts.every(contact => contact.company_id === fixtures.company.id)).toBe(true);
        expect(fixtures.leads.every(lead => (
            lead.company_id === fixtures.company.id
            && contactIds.has(lead.contact_id)
            && Date.parse(lead.created_at) >= Date.parse(
                fixtures.contacts.find(contact => contact.id === lead.contact_id).created_at
            )
            && Date.parse(lead.converted_at) >= Date.parse(lead.created_at)
        ))).toBe(true);
        expect(fixtures.jobs.every(job => (
            job.company_id === fixtures.company.id
            && contactIds.has(job.contact_id)
            && leadIds.has(job.lead_id)
            && Date.parse(job.created_at) >= Date.parse(
                fixtures.leads.find(lead => lead.id === job.lead_id).converted_at
            )
            && Date.parse(job.end_date) > Date.parse(job.start_date)
            && Date.parse(job.updated_at) >= Date.parse(job.created_at)
        ))).toBe(true);
        expect(fixtures.tasks.every(task => (
            task.company_id === fixtures.company.id
            && task.parent_type === 'job'
            && jobIds.has(task.parent_id)
            && Date.parse(task.created_at) <= Date.parse(task.due_at)
            && (task.completed_at === null || Date.parse(task.completed_at) >= Date.parse(task.created_at))
        ))).toBe(true);
        expect(fixtures.invoices.every(invoice => (
            invoice.company_id === fixtures.company.id
            && jobIds.has(invoice.job_id)
            && Date.parse(invoice.due_at) >= Date.parse(invoice.created_at)
            && Number(invoice.amount_paid) + Number(invoice.balance_due) === Number(invoice.total)
        ))).toBe(true);
        expect(fixtures.payments.every(payment => {
            const invoice = fixtures.invoices.find(candidate => candidate.id === payment.invoice_id);
            return payment.company_id === fixtures.company.id
                && invoiceIds.has(payment.invoice_id)
                && invoice?.job_id === payment.job_id
                && Date.parse(payment.paid_at) >= Date.parse(invoice.created_at)
                && Number(payment.amount) <= Number(invoice.total);
        })).toBe(true);
    });

    test('catalog projections filter generated jobs, detail, and tasks without exposing raw fixtures', () => {
        const fixtures = generateSandboxFixtures('projection-seed');
        const firstJob = fixtures.jobs[0];
        const jobs = projectSandboxTool(fixtures, 'svc.list_jobs', {
            start_date: '2026-07-31',
            end_date: '2026-07-31',
            limit: 100,
        });
        const job = projectSandboxTool(fixtures, 'svc.get_job', { job_id: firstJob.id });
        const tasks = projectSandboxTool(fixtures, 'svc.list_tasks', { status: 'open', limit: 100 });

        expect(jobs.results).toHaveLength(fixtures.jobs.length);
        expect(job).toEqual(firstJob);
        expect(tasks.tasks.every(task => task.status === 'open')).toBe(true);
        expect(jobs.results[0]).toHaveProperty('amount_paid');
        expect(job).not.toHaveProperty('amount_paid');
        expect(summarizeSandboxFixtures(fixtures)).toEqual({
            companies: 1,
            contacts: 6,
            leads: 6,
            jobs: 6,
            tasks: 8,
            invoices: 5,
            payments: 4,
        });
    });

    test('morning-digest returns a meaningful application result from generated fixtures', async () => {
        const source = referenceSource();
        const execution = await validateAndDryRun({
            source,
            expectedSourceSha256: sourceSha256(source),
            input: { today: '2026-07-31' },
            seed: 'morning-digest-seed',
        });

        expect(execution.result).toContain('Morning digest for 2026-07-31');
        expect(execution.result).toContain('Jobs today: 6');
        expect(execution.result).toContain('Open tasks: 6');
        expect(execution.result).toContain('Synthetic');
        expect(execution.usage).toMatchObject({ gateway_calls: 2, error_code: null });
        expect(execution.fixturesSummary).toMatchObject({ jobs: 6, tasks: 8, payments: 4 });
    });
});
