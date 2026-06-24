/**
 * Regression guard: Zenbooker job creation must not fail when the lead/booking
 * address is missing `state`.
 *
 * Prod bug: converting a lead whose address had only city + ZIP (no state) hit
 * ZB 400 "Address object is missing required fields: state", so the job was
 * never created in Zenbooker (and the provider never synced back). We now
 * backfill the state from the ZIP before POST /jobs on every creation path.
 */

const { zipToState } = require('../backend/src/utils/zipState');

// ── zipToState ───────────────────────────────────────────────────────────────

describe('zipToState', () => {
    it('maps the failing prod ZIP (01721 Ashland) to MA', () => {
        expect(zipToState('01721')).toBe('MA');
    });

    it('maps representative ZIPs across states', () => {
        expect(zipToState('02110')).toBe('MA'); // Boston
        expect(zipToState('10001')).toBe('NY'); // NYC
        expect(zipToState('33101')).toBe('FL'); // Miami
        expect(zipToState('90001')).toBe('CA'); // LA
        expect(zipToState('60601')).toBe('IL'); // Chicago
        expect(zipToState('99501')).toBe('AK'); // Anchorage
        expect(zipToState('02906')).toBe('RI'); // Providence
        expect(zipToState('03301')).toBe('NH'); // Concord
    });

    it('handles ZIP+4 strings and numeric ZIPs (no leading zero)', () => {
        expect(zipToState('01721-1234')).toBe('MA');
        expect(zipToState(90210)).toBe('CA');
    });

    it('returns null for unmappable / malformed input', () => {
        expect(zipToState('')).toBeNull();
        expect(zipToState(null)).toBeNull();
        expect(zipToState('ab')).toBeNull();
        expect(zipToState('00400')).toBeNull(); // prefix 004 — below the first allocated range
    });
});

// ── ensureAddressState (pure helper) ─────────────────────────────────────────

describe('ensureAddressState', () => {
    const { ensureAddressState } = require('../backend/src/services/zenbookerClient');

    it('backfills a missing state from the ZIP', () => {
        const out = ensureAddressState({ address: { city: 'Ashland', postal_code: '01721', country: 'US' } });
        expect(out.address.state).toBe('MA');
    });

    it('never overrides a provided state', () => {
        const out = ensureAddressState({ address: { state: 'NH', postal_code: '01721' } });
        expect(out.address.state).toBe('NH');
    });

    it('is a no-op when there is no address or no postal_code', () => {
        const a = { territory_id: 't1' };
        expect(ensureAddressState(a)).toBe(a);
        const b = { address: { city: 'Ashland' } };
        expect(ensureAddressState(b)).toBe(b);
    });
});

// ── createJob / createJobFromLead enrichment (mocked axios) ──────────────────

describe('Zenbooker job creation backfills address.state before POST', () => {
    const originalApiKey = process.env.ZENBOOKER_API_KEY;

    afterEach(() => {
        jest.resetModules();
        jest.dontMock('axios');
        if (originalApiKey === undefined) delete process.env.ZENBOOKER_API_KEY;
        else process.env.ZENBOOKER_API_KEY = originalApiKey;
    });

    it('createJob fills state from the ZIP when the booking payload omits it', async () => {
        jest.resetModules();
        process.env.ZENBOOKER_API_KEY = 'test-key';
        const post = jest.fn().mockResolvedValue({ data: { job_id: 'zb-1' } });
        jest.doMock('axios', () => ({ create: () => ({ post }) }));
        const zb = require('../backend/src/services/zenbookerClient');

        await zb.createJob({
            territory_id: 't1',
            customer: { name: 'Day Off' },
            address: { line1: '6 Cirrus Drive', city: 'Ashland', postal_code: '01721', country: 'US' },
            assigned_providers: ['prov-1'],
        });

        const sent = post.mock.calls[0][1];
        expect(sent.address.state).toBe('MA');
    });

    it('createJobFromLead derives state from PostalCode when the lead has none', async () => {
        jest.resetModules();
        process.env.ZENBOOKER_API_KEY = 'test-key';
        const get = jest.fn().mockResolvedValue({
            data: { results: [{ id: 't1', enabled: true, service_area: { postal_codes: ['01721'] } }] },
        });
        const post = jest.fn().mockResolvedValue({ data: { job_id: 'zb-2' } });
        jest.doMock('axios', () => ({ create: () => ({ get, post }) }));
        const zb = require('../backend/src/services/zenbookerClient');

        await zb.createJobFromLead({
            FirstName: 'A', LastName: 'B',
            Address: '6 Cirrus Drive', City: 'Ashland', PostalCode: '01721',
        });

        const sent = post.mock.calls[0][1];
        expect(sent.address.state).toBe('MA');
    });
});
