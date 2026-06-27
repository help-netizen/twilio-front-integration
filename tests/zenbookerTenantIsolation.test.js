/**
 * ZB-ISO-001 — Zenbooker cross-tenant isolation.
 *
 * The shared env ZENBOOKER_API_KEY belongs to ONE company (the default). A tenant
 * without its own zenbooker_api_key must NOT fall back to that account, or it would
 * see the default company's team/jobs/services (cross-tenant leak). Regression test
 * for the schedule technician quick-filter leak.
 */
process.env.ZENBOOKER_API_KEY = process.env.ZENBOOKER_API_KEY || 'test-default-key';
process.env.ZENBOOKER_DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
const db = require('../backend/src/db/connection');
const zb = require('../backend/src/services/zenbookerClient');

const DEFAULT_CO = '00000000-0000-0000-0000-000000000001';
const OTHER_CO = '11111111-1111-1111-1111-111111111111';
const KEYED_CO = '22222222-2222-2222-2222-222222222222';

beforeEach(() => db.query.mockReset());

describe('Zenbooker tenant isolation (ZB-ISO-001)', () => {
    it('returns NULL for a tenant without its own key (no global fallback)', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ zenbooker_api_key: null }] });
        await expect(zb.getClientForCompany(OTHER_CO)).resolves.toBeNull();
    });

    it('uses the env/default account ONLY for the default company', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ zenbooker_api_key: null }] });
        await expect(zb.getClientForCompany(DEFAULT_CO)).resolves.not.toBeNull();
    });

    it('uses a per-tenant client when the company has its own key', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ zenbooker_api_key: 'tenant-key' }] });
        await expect(zb.getClientForCompany(KEYED_CO)).resolves.not.toBeNull();
    });

    it('getTeamMembers returns [] for a tenant without Zenbooker (no roster leak)', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ zenbooker_api_key: null }] });
        const members = await zb.getTeamMembers({ service_provider: true }, OTHER_CO);
        expect(members).toEqual([]);
        // The DB was consulted; the Zenbooker API was never called for this tenant.
        expect(db.query).toHaveBeenCalledTimes(1);
    });
});
