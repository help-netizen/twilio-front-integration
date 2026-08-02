'use strict';

const { validateAndDryRun } = require('../src/builderDryRun');
const { sourceSha256 } = require('../src/runner');
const {
    generateSandboxFixtures,
    projectSandboxTool,
    summarizeSandboxFixtures,
} = require('../src/sandboxFixtures');
const dataset = require('../src/sandboxDataset');
const { referenceSource } = require('./helpers');

function localDate(value, timezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(value));
    const part = type => parts.find(candidate => candidate.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
}

function localHour(value, timezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date(value));
    return Number(parts.find(candidate => candidate.type === 'hour')?.value);
}

describe('APP-SANDBOX-001 synthetic fixture graph', () => {
    test('one seed is byte-deterministic and a different seed changes the graph', () => {
        const first = generateSandboxFixtures('deterministic-seed');
        const repeated = generateSandboxFixtures('deterministic-seed');
        const different = generateSandboxFixtures('different-seed');

        expect(JSON.stringify(repeated)).toBe(JSON.stringify(first));
        expect(different).not.toEqual(first);
    });

    test('SAB APP-SANDBOX-001 fixture connectivity: every child has its synthetic parent and consistent dates', () => {
        const fixtures = generateSandboxFixtures('connectivity-seed', '2026-07-31');
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
            && (lead.status === 'Converted'
                ? Date.parse(lead.converted_at) >= Date.parse(lead.created_at)
                : lead.converted_at === null)
        ))).toBe(true);
        // A sandbox where every lead converts teaches the wrong funnel shape.
        expect(fixtures.leads.some(lead => lead.status !== 'Converted')).toBe(true);
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
            && (task.parent_type === 'job' || task.parent_type === 'lead')
            && (task.parent_type === 'job' ? jobIds : leadIds).has(task.parent_id)
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
        const fixtures = generateSandboxFixtures('projection-seed', '2026-07-31');
        const firstJob = fixtures.jobs[0];
        const jobs = projectSandboxTool(fixtures, 'svc.list_jobs', {
            start_date: '2026-07-31',
            end_date: '2026-07-31',
            limit: 100,
        });
        const job = projectSandboxTool(fixtures, 'svc.get_job', { job_id: firstJob.id });
        const tasks = projectSandboxTool(fixtures, 'svc.list_tasks', { status: 'open', limit: 100 });

        const scheduledThatDay = fixtures.jobs
            .filter(candidate => localDate(candidate.start_date, fixtures.company.timezone) === '2026-07-31');
        expect(scheduledThatDay.length).toBeGreaterThan(0);
        expect(jobs.results).toHaveLength(scheduledThatDay.length);
        expect(job).toEqual(firstJob);
        expect(tasks.tasks.every(task => task.status === 'open')).toBe(true);
        expect(jobs.results[0]).toHaveProperty('amount_paid');
        expect(job).not.toHaveProperty('amount_paid');
        const billable = fixtures.jobs.filter(candidate => candidate.invoice_total !== null).length;
        expect(summarizeSandboxFixtures(fixtures)).toEqual({
            companies: 1,
            contacts: dataset.customers.length,
            leads: dataset.leads.length,
            jobs: dataset.jobs.length,
            tasks: dataset.tasks.length,
            invoices: billable,
            payments: billable,
        });
    });

    test('5: company-day Job and due_to Task projection match live semantics and dataset hours are local', () => {
        const anchor = '2026-07-31';
        const fixtures = generateSandboxFixtures('timezone-parity-seed', anchor);
        const generatedJobs = [...fixtures.jobs];
        const lateJob = {
            ...fixtures.jobs[0],
            id: 990001,
            job_number: 'TZ-LATE-JOB',
            start_date: '2026-08-01T01:00:00.000Z',
            end_date: '2026-08-01T03:00:00.000Z',
        };
        const lateTask = {
            ...fixtures.tasks[0],
            id: 990002,
            description: 'TZ late-day task',
            due_at: '2026-08-01T00:30:00.000Z',
        };
        fixtures.jobs.push(lateJob);
        fixtures.tasks.push(lateTask);

        const localJobs = projectSandboxTool(fixtures, 'svc.list_jobs', {
            start_date: anchor,
            end_date: anchor,
            limit: 100,
        });
        const nextDayJobs = projectSandboxTool(fixtures, 'svc.list_jobs', {
            start_date: '2026-08-01',
            end_date: '2026-08-01',
            limit: 100,
        });
        const dueThatDay = projectSandboxTool(fixtures, 'svc.list_tasks', {
            status: 'all',
            due_to: anchor,
            limit: 100,
        });

        expect(localJobs.results.map(job => job.id)).toContain(lateJob.id);
        expect(nextDayJobs.results.map(job => job.id)).not.toContain(lateJob.id);
        expect(dueThatDay.tasks.map(task => task.id)).toContain(lateTask.id);
        for (const [index, plan] of dataset.jobs.entries()) {
            expect(localDate(generatedJobs[index].start_date, fixtures.company.timezone))
                .toBe(shiftDate(anchor, plan.day_offset));
            expect(localHour(generatedJobs[index].start_date, fixtures.company.timezone))
                .toBe(plan.hour);
        }
    });

    test('morning-digest returns a meaningful application result from generated fixtures', async () => {
        const source = referenceSource();
        const execution = await validateAndDryRun({
            source,
            expectedSourceSha256: sourceSha256(source),
            input: { today: '2026-07-31' },
            seed: 'morning-digest-seed',
            anchor: '2026-07-31',
        });

        expect(execution.result).toContain('Morning digest for 2026-07-31');
        expect(execution.result).toContain('Jobs today: 6');
        expect(execution.result).toContain('Open tasks: 8');
        expect(execution.usage).toMatchObject({ gateway_calls: 2, error_code: null });
        expect(execution.fixturesSummary).toMatchObject({
            jobs: dataset.jobs.length,
            tasks: dataset.tasks.length,
        });
    });
});

function shiftDate(anchor, days) {
    const value = new Date(`${anchor}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}
