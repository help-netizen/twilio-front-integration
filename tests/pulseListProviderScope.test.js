/**
 * ROLE-PULSE-LIST-SCOPE-002 — the Pulse sidebar feed (GET /api/calls/by-contact →
 * getUnifiedTimelinePage) must be provider-scoped. ROLE-PULSE-SCOPE-001 only scoped the
 * OPEN checks + the contacts list, not this unified timelines page, so a provider saw
 * every company timeline (calls/emails/SMS incl. contactless orphans) and only 403'd on
 * open. This locks the list query itself.
 */
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(async () => ({ rows: [] })) }));

const db = require('../backend/src/db/connection');
const { PULSE_INACTIVE_JOB_STATUSES } = require('../backend/src/middleware/providerScope');
const { getUnifiedTimelinePage } = require('../backend/src/db/timelinesQueries');

beforeEach(() => db.query.mockClear());

async function sqlFor(opts) {
    await getUnifiedTimelinePage({ companyId: 'company-1', ...opts });
    return db.query.mock.calls[0]; // [sql, params]
}

describe('ROLE-PULSE-LIST-SCOPE-002 unified timeline page provider scope', () => {
    it('office (no providerScope / assignedOnly=false) applies NO provider filter', async () => {
        const [sql] = await sqlFor({
            providerScope: { assignedOnly: false, userId: null },
            taskContentScope: { canViewAll: true, userId: null },
        });
        expect(sql).not.toMatch(/pj\.assigned_provider_user_ids/);
        expect(sql).not.toMatch(/AND FALSE/);
    });

    it('a legacy caller with no providerScope is unaffected (office behavior)', async () => {
        const [sql] = await sqlFor({});
        expect(sql).not.toMatch(/pj\.assigned_provider_user_ids/);
    });

    it('provider (assigned_only + userId) restricts to active-job contacts, drops orphans', async () => {
        const [sql, params] = await sqlFor({ providerScope: { assignedOnly: true, userId: 'user-1' } });
        // Must require a contact AND an assigned, active job for that contact.
        expect(sql).toMatch(/tl\.contact_id IS NOT NULL AND EXISTS/);
        expect(sql).toMatch(/pj\.assigned_provider_user_ids @> \$\d+::jsonb/);
        // NULL-safe deny-list (active = not Canceled/Job is Done), NOT an allow-list.
        expect(sql).toContain("pj.blanc_status IS NULL OR pj.blanc_status <> ALL(ARRAY['Canceled', 'Job is Done']::text[])");
        expect(sql).not.toMatch(/pj\.blanc_status = ANY/);
        expect(params).toContain(JSON.stringify(['user-1']));
        expect(PULSE_INACTIVE_JOB_STATUSES).toEqual(['Canceled', 'Job is Done']);
    });

    it('provider assigned_only WITHOUT a resolved user denies everything (never widens)', async () => {
        const [sql] = await sqlFor({ providerScope: { assignedOnly: true, userId: null } });
        expect(sql).toMatch(/AND FALSE/);
        expect(sql).not.toMatch(/pj\.assigned_provider_user_ids/);
    });
});

describe('AR-PROVIDER-SCOPE-001 task-derived Action Required scope', () => {
    it('provider aggregate includes only tasks assigned to OR authored by the actor', async () => {
        const [sql, params] = await sqlFor({
            taskContentScope: { canViewAll: false, userId: 'user-1' },
        });
        const actorIndex = params.indexOf('user-1') + 1;

        expect(actorIndex).toBeGreaterThan(0);
        expect(sql).toContain(`ot.owner_user_id = $${actorIndex}`);
        expect(sql).toContain(`ot.author_user_id = $${actorIndex}`);
        expect(sql).toContain('ot.company_id = tl.company_id');
        expect(sql).toContain('assignee.company_id = ot.company_id');
        expect(sql).toContain('author.company_id = ot.company_id');
        const code = sql.replace(/--[^\n]*/g, '');
        const where = code.slice(code.indexOf('WHERE tl.company_id = $1'), code.lastIndexOf('ORDER BY'));
        expect(where).not.toContain('tl.is_action_required = true');
    });

    it('tasks.manage leaves the task aggregate company-wide for office roles', async () => {
        const [sql] = await sqlFor({
            taskContentScope: { canViewAll: true, userId: null },
        });

        expect(sql).not.toMatch(/ot\.owner_user_id = \$\d+/);
        expect(sql).not.toMatch(/ot\.author_user_id = \$\d+/);
        const code = sql.replace(/--[^\n]*/g, '');
        const where = code.slice(code.indexOf('WHERE tl.company_id = $1'), code.lastIndexOf('ORDER BY'));
        expect(where).toContain('tl.is_action_required = true');
    });

    it('missing restricted actor and missing task scope both deny every AR task', async () => {
        for (const options of [
            { taskContentScope: { canViewAll: false, userId: null } },
            {},
        ]) {
            const [sql] = await sqlFor(options);
            const aggregate = sql.slice(sql.indexOf('FROM tasks ot'), sql.indexOf(') open_tasks ON true'));
            expect(aggregate).toContain('AND FALSE');
        }
    });
});
