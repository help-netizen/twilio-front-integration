/**
 * PF007-HARDENING-001 Phase 1 — provider bridge + internal assignee mirror.
 *
 * Covers:
 *  - membershipQueries.resolveProviderUserIds is company-scoped and
 *    ignores unmapped external ids
 *  - jobsService.resolveAssignedProviderUserIds returns '[]' without a
 *    company and resolves through the bridge otherwise
 *  - jobSyncService.refreshAssigneeMirrorFromAssignment updates the mirror
 *    from assignment events using the job's own company
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({}));

const db = require('../backend/src/db/connection');
const membershipQueries = require('../backend/src/db/membershipQueries');
const jobsService = require('../backend/src/services/jobsService');
const jobSyncService = require('../backend/src/services/jobSyncService');

beforeEach(() => {
    db.query.mockReset();
});

describe('membershipQueries.resolveProviderUserIds', () => {
    it('returns [] without companyId — no cross-tenant resolution path', async () => {
        const out = await membershipQueries.resolveProviderUserIds(null, ['zb-1']);
        expect(out).toEqual([]);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('returns [] for empty external id list', async () => {
        const out = await membershipQueries.resolveProviderUserIds('company-1', []);
        expect(out).toEqual([]);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('queries with company scope and active membership filter', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ user_id: 'uuid-b' }, { user_id: 'uuid-a' }] });
        const out = await membershipQueries.resolveProviderUserIds('company-1', ['zb-1', 'zb-2']);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('m.company_id = $1');
        expect(sql).toContain("m.status = 'active'");
        expect(params).toEqual(['company-1', ['zb-1', 'zb-2']]);
        expect(out).toEqual(['uuid-a', 'uuid-b']); // sorted unique
    });
});

describe('jobsService.resolveAssignedProviderUserIds', () => {
    it('returns "[]" without a company', async () => {
        const out = await jobsService.resolveAssignedProviderUserIds(null, [{ id: 'zb-1' }]);
        expect(out).toBe('[]');
        expect(db.query).not.toHaveBeenCalled();
    });

    it('returns "[]" for empty/invalid techs', async () => {
        expect(await jobsService.resolveAssignedProviderUserIds('c1', [])).toBe('[]');
        expect(await jobsService.resolveAssignedProviderUserIds('c1', 'not-json')).toBe('[]');
        expect(db.query).not.toHaveBeenCalled();
    });

    it('resolves techs (array or JSON string) through the bridge', async () => {
        db.query.mockResolvedValue({ rows: [{ user_id: 'uuid-1' }] });

        const fromArray = await jobsService.resolveAssignedProviderUserIds('c1', [{ id: 'zb-1', name: 'Tech' }]);
        expect(fromArray).toBe(JSON.stringify(['uuid-1']));

        const fromString = await jobsService.resolveAssignedProviderUserIds('c1', '[{"id":"zb-1"}]');
        expect(fromString).toBe(JSON.stringify(['uuid-1']));
    });

    it('unmapped external ids resolve to nobody', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const out = await jobsService.resolveAssignedProviderUserIds('c1', [{ id: 'unknown-zb' }]);
        expect(out).toBe('[]');
    });
});

describe('jobSyncService.refreshAssigneeMirrorFromAssignment', () => {
    it('skips when the event payload has no assigned_providers array', async () => {
        const res = await jobSyncService.refreshAssigneeMirrorFromAssignment('zb-job-1', {});
        expect(res).toEqual({ updated: false, reason: 'no_assignment_payload' });
        expect(db.query).not.toHaveBeenCalled();
    });

    it('skips when the job is unknown locally', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const res = await jobSyncService.refreshAssigneeMirrorFromAssignment('zb-job-1', { assigned_providers: [] });
        expect(res).toEqual({ updated: false, reason: 'job_not_found' });
    });

    it('updates assigned_techs + mirror scoped to the job own company', async () => {
        db.query
            // job lookup
            .mockResolvedValueOnce({ rows: [{ id: 42, company_id: 'company-1' }] })
            // bridge resolution (inside resolveAssignedProviderUserIds)
            .mockResolvedValueOnce({ rows: [{ user_id: 'uuid-1' }] })
            // update
            .mockResolvedValueOnce({ rowCount: 1 });

        const res = await jobSyncService.refreshAssigneeMirrorFromAssignment('zb-job-1', {
            assigned_providers: [{ id: 'zb-1', name: 'Tech' }],
        });

        expect(res).toEqual({ updated: true, job_id: 42 });
        const bridgeCall = db.query.mock.calls[1];
        expect(bridgeCall[1]).toEqual(['company-1', ['zb-1']]);
        const updateCall = db.query.mock.calls[2];
        expect(updateCall[0]).toContain('assigned_provider_user_ids = $2::jsonb');
        expect(updateCall[1]).toEqual([
            JSON.stringify([{ id: 'zb-1', name: 'Tech' }]),
            JSON.stringify(['uuid-1']),
            42,
        ]);
    });
});
