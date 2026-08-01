/**
 * ROLE-PULSE-SCOPE-001 — a provider's Pulse is scoped to contacts with an ACTIVE job.
 * "Active" is defined by EXCLUSION (owner's decision): inactive == Canceled or Job is
 * Done; every other status — and a new/unknown status — is active. Mock-level guards on
 * the shared inactive-status set + the SQL predicate so the four Pulse scope sites can't
 * silently drop the `blanc_status` filter (which would re-widen a provider's Pulse to
 * every job they ever touched) or accidentally flip back to an allow-list.
 */
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));

const db = require('../backend/src/db/connection');
const { PULSE_INACTIVE_JOB_STATUSES } = require('../backend/src/middleware/providerScope');
const { isConversationVisibleToProvider } = require('../backend/src/db/conversationsQueries');

beforeEach(() => db.query.mockReset());

describe('ROLE-PULSE-SCOPE-001 active-job Pulse scope', () => {
    it('freezes the owner-approved INACTIVE status set (deny-list)', () => {
        expect(PULSE_INACTIVE_JOB_STATUSES).toEqual(['Canceled', 'Job is Done']);
    });

    it('scopes provider conversation visibility by excluding inactive-job statuses', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const visible = await isConversationVisibleToProvider(5, 'company-1', 'user-1');
        expect(visible).toBe(false);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/pj\.assigned_provider_user_ids @> \$3::jsonb/);
        // NULL-safe deny-list: active == not one of the inactive statuses (NULL counts as active).
        expect(sql).toContain("pj.blanc_status IS NULL OR pj.blanc_status <> ALL(ARRAY['Canceled', 'Job is Done']::text[])");
        // Must NOT be an allow-list (= ANY(...)) — that would hide statuses the owner calls active.
        expect(sql).not.toMatch(/pj\.blanc_status = ANY/);
        expect(params).toEqual([5, 'company-1', JSON.stringify(['user-1'])]);
    });

    it('denies without a resolved user (deny-by-default) — no query at all', async () => {
        const visible = await isConversationVisibleToProvider(5, 'company-1', null);
        expect(visible).toBe(false);
        expect(db.query).not.toHaveBeenCalled();
    });
});
