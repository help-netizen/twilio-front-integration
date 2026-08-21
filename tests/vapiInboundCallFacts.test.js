/**
 * OB-71 — build the lead from what the server established, not from what the
 * model chose to restate.
 *
 * Evidence this exists for: on 2026-08-19 and again on 2026-08-20 WITH
 * `strict: true` set on the tool, createLead arrived as `{}` — twice in one call —
 * while the same conversation had already handed us the town at 29s, the address
 * at 66s and the appliance at 95s. The tool schema's `required` array is enforced
 * by nobody on this path, so the contract has to hold on our side.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const svc = require('../backend/src/services/vapiInboundCallFactsService');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const CALL = '01a01c54-8729-700f-add5-8ca328088c29';

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [{ facts: {} }] });
});

describe('what counts as a fact', () => {
    test('a validated address is evidence — the args the tool accepted, plus what it returned', () => {
        expect(svc.factsFromTool('validateAddress',
            { street: '612 Cirrus', apt: '6211', city: 'Ashland', state: 'MA', zip: '01720' },
            { valid: true, standardized: 'Cirrus Dr, Ashland, MA 01721', correctedZip: '01721', lat: 42.25, lng: -71.48 },
        )).toEqual({
            street: '612 Cirrus', apt: '6211', city: 'Ashland', state: 'MA',
            zip: '01721', lat: 42.25, lng: -71.48,
            standardizedAddress: 'Cirrus Dr, Ashland, MA 01721',
        });
    });

    test('an address the tool REFUSED is not evidence', () => {
        expect(svc.factsFromTool('validateAddress',
            { street: 'nowhere', city: 'Ashland' }, { valid: false })).toEqual({});
    });

    test('the service area contributes the town it resolved', () => {
        expect(svc.factsFromTool('checkServiceArea', { zip: '01721' },
            { inServiceArea: true, city: 'Ashland', state: 'MA', zip: '01721' },
        )).toEqual({ city: 'Ashland', state: 'MA', zip: '01721' });
    });

    test('the appliance the model already told the slot engine is reused, not re-asked', () => {
        expect(svc.factsFromTool('recommendSlots', { zip: '01721', unitType: 'Refrigerator' }, {}))
            .toEqual({ zip: '01721', unitType: 'Refrigerator' });
    });

    test('identity is never a fact — the verification gate owns it', () => {
        const facts = svc.factsFromTool('identifyCaller', {},
            { matchType: 'existing', contactId: 4468, customerName: 'Aigul Test', verificationLevel: 'L1' });
        expect(facts).toEqual({});
        expect(svc.FACT_KEYS).not.toContain('firstName');
        expect(svc.FACT_KEYS).not.toContain('contactId');
    });

    test('blank and non-finite values are dropped so they cannot erase a good one', () => {
        expect(svc.factsFromTool('validateAddress',
            { street: '   ', city: 'Ashland' },
            { valid: true, lat: Number.NaN, lng: null },
        )).toEqual({ city: 'Ashland' });
    });
});

describe('filling the gaps', () => {
    const facts = { street: '612 Cirrus', city: 'Ashland', state: 'MA', zip: '01721', unitType: 'Refrigerator', lat: 42.25, lng: -71.48 };

    test('the empty call that started all this comes out complete', () => {
        const { merged, filled } = svc.fillGaps({}, facts);
        expect(merged).toMatchObject({ street: '612 Cirrus', city: 'Ashland', zip: '01721', unitType: 'Refrigerator' });
        expect(filled).toEqual(expect.arrayContaining(['street', 'city', 'state', 'zip', 'unitType']));
    });

    test('a caller who corrects themselves is never overruled', () => {
        const { merged, filled } = svc.fillGaps({ street: '9 Elm St', zip: '02467' }, facts);
        expect(merged.street).toBe('9 Elm St');
        expect(merged.zip).toBe('02467');
        expect(filled).not.toContain('street');
        expect(filled).not.toContain('zip');
    });

    test('a blank argument counts as missing, not as an answer', () => {
        const { merged, filled } = svc.fillGaps({ city: '   ' }, facts);
        expect(merged.city).toBe('Ashland');
        expect(filled).toContain('city');
    });

    test('nothing known → nothing invented', () => {
        const { merged, filled } = svc.fillGaps({ firstName: 'Ryan' }, {});
        expect(merged).toEqual({ firstName: 'Ryan' });
        expect(filled).toEqual([]);
    });

    test('the standardized address is kept for evidence but never written as a field', () => {
        const { merged } = svc.fillGaps({}, { ...facts, standardizedAddress: 'Cirrus Dr, Ashland, MA 01721' });
        expect(merged.standardizedAddress).toBeUndefined();
    });
});

describe('persistence', () => {
    test('a later tool adds to the picture and can correct it, per key', async () => {
        await svc.recordFromTool({
            companyId: COMPANY, providerCallId: CALL, tool: 'recommendSlots',
            arguments: { unitType: 'Refrigerator' }, result: {},
        });
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('vapi_inbound_call_facts.facts || EXCLUDED.facts');
        expect(params[0]).toBe(CALL);
        expect(params[1]).toBe(COMPANY);
        expect(JSON.parse(params[2])).toEqual({ unitType: 'Refrigerator' });
    });

    test('the upsert cannot cross a company boundary', async () => {
        await svc.recordFromTool({
            companyId: COMPANY, providerCallId: CALL, tool: 'checkServiceArea',
            arguments: {}, result: { city: 'Ashland' },
        });
        expect(db.query.mock.calls[0][0]).toContain('vapi_inbound_call_facts.company_id = EXCLUDED.company_id');
    });

    test('a tool that establishes nothing writes nothing', async () => {
        const out = await svc.recordFromTool({
            companyId: COMPANY, providerCallId: CALL, tool: 'getCustomerOverview',
            arguments: {}, result: { openJobsCount: 0 },
        });
        expect(out).toEqual({ recorded: false, facts: {} });
        expect(db.query).not.toHaveBeenCalled();
    });

    test.each([
        ['no company', { providerCallId: CALL }],
        ['no provider call', { companyId: COMPANY }],
    ])('%s → no write', async (_l, input) => {
        await svc.recordFromTool({ ...input, tool: 'checkServiceArea', arguments: {}, result: { city: 'Ashland' } });
        expect(db.query).not.toHaveBeenCalled();
    });

    test('resolve is company-scoped and tolerates a call with no row', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        expect(await svc.resolve({ companyId: COMPANY, providerCallId: CALL })).toEqual({});
        expect(db.query.mock.calls[0][1]).toEqual([CALL, COMPANY]);
    });
});
