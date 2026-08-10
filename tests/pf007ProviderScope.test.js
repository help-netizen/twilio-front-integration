/**
 * PF007-HARDENING-001 Phase 1 — provider bridge + internal assignee mirror.
 *
 * Covers:
 *  - membershipQueries.resolveProviderUserIds is company-scoped and
 *    ignores unmapped external ids
 *  - jobsService.resolveAssignedProviderUserIds returns '[]' without a
 *    company and resolves through the bridge otherwise
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({}));

const db = require('../backend/src/db/connection');
const membershipQueries = require('../backend/src/db/membershipQueries');
const technicianDirectoryQueries = require('../backend/src/db/technicianDirectoryQueries');
const jobsService = require('../backend/src/services/jobsService');

const NATIVE_TECH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NATIVE_ONLY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CRM_USER = '11111111-1111-4111-8111-111111111111';

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
        expect(sql).toContain('t.crm_user_id = m.user_id');
        expect(sql).toContain('e.company_id = t.company_id');
        expect(params).toEqual(['company-1', ['zb-1', 'zb-2']]);
        expect(out).toEqual(['uuid-a', 'uuid-b']); // sorted unique
    });

    it('maps a native technician UUID to its CRM user authorization id', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ user_id: CRM_USER }] });

        const out = await membershipQueries.resolveProviderUserIds('company-1', [NATIVE_TECH]);

        expect(out).toEqual([CRM_USER]);
        expect(out).not.toContain(NATIVE_TECH);
        expect(db.query.mock.calls[0][1]).toEqual(['company-1', [NATIVE_TECH]]);
    });
});

describe('technicianDirectoryQueries.resolveCompatibilityIdsToExternal', () => {
    it('passes legacy ids through, resolves mapped UUIDs, and drops native-only UUIDs', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ technician_id: NATIVE_TECH, external_id: 'zb-mapped' }],
        });

        const out = await technicianDirectoryQueries.resolveCompatibilityIdsToExternal(
            'company-1',
            'zenbooker',
            [NATIVE_TECH, NATIVE_ONLY, 'zb-legacy']
        );

        expect(out).toEqual(['zb-mapped', 'zb-legacy']);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('company_id = $1');
        expect(sql).toContain('source = $2');
        expect(params).toEqual(['company-1', 'zenbooker', [NATIVE_TECH, NATIVE_ONLY]]);
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

    it('stores CRM user ids, never native technician UUIDs, in the job auth mirror', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ user_id: CRM_USER }] });

        const out = await jobsService.resolveAssignedProviderUserIds(
            'company-1',
            [{ id: NATIVE_TECH, name: 'Native technician' }]
        );

        expect(JSON.parse(out)).toEqual([CRM_USER]);
        expect(JSON.parse(out)).not.toContain(NATIVE_TECH);
    });
});

describe('jobsService.refreshCompanyProviderMirror', () => {
    it('refreshes only the CRM auth mirror and resolves native ids company-scoped', async () => {
        db.query.mockResolvedValueOnce({ rowCount: 0 });

        await jobsService.refreshCompanyProviderMirror('company-1');

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('SET assigned_provider_user_ids = sub.user_ids');
        expect(sql).not.toMatch(/SET\s+assigned_techs/);
        expect(sql).toContain('e.company_id = j2.company_id');
        expect(sql).toContain('native_m.user_id = t.crm_user_id');
        expect(params).toEqual(['company-1']);
    });
});
