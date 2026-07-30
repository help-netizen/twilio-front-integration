/**
 * ROLE-PULSE-SCOPE-001 — a provider's Pulse is scoped to contacts with an ACTIVE job.
 * Mock-level guards on the shared status set + the SQL predicate so the four Pulse
 * scope sites can't silently drop the `blanc_status` filter (which would re-widen a
 * provider's Pulse to every job they ever touched).
 */
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));

const db = require('../backend/src/db/connection');
const { PULSE_ACTIVE_JOB_STATUSES } = require('../backend/src/middleware/providerScope');
const { isConversationVisibleToProvider } = require('../backend/src/db/conversationsQueries');

beforeEach(() => db.query.mockReset());

describe('ROLE-PULSE-SCOPE-001 active-job Pulse scope', () => {
    it('freezes the owner-approved active status set', () => {
        expect(PULSE_ACTIVE_JOB_STATUSES).toEqual([
            'Submitted', 'Rescheduled', 'Waiting for parts', 'Visit completed',
        ]);
    });

    it('scopes provider conversation visibility to active-job statuses only', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const visible = await isConversationVisibleToProvider(5, 'company-1', 'user-1');
        expect(visible).toBe(false);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/pj\.assigned_provider_user_ids @> \$3::jsonb/);
        expect(sql).toMatch(/pj\.blanc_status = ANY\(\$4::text\[\]\)/);
        expect(params[3]).toEqual(PULSE_ACTIVE_JOB_STATUSES);
    });

    it('denies without a resolved user (deny-by-default) — no query at all', async () => {
        const visible = await isConversationVisibleToProvider(5, 'company-1', null);
        expect(visible).toBe(false);
        expect(db.query).not.toHaveBeenCalled();
    });
});
