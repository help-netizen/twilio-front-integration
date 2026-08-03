'use strict';

const crypto = require('node:crypto');
const dataset = require('./sandboxDataset');

const DEFAULT_SANDBOX_SEED = 'albusto-sandbox-v1';
// The sandbox anchor is the CALLER'S today, not a frozen date: an app that asks
// "how many jobs today" must be testable. A frozen anchor made every
// today-based app report zero and look broken while the code was correct.
// Callers may pin an explicit anchor for reproducible tests.
function resolveAnchorDate(anchor) {
    if (typeof anchor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(anchor)) return anchor;
    return new Date().toISOString().slice(0, 10);
}
function shiftDays(anchorDate, days) {
    const base = Date.parse(anchorDate + 'T00:00:00.000Z');
    return new Date(base + (days * 86400000)).toISOString().slice(0, 10);
}
const CLOSED_JOB_STATUSES = new Set(['Job is Done', 'Canceled']);

class SandboxFixtureError extends Error {
    constructor(code, message, httpStatus) {
        super(message);
        this.name = 'SandboxFixtureError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function normalizeSeed(seed = DEFAULT_SANDBOX_SEED) {
    if ((typeof seed !== 'string' && !Number.isSafeInteger(seed))
        || String(seed).length === 0
        || String(seed).length > 128) {
        throw new SandboxFixtureError(
            'SANDBOX_SEED_INVALID',
            'Sandbox seed must be a non-empty string or safe integer up to 128 characters.',
            400
        );
    }
    return String(seed);
}

function digest(seed, label) {
    return crypto.createHash('sha256').update(`${seed}:${label}`, 'utf8').digest();
}

function syntheticUuid(seed, label) {
    const bytes = Buffer.from(digest(seed, label).subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20),
    ].join('-');
}

function seededNumber(seed, label, minimum, span) {
    return minimum + (digest(seed, label).readUInt32BE(0) % span);
}

function normalizeCompanyTimezone(value) {
    if (typeof value !== 'string' || !value.trim()) return 'UTC';
    const timezone = value.trim();
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
        return timezone;
    } catch {
        return 'UTC';
    }
}

function timezoneOffsetMinutes(utcDate, timezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'longOffset',
    }).formatToParts(utcDate);
    const value = parts.find(part => part.type === 'timeZoneName')?.value || '';
    if (value === 'GMT') return 0;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(value);
    if (!match) return 0;
    const sign = match[1] === '+' ? 1 : -1;
    return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function iso(day, hour, minute = 0, companyTimezone = dataset.timezone) {
    const timezone = normalizeCompanyTimezone(companyTimezone);
    const [year, month, date] = String(day).split('-').map(Number);
    const guess = new Date(Date.UTC(year, month - 1, date, hour, minute, 0));
    const offsetMinutes = timezoneOffsetMinutes(guess, timezone);
    return new Date(guess.getTime() - offsetMinutes * 60_000).toISOString();
}

function localCalendarDate(value, companyTimezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: normalizeCompanyTimezone(companyTimezone),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(value));
    const part = type => parts.find(candidate => candidate.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
}

function companyDateFilterBounds(fromDate, toDate, companyTimezone) {
    const timezone = normalizeCompanyTimezone(companyTimezone);
    return {
        fromInclusive: fromDate ? iso(fromDate, 0, 0, timezone) : null,
        toExclusive: toDate ? iso(shiftDays(toDate, 1), 0, 0, timezone) : null,
    };
}

function addHours(value, hours) {
    return new Date(Date.parse(value) + (hours * 60 * 60 * 1000)).toISOString();
}

function money(value) {
    return value.toFixed(2);
}

function generateSandboxFixtures(seed = DEFAULT_SANDBOX_SEED, anchor = null) {
    const normalizedSeed = normalizeSeed(seed);
    const today = resolveAnchorDate(anchor);
    const marker = digest(normalizedSeed, 'marker').toString('hex').slice(0, 8).toUpperCase();
    const companyId = syntheticUuid(normalizedSeed, 'company');
    const idBase = seededNumber(normalizedSeed, 'ids', 100000, 700000);
    const actorId = syntheticUuid(normalizedSeed, 'actor');
    const day = offset => shiftDays(today, offset);

    const company = {
        id: companyId,
        name: dataset.companyName,
        timezone: dataset.timezone,
        anchor_date: today,
        created_at: iso(day(-720), 12),
        metadata: { sandbox: true, fixture_marker: marker },
    };

    const contacts = dataset.customers.map((customer, index) => ({
        id: idBase + 100 + index + 1,
        company_id: companyId,
        full_name: customer.full_name,
        first_name: customer.first_name,
        last_name: customer.last_name,
        phone: customer.phone,
        email: customer.email,
        address: customer.address,
        city: customer.city,
        postal_code: customer.postal_code,
        created_at: iso(day(-60 + index), 9 + (index % 8)),
    }));

    const technicians = dataset.technicians.map((name, index) => ({
        id: `sandbox-tech-${index + 1}`,
        name,
    }));

    // Jobs first: leads point at them, and invoices and payments hang off them.
    const jobs = dataset.jobs.map((plan, index) => {
        const ordinal = index + 1;
        const contact = contacts[plan.customer_index];
        const customer = dataset.customers[plan.customer_index];
        const service = dataset.services[plan.service_index];
        const technician = technicians[plan.technician_index];
        const minute = seededNumber(normalizedSeed, `minute-${ordinal}`, 0, 4) * 15;
        const startDate = iso(day(plan.day_offset), plan.hour, minute);
        const closed = CLOSED_JOB_STATUSES.has(plan.status);
        return {
            id: idBase + 300 + ordinal,
            lead_id: null,
            lead_serial_id: null,
            contact_id: contact.id,
            zenbooker_job_id: null,
            blanc_status: plan.status,
            zb_status: closed || plan.status === 'Visit completed' ? 'complete' : 'scheduled',
            zb_rescheduled: false,
            zb_canceled: plan.status === 'Canceled',
            job_number: `NAC-${String(1200 + ordinal)}`,
            service_name: service.name,
            start_date: startDate,
            end_date: addHours(startDate, 2),
            customer_name: customer.full_name,
            customer_phone: customer.phone,
            customer_email: customer.email,
            address: customer.address,
            city: customer.city,
            postal_code: customer.postal_code,
            territory: 'Greater Boston',
            invoice_total: plan.billing ? money(service.price) : null,
            invoice_status: plan.billing === 'paid' ? 'paid' : (plan.billing ? 'partial' : null),
            assigned_techs: [technician],
            assigned_provider_user_ids: [actorId],
            notes: [{ id: `sandbox-note-${ordinal}`, text: plan.note }],
            tags: [{ id: ordinal, name: service.type, color: 'slate', is_active: true }],
            job_type: service.type,
            job_source: null,
            description: plan.note,
            comments: null,
            metadata: { sandbox: true, fixture_marker: marker },
            company_id: companyId,
            created_at: iso(day(plan.day_offset - 2), 9 + (index % 8)),
            updated_at: iso(day(Math.min(plan.day_offset, 0)), 8 + (index % 10)),
            lat: 42.34 + (index / 900),
            lng: -71.06 - (index / 900),
        };
    });

    const leads = dataset.leads.map((plan, index) => {
        const ordinal = index + 1;
        const contact = contacts[plan.customer_index];
        const job = plan.job_index === null ? null : jobs[plan.job_index];
        const lead = {
            id: idBase + 200 + ordinal,
            uuid: syntheticUuid(normalizedSeed, `lead-${ordinal}`),
            serial_id: `L-${String(4300 + ordinal)}`,
            company_id: companyId,
            contact_id: contact.id,
            status: plan.status,
            source: plan.source,
            job_source: plan.source,
            notes: plan.note,
            created_at: iso(day(plan.day_offset), 8 + (index % 11)),
            converted_at: job ? iso(day(plan.day_offset + 1), 10 + (index % 6)) : null,
            job_id: job ? job.id : null,
        };
        if (job) {
            job.lead_id = lead.id;
            job.lead_serial_id = lead.serial_id;
            job.job_source = plan.source;
            // A job cannot predate the conversion that created it.
            job.created_at = addHours(lead.converted_at, 1);
        }
        return lead;
    });

    const estimates = dataset.estimates.map((plan, index) => {
        const ordinal = index + 1;
        const job = jobs[plan.job_index];
        const items = plan.items.map(item => ({
            name: item.name,
            description: item.description || null,
            quantity: item.quantity,
            unit: item.unit || null,
            unit_price: money(item.unit_price),
            amount: money(item.quantity * item.unit_price),
            item_type: item.item_type || null,
        }));
        const subtotal = plan.items.reduce(
            (sum, item) => sum + (item.quantity * item.unit_price),
            0
        );
        const taxAmount = Math.round(subtotal * plan.tax_rate) / 100;
        return {
            id: idBase + 700 + ordinal,
            company_id: companyId,
            estimate_number: `EST-${String(8100 + ordinal)}`,
            status: plan.status,
            subtotal: money(subtotal),
            tax_amount: money(taxAmount),
            total: money(subtotal + taxAmount),
            contact_id: job.contact_id,
            job_id: job.id,
            lead_id: job.lead_id,
            accepted_at: plan.accepted_day_offset === undefined
                ? null
                : iso(
                    day(plan.accepted_day_offset),
                    plan.accepted_hour,
                    plan.accepted_minute || 0
                ),
            created_at: iso(day(plan.created_day_offset), 10 + (index % 7)),
            summary: plan.summary,
            notes: null,
            items,
            order_list: plan.order_list.map(row => ({ ...row })),
        };
    });

    const billable = jobs.filter(job => job.invoice_total !== null);
    const invoices = billable.map((job, index) => {
        const total = Number(job.invoice_total);
        const paid = job.invoice_status === 'paid' ? total : Math.round(total * 0.4 * 100) / 100;
        return {
            id: idBase + 500 + index + 1,
            company_id: companyId,
            job_id: job.id,
            invoice_number: `INV-${String(7100 + index + 1)}`,
            status: job.invoice_status,
            total: money(total),
            amount_paid: money(paid),
            balance_due: money(Math.round((total - paid) * 100) / 100),
            created_at: job.updated_at,
            due_at: iso(day(7), 10),
        };
    });

    const payments = invoices.map((invoice, index) => ({
        id: idBase + 600 + index + 1,
        company_id: companyId,
        invoice_id: invoice.id,
        job_id: invoice.job_id,
        status: 'completed',
        amount: invoice.amount_paid,
        method: index % 3 === 0 ? 'card' : 'check',
        paid_at: invoice.created_at,
        created_at: invoice.created_at,
    }));

    const tasks = dataset.tasks.map((plan, index) => {
        const parent = plan.parent_type === 'job' ? jobs[plan.parent_index] : leads[plan.parent_index];
        return {
            id: idBase + 400 + index + 1,
            company_id: companyId,
            description: plan.description,
            status: plan.status,
            due_at: iso(day(plan.day_offset), 12 + (index % 6)),
            completed_at: plan.status === 'done' ? iso(day(plan.day_offset), 16) : null,
            created_at: iso(day(plan.day_offset - 3), 9 + (index % 7)),
            owner_user_id: actorId,
            author_user_id: actorId,
            thread_id: null,
            kind: 'manual',
            agent_type: null,
            agent_output: null,
            actions: [],
            assignee_name: 'Dispatch',
            assignee_email: 'dispatch@example.com',
            author_name: 'Dispatch',
            parent_type: plan.parent_type,
            parent_id: parent.id,
            parent_label: plan.parent_type === 'job' ? parent.service_name : parent.serial_id,
        };
    });

    return {
        seed: normalizedSeed,
        company,
        contacts,
        leads,
        jobs,
        tasks,
        estimates,
        invoices,
        payments,
    };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function pagination(mode, limit, returned, hasMore, total, offset) {
    return {
        mode,
        limit,
        returned,
        has_more: hasMore,
        next_cursor: mode === 'cursor' && hasMore ? `sandbox:${offset + returned}` : null,
        total,
    };
}

function projectListJobs(fixtures, args) {
    const search = typeof args.search === 'string' ? args.search.trim().toLowerCase() : '';
    const dateBounds = companyDateFilterBounds(
        args.start_date,
        args.end_date,
        fixtures.company?.timezone
    );
    let rows = fixtures.jobs.filter(job => {
        if (args.status && job.blanc_status !== args.status) return false;
        if (args.only_open === true && CLOSED_JOB_STATUSES.has(job.blanc_status)) return false;
        if (dateBounds.fromInclusive
            && Date.parse(job.start_date) < Date.parse(dateBounds.fromInclusive)) return false;
        if (dateBounds.toExclusive
            && Date.parse(job.start_date) >= Date.parse(dateBounds.toExclusive)) return false;
        if (search && ![
            job.job_number,
            job.service_name,
            job.customer_name,
            job.customer_phone,
            job.address,
        ].some(value => String(value || '').toLowerCase().includes(search))) return false;
        return true;
    });
    rows = rows.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    const total = rows.length;
    const mode = args.offset === undefined ? 'cursor' : 'offset';
    const offset = Number.isInteger(args.offset) ? args.offset : 0;
    const limit = Number.isInteger(args.limit) ? args.limit : 50;
    const page = rows.slice(offset, offset + limit);
    const invoiceByJob = new Map(fixtures.invoices.map(invoice => [invoice.job_id, invoice]));
    const results = page.map(job => {
        const invoice = invoiceByJob.get(job.id);
        return {
            ...clone(job),
            amount_paid: invoice?.amount_paid ?? null,
            balance_due: invoice?.balance_due ?? null,
        };
    });
    const hasMore = offset + results.length < total;
    return {
        results,
        total,
        offset,
        limit,
        has_more: hasMore,
        facets: {
            providers: [...new Set(fixtures.jobs.flatMap(job => (
                job.assigned_techs.map(tech => tech.name)
            )))].sort(),
        },
        pagination: pagination(mode, limit, results.length, hasMore, total, offset),
    };
}

function projectGetJob(fixtures, args) {
    if (!Number.isSafeInteger(args.job_id) || args.job_id < 1) {
        throw new SandboxFixtureError(
            'INVALID_ARGUMENTS',
            'job_id must be a positive integer.',
            422
        );
    }
    const job = fixtures.jobs.find(candidate => candidate.id === args.job_id);
    if (!job) throw new SandboxFixtureError('NOT_FOUND', 'Job not found.', 404);
    return clone(job);
}

function projectListTasks(fixtures, args) {
    const search = typeof args.search === 'string' ? args.search.trim().toLowerCase() : '';
    const companyTimezone = fixtures.company?.timezone;
    const dateBounds = companyDateFilterBounds(args.due_from, args.due_to, companyTimezone);
    let rows = fixtures.tasks.filter(task => {
        const status = args.status === 'all' ? null : (args.status || 'open');
        if (status && task.status !== status) return false;
        if (args.parent_type && task.parent_type !== args.parent_type) return false;
        if (args.overdue === true
            && (task.status !== 'open' || !task.due_at
                || localCalendarDate(task.due_at, companyTimezone)
                    >= (fixtures.company?.anchor_date || resolveAnchorDate(null)))) {
            return false;
        }
        if (dateBounds.fromInclusive
            && (!task.due_at || Date.parse(task.due_at) < Date.parse(dateBounds.fromInclusive))) return false;
        if (dateBounds.toExclusive
            && (!task.due_at || Date.parse(task.due_at) >= Date.parse(dateBounds.toExclusive))) return false;
        if (search && ![task.description, task.parent_label, task.assignee_name]
            .some(value => String(value || '').toLowerCase().includes(search))) return false;
        return true;
    });
    rows = rows.sort((left, right) => {
        if (left.due_at === right.due_at) return right.created_at.localeCompare(left.created_at);
        if (left.due_at === null) return 1;
        if (right.due_at === null) return -1;
        return left.due_at.localeCompare(right.due_at);
    });
    const total = rows.length;
    const mode = args.offset === undefined ? 'cursor' : 'offset';
    const offset = Number.isInteger(args.offset) ? args.offset : 0;
    const limit = Number.isInteger(args.limit) ? args.limit : 50;
    const tasks = clone(rows.slice(offset, offset + limit));
    const hasMore = offset + tasks.length < total;
    return {
        tasks,
        pagination: pagination(mode, limit, tasks.length, hasMore, total, offset),
    };
}

function projectEstimateSummary(estimate) {
    return {
        id: estimate.id,
        estimate_number: estimate.estimate_number,
        status: estimate.status,
        subtotal: estimate.subtotal,
        tax_amount: estimate.tax_amount,
        total: estimate.total,
        contact_id: estimate.contact_id ?? null,
        job_id: estimate.job_id ?? null,
        lead_id: estimate.lead_id ?? null,
        accepted_at: estimate.accepted_at ?? null,
        created_at: estimate.created_at,
        items_count: Array.isArray(estimate.items) ? estimate.items.length : 0,
        order_list_count: Array.isArray(estimate.order_list) ? estimate.order_list.length : 0,
    };
}

function projectListEstimates(fixtures, args) {
    const search = typeof args.search === 'string' ? args.search.trim().toLowerCase() : '';
    const dateBounds = companyDateFilterBounds(
        args.accepted_from,
        args.accepted_to,
        fixtures.company?.timezone
    );
    let rows = fixtures.estimates.filter(estimate => {
        if (args.status && estimate.status !== args.status) return false;
        if (dateBounds.fromInclusive
            && (!estimate.accepted_at
                || Date.parse(estimate.accepted_at) < Date.parse(dateBounds.fromInclusive))) return false;
        if (dateBounds.toExclusive
            && (!estimate.accepted_at
                || Date.parse(estimate.accepted_at) >= Date.parse(dateBounds.toExclusive))) return false;
        if (search && ![
            estimate.estimate_number,
            estimate.summary,
            estimate.notes,
        ].some(value => String(value || '').toLowerCase().includes(search))) return false;
        return true;
    });
    rows = rows.sort((left, right) => (
        right.created_at.localeCompare(left.created_at) || Number(right.id) - Number(left.id)
    ));
    const total = rows.length;
    const offset = Number.isInteger(args.offset) ? args.offset : 0;
    const limit = Number.isInteger(args.limit) ? args.limit : 50;
    const results = rows.slice(offset, offset + limit).map(projectEstimateSummary);
    const hasMore = offset + results.length < total;
    return {
        results,
        pagination: pagination('offset', limit, results.length, hasMore, total, offset),
    };
}

function projectGetEstimate(fixtures, args) {
    if (!Number.isSafeInteger(args.estimate_id) || args.estimate_id < 1) {
        throw new SandboxFixtureError(
            'INVALID_ARGUMENTS',
            'estimate_id must be a positive integer.',
            422
        );
    }
    const estimate = fixtures.estimates.find(candidate => candidate.id === args.estimate_id);
    if (!estimate) throw new SandboxFixtureError('NOT_FOUND', 'Estimate not found.', 404);
    return {
        ...projectEstimateSummary(estimate),
        items: clone(estimate.items || []),
        order_list: clone(estimate.order_list || []),
    };
}

function projectSandboxTool(fixtures, toolName, args = {}) {
    if (!fixtures || typeof fixtures !== 'object' || Array.isArray(fixtures)
        || !args || typeof args !== 'object' || Array.isArray(args)) {
        throw new SandboxFixtureError(
            'DRY_RUN_FIXTURES_INVALID',
            'Sandbox fixtures and tool arguments must be objects.',
            400
        );
    }
    if (toolName === 'svc.list_jobs') return projectListJobs(fixtures, args);
    if (toolName === 'svc.get_job') return projectGetJob(fixtures, args);
    if (toolName === 'svc.list_tasks') return projectListTasks(fixtures, args);
    if (toolName === 'svc.list_estimates') return projectListEstimates(fixtures, args);
    if (toolName === 'svc.get_estimate') return projectGetEstimate(fixtures, args);
    throw new SandboxFixtureError('TOOL_NOT_FOUND', 'Tool not found.', 404);
}

function summarizeSandboxFixtures(fixtures) {
    const graph = fixtures && Array.isArray(fixtures.jobs) && Array.isArray(fixtures.tasks);
    if (graph) {
        return {
            companies: fixtures.company ? 1 : 0,
            contacts: Array.isArray(fixtures.contacts) ? fixtures.contacts.length : 0,
            leads: Array.isArray(fixtures.leads) ? fixtures.leads.length : 0,
            jobs: fixtures.jobs.length,
            tasks: fixtures.tasks.length,
            estimates: Array.isArray(fixtures.estimates) ? fixtures.estimates.length : 0,
            invoices: Array.isArray(fixtures.invoices) ? fixtures.invoices.length : 0,
            payments: Array.isArray(fixtures.payments) ? fixtures.payments.length : 0,
        };
    }
    return {
        companies: 0,
        contacts: 0,
        leads: 0,
        jobs: Array.isArray(fixtures?.['svc.list_jobs']?.results)
            ? fixtures['svc.list_jobs'].results.length
            : 0,
        tasks: Array.isArray(fixtures?.['svc.list_tasks']?.tasks)
            ? fixtures['svc.list_tasks'].tasks.length
            : 0,
        estimates: Array.isArray(fixtures?.['svc.list_estimates']?.results)
            ? fixtures['svc.list_estimates'].results.length
            : 0,
        invoices: 0,
        payments: 0,
    };
}

module.exports = {
    DEFAULT_SANDBOX_SEED,
    resolveAnchorDate,
    shiftDays,
    SandboxFixtureError,
    companyDateFilterBounds,
    generateSandboxFixtures,
    normalizeSeed,
    projectGetEstimate,
    projectListEstimates,
    projectSandboxTool,
    summarizeSandboxFixtures,
};
