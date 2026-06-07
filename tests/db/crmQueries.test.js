jest.mock('../../backend/src/db/connection', () => ({
    query: jest.fn(),
}));

const db = require('../../backend/src/db/connection');
const accountsQueries = require('../../backend/src/db/crmAccountsQueries');
const contactsQueries = require('../../backend/src/db/crmContactsQueries');
const dealsQueries = require('../../backend/src/db/crmDealsQueries');
const tasksQueries = require('../../backend/src/db/crmTasksQueries');
const activitiesQueries = require('../../backend/src/db/crmActivitiesQueries');

describe('CRM query gaps', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        db.query.mockResolvedValue({ rows: [] });
    });

    test('getStaleAccounts uses activity history instead of only account last_contact_at', async () => {
        await accountsQueries.getStaleAccounts('company-1', 14);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('FROM crm_activities act');
        expect(sql).toContain('NOT EXISTS');
        expect(sql).toContain('act.account_id = a.id');
        expect(params).toEqual(['company-1', 14, 50, 0]);
    });

    test('entity lookups are tenant-scoped and return null for foreign company rows', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await expect(dealsQueries.getDealById('company-1', 9)).resolves.toBeNull();
        expect(db.query.mock.calls.at(-1)[0]).toContain('WHERE d.company_id = $1 AND d.id = $2');
        expect(db.query.mock.calls.at(-1)[1]).toEqual(['company-1', 9]);

        db.query.mockResolvedValueOnce({ rows: [] });
        await expect(contactsQueries.getContactById('company-1', 8)).resolves.toBeNull();
        expect(db.query.mock.calls.at(-1)[0]).toContain('WHERE c.company_id = $1 AND c.id = $2');
        expect(db.query.mock.calls.at(-1)[1]).toEqual(['company-1', 8]);

        db.query.mockResolvedValueOnce({ rows: [] });
        await expect(tasksQueries.getTaskById('company-1', 7)).resolves.toBeNull();
        expect(db.query.mock.calls.at(-1)[0]).toContain('WHERE company_id = $1 AND id = $2');
        expect(db.query.mock.calls.at(-1)[1]).toEqual(['company-1', 7]);
    });

    test('write update queries keep tenant scope so foreign rows are not modified', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 9, company_id: 'company-1', next_step: 'Old' }] })
            .mockResolvedValueOnce({ rows: [{ id: 9, company_id: 'company-1', next_step: 'New' }] })
            .mockResolvedValueOnce({ rows: [] });

        await dealsQueries.updateDealField('company-1', 9, 'next_step', 'New', 'user-1', 'test', 'req-1');

        const [sql, params] = db.query.mock.calls[1];
        expect(sql).toContain('WHERE company_id = $1 AND id = $2');
        expect(params).toEqual(['company-1', 9, 'New']);
    });

    test('activity and task lists are tenant-scoped for empty foreign-company results', async () => {
        await activitiesQueries.listActivities('company-1', { deal_id: 9, limit: 10 });
        expect(db.query.mock.calls.at(-1)[0]).toContain('WHERE company_id = $1');
        expect(db.query.mock.calls.at(-1)[1]).toEqual(['company-1', 9, 10, 0]);

        await tasksQueries.listTasks('company-1', { owner_user_id: 'user-1', limit: 10 });
        expect(db.query.mock.calls.at(-1)[0]).toContain('WHERE t.company_id = $1');
        expect(db.query.mock.calls.at(-1)[1]).toEqual(['company-1', 'user-1', 10, 0]);
    });

    test('getPipelineDeals supports team_id through user group membership', async () => {
        await dealsQueries.getPipelineDeals('company-1', { team_id: 'team-1' });

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('FROM user_groups ug');
        expect(sql).toContain('JOIN user_group_members ugm');
        expect(sql).toContain('ugm.user_id = d.owner_user_id::text');
        expect(params).toEqual(['company-1', 'team-1']);
    });

    test('getDealHistorySince applies owner, team, and period pipeline scope', async () => {
        await dealsQueries.getDealHistorySince('company-1', '2026-05-27T00:00:00.000Z', {
            owner_user_id: 'owner-1',
            team_id: 'team-1',
            period_start: '2026-06-01',
            period_end: '2026-06-30',
        });

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('JOIN crm_deals d ON d.id = h.deal_id');
        expect(sql).toContain('d.owner_user_id = $3');
        expect(sql).toContain('FROM user_groups ug');
        expect(sql).toContain('d.close_date >= $5::date');
        expect(sql).toContain('d.close_date <= $6::date');
        expect(params).toEqual([
            'company-1',
            '2026-05-27T00:00:00.000Z',
            'owner-1',
            'team-1',
            '2026-06-01',
            '2026-06-30',
        ]);
    });

    test('getLatestPipelineSnapshotBefore matches the same forecast dimensions', async () => {
        await dealsQueries.getLatestPipelineSnapshotBefore('company-1', '2026-05-27T00:00:00.000Z', {
            owner_user_id: '00000000-0000-0000-0000-000000000001',
            team_id: 'team-1',
            period_start: '2026-06-01',
            period_end: '2026-06-30',
        });

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('FROM crm_pipeline_weekly_snapshots');
        expect(sql).toContain('owner_user_id = $3::uuid');
        expect(sql).toContain('team_id = $4::text');
        expect(sql).toContain('period_start = $5::date');
        expect(sql).toContain('period_end = $6::date');
        expect(params).toEqual([
            'company-1',
            '2026-05-27T00:00:00.000Z',
            '00000000-0000-0000-0000-000000000001',
            'team-1',
            '2026-06-01',
            '2026-06-30',
        ]);
    });

    test('getForecastCategories returns company-scoped display order metadata', async () => {
        await dealsQueries.getForecastCategories('company-1');

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('FROM crm_forecast_categories');
        expect(sql).toContain('WHERE company_id = $1');
        expect(sql).toContain('category_key');
        expect(sql).toContain('display_order');
        expect(params).toEqual(['company-1']);
    });
});
