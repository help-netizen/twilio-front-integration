'use strict';

const mockQuery = jest.fn();

jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({}));
jest.mock('../backend/src/db/jobFinanceQueries', () => ({
    getJobFinance: jest.fn(),
    listJobFinances: jest.fn(async (_companyId, jobIds) => (
        (jobIds || []).map(jobId => ({ job_id: jobId }))
    )),
}));

const jobsService = require('../backend/src/services/jobsService');
const tasksQueries = require('../backend/src/db/tasksQueries');
const { companyDateFilterBounds } = require('../backend/src/utils/companyTime');

const OWN_COMPANY = '00000000-0000-4000-8000-00000000a001';
const FOREIGN_COMPANY = '00000000-0000-4000-8000-00000000b001';
const NEW_YORK = 'America/New_York';

function jobRow(id, companyId, startDate) {
    return {
        id,
        company_id: companyId,
        blanc_status: 'Submitted',
        assigned_techs: [],
        assigned_provider_user_ids: [],
        notes: [],
        metadata: {},
        start_date: new Date(startDate),
        end_date: new Date(Date.parse(startDate) + 2 * 60 * 60 * 1000),
        created_at: new Date('2026-07-14T12:00:00.000Z'),
        updated_at: new Date('2026-07-14T12:00:00.000Z'),
        __cursor_value: '2026-07-14T12:00:00.000000Z',
        __cursor_id: String(id),
    };
}

function taskRow(id, companyId, dueAt) {
    return {
        id,
        company_id: companyId,
        description: `Task ${id}`,
        status: 'open',
        due_at: new Date(dueAt),
        completed_at: null,
        created_at: new Date('2026-07-14T12:00:00.000Z'),
        parent_type: 'job',
        parent_id: id,
        parent_label: `Job ${id}`,
        __cursor_null: false,
        __cursor_value: dueAt,
        __cursor_created: '2026-07-14T12:00:00.000000Z',
        __cursor_id: String(id),
    };
}

function installJobsDatabase(rows) {
    mockQuery.mockImplementation(async (sql, params) => {
        const bounds = params.filter(value => (
            typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(value)
        ));
        const fromInclusive = bounds[0] || null;
        const toExclusive = bounds[1] || null;
        const matching = rows.filter(row => (
            (!/j\.company_id = \$1/.test(sql) || row.company_id === params[0])
            && (!fromInclusive || row.start_date.getTime() >= Date.parse(fromInclusive))
            && (!toExclusive || row.start_date.getTime() < Date.parse(toExclusive))
        ));
        if (/\(SELECT COUNT\(\*\)::int FROM jobs j/i.test(sql)) {
            return { rows: [{ total: matching.length, providers: [] }] };
        }
        if (/SELECT j\.\*, COALESCE\(c\.full_name/i.test(sql)) return { rows: matching };
        if (/FROM job_tag_assignments jta/i.test(sql)) return { rows: [] };
        throw new Error(`Unexpected Job SQL: ${sql}`);
    });
}

function installTasksDatabase(rows) {
    mockQuery.mockImplementation(async (sql, params) => {
        const bounds = params.filter(value => (
            typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(value)
        ));
        const fromInclusive = bounds.length > 1 ? bounds[0] : null;
        const toExclusive = bounds.at(-1) || null;
        const matching = rows.filter(row => (
            (!/t\.company_id = \$1/.test(sql) || row.company_id === params[0])
            && row.status === 'open'
            && (!fromInclusive || row.due_at.getTime() >= Date.parse(fromInclusive))
            && (!toExclusive || row.due_at.getTime() < Date.parse(toExclusive))
        ));
        if (/SELECT COUNT\(\*\)::int AS total/i.test(sql)) {
            return { rows: [{ total: matching.length }] };
        }
        if (/SELECT page_base\.\*/i.test(sql)) return { rows: matching };
        throw new Error(`Unexpected Task SQL: ${sql}`);
    });
}

beforeEach(() => jest.clearAllMocks());

describe('APP-TZ-001 company-calendar date filters', () => {
    test('1: New York Job at 21:00 local is found only on its local calendar date', async () => {
        const lateJob = jobRow(101, OWN_COMPANY, '2026-07-16T01:00:00.000Z');
        installJobsDatabase([lateJob]);

        const localDay = await jobsService.listJobs({
            companyId: OWN_COMPANY,
            companyTimezone: NEW_YORK,
            startDate: '2026-07-15',
            endDate: '2026-07-15',
            sortBy: 'updated_at',
            offset: 0,
        });
        expect(localDay.results.map(job => job.id)).toEqual([lateJob.id]);
        const localSql = mockQuery.mock.calls.find(([sql]) => /SELECT j\.\*/i.test(sql))[0];
        expect(localSql).toContain('j.start_date >= $2::timestamptz');
        expect(localSql).toContain('j.start_date < $3::timestamptz');
        expect(localSql).not.toContain('DATE(j.start_date');
        expect(localSql).not.toContain('j.start_date AT TIME ZONE');
        expect(localSql).not.toContain("date_trunc(");

        jest.clearAllMocks();
        installJobsDatabase([lateJob]);
        const utcCalendarDay = await jobsService.listJobs({
            companyId: OWN_COMPANY,
            companyTimezone: NEW_YORK,
            startDate: '2026-07-16',
            endDate: '2026-07-16',
            sortBy: 'updated_at',
            offset: 0,
        });
        expect(utcCalendarDay.results).toEqual([]);
    });

    test('2: due_to includes a Task in the second half of its New York day', async () => {
        const lateTask = taskRow(201, OWN_COMPANY, '2026-07-16T00:30:00.000Z');
        installTasksDatabase([lateTask]);

        const page = await tasksQueries.listTasksPage(OWN_COMPANY, {
            companyTimezone: NEW_YORK,
            status: 'open',
            due_to: '2026-07-15',
            limit: 50,
            offset: 0,
        });

        expect(page.tasks.map(task => task.id)).toEqual([lateTask.id]);
        const pageSql = mockQuery.mock.calls.find(([sql]) => /SELECT page_base\.\*/i.test(sql))[0];
        expect(pageSql).toContain('t.due_at < $3::timestamptz');
        expect(pageSql).not.toContain('DATE(t.due_at');
        expect(pageSql).not.toContain('t.due_at AT TIME ZONE');
        expect(pageSql).not.toContain("date_trunc(");
    });

    test('3: spring and fall DST dates resolve to 23-hour and 25-hour ranges', () => {
        const spring = companyDateFilterBounds('2026-03-08', '2026-03-08', NEW_YORK);
        const fall = companyDateFilterBounds('2026-11-01', '2026-11-01', NEW_YORK);

        expect(spring).toMatchObject({
            fromInclusive: '2026-03-08T05:00:00.000Z',
            toExclusive: '2026-03-09T04:00:00.000Z',
        });
        expect(Date.parse(spring.toExclusive) - Date.parse(spring.fromInclusive)).toBe(23 * 60 * 60 * 1000);
        expect(fall).toMatchObject({
            fromInclusive: '2026-11-01T04:00:00.000Z',
            toExclusive: '2026-11-02T05:00:00.000Z',
        });
        expect(Date.parse(fall.toExclusive) - Date.parse(fall.fromInclusive)).toBe(25 * 60 * 60 * 1000);
    });

    test('4: missing or invalid company timezone falls back to UTC without throwing', async () => {
        const utcJob = jobRow(251, OWN_COMPANY, '2026-07-15T21:00:00.000Z');
        for (const companyTimezone of [undefined, '', 'Not/A-Timezone']) {
            expect(companyDateFilterBounds('2026-07-15', '2026-07-15', companyTimezone)).toEqual({
                timezone: 'UTC',
                fromInclusive: '2026-07-15T00:00:00.000Z',
                toExclusive: '2026-07-16T00:00:00.000Z',
            });
            installJobsDatabase([utcJob]);
            await expect(jobsService.listJobs({
                companyId: OWN_COMPANY,
                companyTimezone,
                startDate: '2026-07-15',
                endDate: '2026-07-15',
                sortBy: 'updated_at',
                offset: 0,
            })).resolves.toMatchObject({ results: [{ id: utcJob.id }] });
            jest.clearAllMocks();
        }
    });

    test('6: T-own/T-foreign filters keep same-instant Jobs and Tasks tenant-isolated', async () => {
        const ownJob = jobRow(301, OWN_COMPANY, '2026-07-16T01:00:00.000Z');
        const foreignJob = jobRow(302, FOREIGN_COMPANY, '2026-07-16T01:00:00.000Z');
        installJobsDatabase([ownJob, foreignJob]);
        const jobs = await jobsService.listJobs({
            companyId: OWN_COMPANY,
            companyTimezone: NEW_YORK,
            startDate: '2026-07-15',
            endDate: '2026-07-15',
            sortBy: 'updated_at',
            offset: 0,
        });
        expect(jobs.results.map(job => job.id)).toEqual([ownJob.id]);

        jest.clearAllMocks();
        const ownTask = taskRow(401, OWN_COMPANY, '2026-07-16T00:30:00.000Z');
        const foreignTask = taskRow(402, FOREIGN_COMPANY, '2026-07-16T00:30:00.000Z');
        installTasksDatabase([ownTask, foreignTask]);
        const tasks = await tasksQueries.listTasksPage(OWN_COMPANY, {
            companyTimezone: NEW_YORK,
            status: 'open',
            due_from: '2026-07-15',
            due_to: '2026-07-15',
            limit: 50,
            offset: 0,
        });
        expect(tasks.tasks.map(task => task.id)).toEqual([ownTask.id]);
    });

    test('7 SAB: the late Job is inside company bounds and outside sabotaged UTC bounds', () => {
        const instant = Date.parse('2026-07-16T01:00:00.000Z');
        const companyBounds = companyDateFilterBounds('2026-07-15', '2026-07-15', NEW_YORK);
        const utcBounds = companyDateFilterBounds('2026-07-15', '2026-07-15', 'UTC');
        const contains = bounds => (
            instant >= Date.parse(bounds.fromInclusive)
            && instant < Date.parse(bounds.toExclusive)
        );

        expect(contains(companyBounds)).toBe(true);
        expect(contains(utcBounds)).toBe(false);
    });
});
