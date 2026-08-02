'use strict';

const crypto = require('node:crypto');

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

function iso(day, hour, minute = 0) {
    return `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
}

function addHours(value, hours) {
    return new Date(Date.parse(value) + (hours * 60 * 60 * 1000)).toISOString();
}

function money(value) {
    return value.toFixed(2);
}

function generateSandboxFixtures(seed = DEFAULT_SANDBOX_SEED, anchor = null) {
    const normalizedSeed = normalizeSeed(seed);
    const SANDBOX_TODAY = resolveAnchorDate(anchor);
    const DAY_BEFORE = shiftDays(SANDBOX_TODAY, -30);
    const RECENT = shiftDays(SANDBOX_TODAY, -14);
    const TOMORROW = shiftDays(SANDBOX_TODAY, 1);
    const marker = digest(normalizedSeed, 'marker').toString('hex').slice(0, 8).toUpperCase();
    const companyId = syntheticUuid(normalizedSeed, 'company');
    const idBase = seededNumber(normalizedSeed, 'ids', 100000, 700000);
    const actorId = syntheticUuid(normalizedSeed, 'actor');
    const company = {
        id: companyId,
        name: `Sandbox Demo Company ${marker}`,
        timezone: 'America/New_York',
        anchor_date: SANDBOX_TODAY,
        created_at: iso(DAY_BEFORE, 12),
    };
    const services = [
        'Synthetic HVAC inspection',
        'Synthetic drain cleaning',
        'Synthetic electrical diagnostic',
        'Synthetic appliance tune-up',
        'Synthetic leak check',
        'Synthetic maintenance visit',
    ];
    const statuses = [
        'Submitted',
        'Waiting for parts',
        'On the way',
        'Visit completed',
        'Job is Done',
        'Canceled',
    ];
    const contacts = [];
    const leads = [];
    const jobs = [];

    for (let index = 0; index < 6; index += 1) {
        const ordinal = index + 1;
        const contactId = idBase + 100 + ordinal;
        const leadId = idBase + 200 + ordinal;
        const jobId = idBase + 300 + ordinal;
        const minute = seededNumber(normalizedSeed, `minute-${ordinal}`, 0, 4) * 5;
        const startDate = iso(SANDBOX_TODAY, 8 + index, minute);
        const endDate = addHours(startDate, 2);
        const customerName = `Synthetic Customer ${ordinal} ${marker.slice(0, 4)}`;
        const contact = {
            id: contactId,
            company_id: companyId,
            full_name: customerName,
            phone: `+120255501${String(index).padStart(2, '0')}`,
            email: `sandbox+${marker.toLowerCase()}-${ordinal}@example.invalid`,
            created_at: iso(DAY_BEFORE, 10 + index),
        };
        const lead = {
            id: leadId,
            uuid: `SBX-${marker}-${ordinal}`,
            serial_id: `SANDBOX-LEAD-${ordinal}`,
            company_id: companyId,
            contact_id: contactId,
            status: 'Converted',
            source: 'Synthetic sandbox',
            created_at: iso(shiftDays(SANDBOX_TODAY, -16), 10 + index),
            converted_at: iso(shiftDays(SANDBOX_TODAY, -15), 11 + index),
        };
        const invoiceTotal = index < 5 ? 120 + (index * 35) : null;
        const assignedTech = {
            id: `sandbox-tech-${(index % 2) + 1}`,
            name: `Synthetic Technician ${(index % 2) + 1}`,
        };
        const job = {
            id: jobId,
            lead_id: leadId,
            lead_serial_id: lead.serial_id,
            contact_id: contactId,
            zenbooker_job_id: `sandbox-job-${marker.toLowerCase()}-${ordinal}`,
            blanc_status: statuses[index],
            zb_status: statuses[index] === 'Visit completed' || statuses[index] === 'Job is Done'
                ? 'complete'
                : 'scheduled',
            zb_rescheduled: false,
            zb_canceled: statuses[index] === 'Canceled',
            job_number: `SBX-${marker.slice(0, 4)}-${String(ordinal).padStart(3, '0')}`,
            service_name: services[(index + seededNumber(normalizedSeed, 'service-order', 0, 6)) % 6],
            start_date: startDate,
            end_date: endDate,
            customer_name: customerName,
            customer_phone: contact.phone,
            customer_email: contact.email,
            address: `${100 + ordinal} Sandbox Avenue`,
            city: 'Testville',
            territory: 'Synthetic East',
            invoice_total: invoiceTotal === null ? null : money(invoiceTotal),
            invoice_status: invoiceTotal === null ? null : (index < 4 ? 'partial' : 'sent'),
            assigned_techs: [assignedTech],
            assigned_provider_user_ids: [actorId],
            notes: [{ id: `sandbox-note-${ordinal}`, text: 'Synthetic sandbox note.' }],
            tags: [{ id: ordinal, name: 'Sandbox', color: 'slate', is_active: true }],
            job_type: 'Synthetic service',
            job_source: 'App Studio sandbox',
            description: `Synthetic work order ${ordinal}; safe for sandbox testing only.`,
            comments: null,
            metadata: { sandbox: true, fixture_marker: marker },
            company_id: companyId,
            created_at: iso(RECENT, 10 + index),
            updated_at: iso(SANDBOX_TODAY, 9 + index),
            lat: 38.89 + (index / 1000),
            lng: -77.03 - (index / 1000),
        };
        contacts.push(contact);
        leads.push(lead);
        jobs.push(job);
    }

    const tasks = Array.from({ length: 8 }, (_unused, index) => {
        const job = jobs[index % jobs.length];
        const open = index < 6;
        return {
            id: idBase + 400 + index + 1,
            company_id: companyId,
            description: `Synthetic follow-up ${index + 1} for ${job.job_number}`,
            status: open ? 'open' : 'done',
            due_at: iso(index < 5 ? SANDBOX_TODAY : TOMORROW, 14 + (index % 4)),
            completed_at: open ? null : iso(shiftDays(SANDBOX_TODAY, -3), 15 + (index % 2)),
            created_at: iso(RECENT, 9 + index),
            owner_user_id: actorId,
            author_user_id: actorId,
            thread_id: null,
            kind: 'manual',
            agent_type: null,
            agent_output: null,
            actions: [],
            assignee_name: 'Synthetic Dispatcher',
            assignee_email: `sandbox-dispatcher-${marker.toLowerCase()}@example.invalid`,
            author_name: 'Synthetic Sandbox Generator',
            parent_type: 'job',
            parent_id: job.id,
            parent_label: job.service_name,
        };
    });

    const invoices = jobs.slice(0, 5).map((job, index) => ({
        id: idBase + 500 + index + 1,
        company_id: companyId,
        job_id: job.id,
        invoice_number: `SBX-INV-${marker.slice(0, 4)}-${index + 1}`,
        status: index < 4 ? 'partial' : 'sent',
        total: money(120 + (index * 35)),
        amount_paid: index < 4 ? money(50 + (index * 20)) : '0.00',
        balance_due: index < 4
            ? money((120 + (index * 35)) - (50 + (index * 20)))
            : money(120 + (index * 35)),
        created_at: iso(RECENT, 10 + index),
        due_at: iso(shiftDays(SANDBOX_TODAY, 7), 10 + index),
    }));
    const payments = invoices.slice(0, 4).map((invoice, index) => ({
        id: idBase + 600 + index + 1,
        company_id: companyId,
        invoice_id: invoice.id,
        job_id: invoice.job_id,
        status: 'completed',
        amount: invoice.amount_paid,
        paid_at: iso(shiftDays(SANDBOX_TODAY, -7), 11 + index),
        created_at: iso(shiftDays(SANDBOX_TODAY, -7), 11 + index),
    }));

    return {
        seed: normalizedSeed,
        company,
        contacts,
        leads,
        jobs,
        tasks,
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
    let rows = fixtures.jobs.filter(job => {
        if (args.status && job.blanc_status !== args.status) return false;
        if (args.only_open === true && CLOSED_JOB_STATUSES.has(job.blanc_status)) return false;
        if (args.start_date && job.start_date.slice(0, 10) < args.start_date) return false;
        if (args.end_date && job.start_date.slice(0, 10) > args.end_date) return false;
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
    let rows = fixtures.tasks.filter(task => {
        const status = args.status === 'all' ? null : (args.status || 'open');
        if (status && task.status !== status) return false;
        if (args.parent_type && task.parent_type !== args.parent_type) return false;
        if (args.overdue === true
            && (task.status !== 'open' || !task.due_at
                || task.due_at.slice(0, 10) >= (fixtures.company?.anchor_date || resolveAnchorDate(null)))) {
            return false;
        }
        if (args.due_from && (!task.due_at || task.due_at.slice(0, 10) < args.due_from)) return false;
        if (args.due_to && (!task.due_at || task.due_at.slice(0, 10) > args.due_to)) return false;
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
        invoices: 0,
        payments: 0,
    };
}

module.exports = {
    DEFAULT_SANDBOX_SEED,
    resolveAnchorDate,
    shiftDays,
    SandboxFixtureError,
    generateSandboxFixtures,
    normalizeSeed,
    projectSandboxTool,
    summarizeSandboxFixtures,
};
