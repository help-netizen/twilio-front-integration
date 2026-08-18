'use strict';

const mockQuery = jest.fn();

jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({
    logEvent: jest.fn(),
    actorName: () => 'Sandbox Contract',
    getEntityHistory: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    MAX_FILE_SIZE: 1024,
    MAX_FILES_PER_NOTE: 5,
    getAttachmentsForEntity: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/notesMutationService', () => ({}));
jest.mock('../backend/src/services/conversationsService', () => ({}));
jest.mock('../backend/src/services/routeDistanceService', () => ({}));
jest.mock('../backend/src/services/googlePlacesService', () => ({}));
jest.mock('../backend/src/services/emailService', () => ({}));
jest.mock('../backend/src/services/rateMeService', () => ({}));
jest.mock('../backend/src/db/companyQueries', () => ({}));
jest.mock('../backend/src/db/rateMeQueries', () => ({}));
jest.mock('../backend/src/services/messagingHelper', () => ({
    resolveCompanyProxyE164: jest.fn(),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const jobsService = require('../backend/src/services/jobsService');
const tasksQueries = require('../backend/src/db/tasksQueries');
const { safeResult } = require('../backend/src/services/chatgptMcpReadService');
const {
    generateSandboxFixtures,
    projectSandboxTool,
} = require('../apps-runtime/src/sandboxFixtures');

function keyPaths(value, prefix = '') {
    if (Array.isArray(value)) {
        return value.length === 0 ? [prefix] : keyPaths(value[0], `${prefix}[]`);
    }
    if (!value || typeof value !== 'object') return [prefix];
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return [prefix];
    return keys.flatMap(key => keyPaths(value[key], prefix ? `${prefix}.${key}` : key));
}

function jobDbRow(job, index) {
    return {
        ...job,
        start_date: new Date(job.start_date),
        end_date: new Date(job.end_date),
        created_at: new Date(job.created_at),
        updated_at: new Date(job.updated_at),
        zb_raw: { sandbox_provider_blob: true },
        __cursor_null: false,
        __cursor_value: job.updated_at,
        __cursor_id: String(job.id),
        __contract_index: index,
    };
}

function taskDbRow(task) {
    return {
        ...task,
        due_at: task.due_at ? new Date(task.due_at) : null,
        completed_at: task.completed_at ? new Date(task.completed_at) : null,
        created_at: new Date(task.created_at),
        __cursor_null: false,
        __cursor_value: task.due_at,
        __cursor_created: task.created_at,
        __cursor_id: String(task.id),
    };
}

describe('APP-SANDBOX-001 CRM projector response-shape contract', () => {
    test('fixture list/detail/task key paths match the real CRM projectors', async () => {
        const fixtures = generateSandboxFixtures('crm-projector-contract');
        const rows = fixtures.jobs.map(jobDbRow);
        const tagRows = fixtures.jobs.flatMap(job => job.tags.map(tag => ({
            job_id: job.id,
            ...tag,
        })));
        const allocationRows = fixtures.invoices.map(invoice => ({
            job_id: invoice.job_id,
            legacy_paid: 0,
            capacity: invoice.total,
        }));
        const paymentRows = fixtures.invoices.map(invoice => ({
            job_id: invoice.job_id,
            native_pool: invoice.amount_paid,
            total_pool: invoice.amount_paid,
        }));

        mockQuery.mockImplementation(async sql => {
            if (/\(SELECT COUNT\(\*\)::int FROM jobs j/i.test(sql)) {
                return {
                    rows: [{
                        total: rows.length,
                        providers: ['Synthetic Technician 1', 'Synthetic Technician 2'],
                    }],
                };
            }
            if (/SELECT j\.\*,[\s\S]*FROM jobs j/i.test(sql)) return { rows };
            if (/FROM job_tag_assignments jta[\s\S]*scoped_job/i.test(sql)) return { rows: tagRows };
            if (/WITH\s+original_payments AS/i.test(sql)) {
                if (/FROM ordered/i.test(sql)) return { rows: allocationRows };
                if (/FROM ledger_effects[\s\S]*GROUP BY job_id/i.test(sql)) {
                    return { rows: paymentRows };
                }
            }
            throw new Error(`Unexpected Job projector SQL: ${sql}`);
        });
        const realList = safeResult(await jobsService.listJobs({
            companyId: fixtures.company.id,
            limit: 100,
            sortBy: 'updated_at',
        }));
        const sandboxList = projectSandboxTool(fixtures, 'svc.list_jobs', { limit: 100 });
        expect(keyPaths(sandboxList)).toEqual(keyPaths(realList));

        const selected = rows[0];
        mockQuery.mockImplementation(async sql => {
            if (/SELECT j\.\*, l\.serial_id AS lead_serial_id/i.test(sql)) {
                return { rows: [selected] };
            }
            if (/FROM job_tag_assignments jta/i.test(sql)) {
                return {
                    rows: tagRows
                        .filter(row => row.job_id === selected.id)
                        .map(({ job_id, ...tag }) => {
                            void job_id;
                            return tag;
                        }),
                };
            }
            throw new Error(`Unexpected Job detail projector SQL: ${sql}`);
        });
        const realDetail = safeResult(await jobsService.getJobById(
            selected.id,
            fixtures.company.id
        ));
        const sandboxDetail = projectSandboxTool(fixtures, 'svc.get_job', {
            job_id: selected.id,
        });
        expect(keyPaths(sandboxDetail)).toEqual(keyPaths(realDetail));

        const taskRows = fixtures.tasks
            .filter(task => task.status === 'open')
            .map(taskDbRow);
        mockQuery.mockImplementation(async sql => {
            if (/SELECT COUNT\(\*\)::int AS total/i.test(sql)) {
                return { rows: [{ total: taskRows.length }] };
            }
            if (/SELECT page_base\.\*/i.test(sql)) return { rows: taskRows };
            throw new Error(`Unexpected Task projector SQL: ${sql}`);
        });
        const realTasks = safeResult(await tasksQueries.listTasksPage(
            fixtures.company.id,
            { status: 'open', limit: 100 }
        ));
        const sandboxTasks = projectSandboxTool(fixtures, 'svc.list_tasks', {
            status: 'open',
            limit: 100,
        });
        expect(keyPaths(sandboxTasks)).toEqual(keyPaths(realTasks));
    });
});
