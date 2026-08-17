'use strict';

const mockQuery = jest.fn();
const mockGetClient = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    query: mockQuery,
    getClient: mockGetClient,
    pool: { connect: jest.fn() },
}));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/eventBus', () => ({ emit: jest.fn(async () => null) }));
jest.mock('../backend/src/services/leadConversionService', () => ({ convertLeadWithJob: jest.fn() }));
jest.mock('../backend/src/services/realtimeService', () => ({ broadcast: jest.fn() }));
jest.mock('../backend/src/services/leadContactActivityService', () => ({
    logLeadContactActivity: jest.fn(async () => null),
    systemActor: jest.fn(() => ({ type: 'system', id: null })),
    userActor: id => ({ id, type: 'user', label: null, source: 'crm' }),
}));

jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    MAX_FILE_SIZE: 10 * 1024 * 1024,
    MAX_FILES_PER_NOTE: 5,
}));
jest.mock('../backend/src/services/unitLabelScanService', () => ({}));
jest.mock('../backend/src/services/notesMutationService', () => ({}));
jest.mock('../backend/src/services/contactDedupeService', () => ({}));
jest.mock('../backend/src/services/contactAddressService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({
    logEvent: jest.fn(),
    actorName: jest.fn(() => 'Tester'),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => null) }));

const leadsService = require('../backend/src/services/leadsService');
const eventBus = require('../backend/src/services/eventBus');
const leadsRouter = require('../backend/src/routes/leads');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';

function leadRow(overrides = {}) {
    return {
        id: 700,
        uuid: 'ABC123',
        serial_id: 4700,
        lead_seq: 31,
        public_code: 'aB3xZ',
        company_id: COMPANY_A,
        status: 'Submitted',
        sub_status: null,
        lead_lost: false,
        created_at: new Date('2026-08-16T12:00:00.000Z'),
        metadata: {},
        team: [],
        ...overrides,
    };
}

async function invokeGet(routePath, params, {
    permissions = ['leads.view'],
    companyId = COMPANY_A,
} = {}) {
    const layer = leadsRouter.stack.find(candidate => (
        candidate.route?.path === routePath && candidate.route.methods.get
    ));
    if (!layer) throw new Error(`Route ${routePath} not found`);

    const req = {
        method: 'GET',
        originalUrl: routePath,
        params,
        user: { sub: 'u1', crmUser: { id: 1 } },
        authz: { permissions },
    };
    if (companyId) req.companyFilter = { company_id: companyId };
    const res = {
        statusCode: 200,
        body: undefined,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };

    const handlers = layer.route.stack.map(candidate => candidate.handle);
    async function dispatch(index) {
        if (index >= handlers.length) return;
        let nextPromise = null;
        const next = (error) => {
            if (error) throw error;
            nextPromise = dispatch(index + 1);
            return nextPromise;
        };
        await handlers[index](req, res, next);
        if (nextPromise) await nextPromise;
    }
    await dispatch(0);
    return { status: res.statusCode, body: res.body };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('LEAD-NUMBERING-001 service resolvers', () => {
    test('getLeadBySeq is tenant-scoped and returns all four Lead identifiers', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [leadRow({
            metadata: { company_id: COMPANY_B, LeadSeq: 999, PublicCode: 'xxxxx' },
        })] });

        const lead = await leadsService.getLeadBySeq(31, COMPANY_A);

        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toContain('WHERE l.company_id = $1 AND l.lead_seq = $2');
        expect(sql).toContain('lta.company_id = l.company_id');
        expect(params).toEqual([COMPANY_A, 31]);
        expect(lead).toMatchObject({
            ClientId: 700,
            UUID: 'ABC123',
            SerialId: 4700,
            LeadSeq: 31,
            PublicCode: 'aB3xZ',
            company_id: COMPANY_A,
        });
    });

    test('getLeadBySeq returns a 404 rather than another tenant row', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        await expect(leadsService.getLeadBySeq(31, COMPANY_B)).rejects.toMatchObject({
            code: 'LEAD_NOT_FOUND',
            httpStatus: 404,
        });
        expect(mockQuery.mock.calls[0][1]).toEqual([COMPANY_B, 31]);
    });

    test('getLeadBySeq fails closed without company context before SQL', async () => {
        await expect(leadsService.getLeadBySeq(31, null)).rejects.toMatchObject({
            code: 'TENANT_CONTEXT_REQUIRED',
            httpStatus: 403,
        });
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('getLeadByCode is the deliberate global lookup', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [leadRow()] });

        const lead = await leadsService.getLeadByCode('aB3xZ');

        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toContain('WHERE l.public_code = $1');
        expect(sql).not.toContain('WHERE l.company_id');
        expect(params).toEqual(['aB3xZ']);
        expect(lead).toMatchObject({
            ClientId: 700,
            UUID: 'ABC123',
            LeadSeq: 31,
            PublicCode: 'aB3xZ',
            company_id: COMPANY_A,
        });
    });

    test('getLeadByCode returns a 404 when the global code is absent', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        await expect(leadsService.getLeadByCode('xxxxx')).rejects.toMatchObject({
            code: 'LEAD_NOT_FOUND',
            httpStatus: 404,
        });
    });

    test('list search matches LeadSeq and legacy SerialId and projects both new identifiers', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ total: 0 }] })
            .mockResolvedValueOnce({ rows: [] });

        await leadsService.listLeads({
            companyId: COMPANY_A,
            search: '31',
            only_open: false,
            sort_by: 'LeadSeq',
            sort_order: 'asc',
        });

        const countSql = mockQuery.mock.calls[0][0];
        const listSql = mockQuery.mock.calls[1][0];
        for (const sql of [countSql, listSql]) {
            expect(sql).toContain('l.lead_seq::text ILIKE');
            expect(sql).toContain('l.serial_id::text ILIKE');
        }
        expect(listSql).toContain('l.lead_seq AS lead_seq');
        expect(listSql).toContain('l.public_code AS public_code');
        expect(listSql).toContain('ORDER BY l.lead_seq ASC');
    });

    test('createLead returns trigger-populated LeadSeq and PublicCode without dropping SerialId', async () => {
        const txQuery = jest.fn(async sql => {
            if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
            if (/SELECT 1 FROM leads WHERE uuid/.test(sql)) return { rows: [] };
            if (/SELECT api_name FROM lead_custom_fields/.test(sql)) return { rows: [] };
            if (/INSERT INTO leads/.test(sql)) return { rows: [leadRow()] };
            throw new Error(`Unexpected SQL: ${sql}`);
        });
        const release = jest.fn();
        mockGetClient.mockResolvedValueOnce({ query: txQuery, release });

        const lead = await leadsService.createLead({ FirstName: 'Jane' }, COMPANY_A);

        const insertSql = txQuery.mock.calls.find(([sql]) => /INSERT INTO leads/.test(sql))[0];
        expect(insertSql).toContain('RETURNING uuid, serial_id, id, lead_seq, public_code');
        expect(lead).toMatchObject({
            UUID: 'ABC123',
            SerialId: 4700,
            LeadSeq: 31,
            PublicCode: 'aB3xZ',
            ClientId: '700',
        });
        expect(eventBus.emit).toHaveBeenCalled();
        expect(release).toHaveBeenCalled();
    });

    test('updateLead returns LeadSeq and PublicCode from its inline DTO projection', async () => {
        const txQuery = jest.fn(async sql => {
            if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
            if (/SELECT api_name FROM lead_custom_fields/.test(sql)) return { rows: [] };
            if (/UPDATE leads SET/.test(sql)) return { rows: [leadRow()] };
            throw new Error(`Unexpected SQL: ${sql}`);
        });
        mockGetClient.mockResolvedValueOnce({ query: txQuery, release: jest.fn() });

        const lead = await leadsService.updateLead('ABC123', { FirstName: 'Janet' }, COMPANY_A);

        const updateSql = txQuery.mock.calls.find(([sql]) => /UPDATE leads SET/.test(sql))[0];
        expect(updateSql).toContain('RETURNING uuid, id, lead_seq, public_code');
        expect(lead).toMatchObject({
            UUID: 'ABC123',
            LeadSeq: 31,
            PublicCode: 'aB3xZ',
            ClientId: '700',
        });
    });
});

describe('GET Lead numbering resolution routes', () => {
    test('GET /by-seq/:seq returns { lead } and passes sequence before company', async () => {
        const resolver = jest.spyOn(leadsService, 'getLeadBySeq').mockResolvedValueOnce(leadRow());
        const response = await invokeGet('/by-seq/:seq', { seq: '31' });

        expect(response.status).toBe(200);
        expect(response.body.data.lead).toMatchObject({
            id: 700,
            uuid: 'ABC123',
            lead_seq: 31,
            public_code: 'aB3xZ',
        });
        expect(resolver).toHaveBeenCalledWith(31, COMPANY_A);
        resolver.mockRestore();
    });

    test('GET /by-code/:code returns an owned Lead DTO', async () => {
        const resolver = jest.spyOn(leadsService, 'getLeadByCode').mockResolvedValueOnce(leadRow());
        const response = await invokeGet('/by-code/:code', { code: 'aB3xZ' });

        expect(response.status).toBe(200);
        expect(response.body.data.lead).toMatchObject({
            id: 700,
            uuid: 'ABC123',
            lead_seq: 31,
            public_code: 'aB3xZ',
        });
        expect(resolver).toHaveBeenCalledWith('aB3xZ');
        resolver.mockRestore();
    });

    test('GET /by-code/:code returns 404 for a foreign-company Lead', async () => {
        const resolver = jest.spyOn(leadsService, 'getLeadByCode').mockResolvedValueOnce(leadRow());
        const response = await invokeGet(
            '/by-code/:code',
            { code: 'aB3xZ' },
            { companyId: COMPANY_B }
        );

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('LEAD_NOT_FOUND');
        expect(response.body.data).toBeUndefined();
        resolver.mockRestore();
    });

    test.each([
        ['/by-seq/:seq', { seq: '31' }, 'getLeadBySeq'],
        ['/by-code/:code', { code: 'aB3xZ' }, 'getLeadByCode'],
    ])('%s fails closed without company context', async (path, params, resolverName) => {
        const resolver = jest.spyOn(leadsService, resolverName);
        const response = await invokeGet(path, params, { companyId: null });

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('TENANT_CONTEXT_REQUIRED');
        expect(resolver).not.toHaveBeenCalled();
        resolver.mockRestore();
    });

    test.each(['0', '-1', '1.5', 'abc', '2147483648', '9007199254740992'])(
        'GET /by-seq/%s rejects invalid sequences before the service',
        async invalidSeq => {
            const resolver = jest.spyOn(leadsService, 'getLeadBySeq');
            const response = await invokeGet('/by-seq/:seq', { seq: invalidSeq });

            expect(response.status).toBe(400);
            expect(resolver).not.toHaveBeenCalled();
            resolver.mockRestore();
        }
    );

    test.each([
        ['/by-seq/:seq', { seq: '31' }, 'getLeadBySeq'],
        ['/by-code/:code', { code: 'aB3xZ' }, 'getLeadByCode'],
    ])('%s requires leads.view', async (path, params, resolverName) => {
        const resolver = jest.spyOn(leadsService, resolverName);
        const response = await invokeGet(path, params, { permissions: [] });

        expect(response.status).toBe(403);
        expect(resolver).not.toHaveBeenCalled();
        resolver.mockRestore();
    });

    test('literal numbering routes are not swallowed by /:uuid', async () => {
        const bySeq = jest.spyOn(leadsService, 'getLeadBySeq').mockResolvedValueOnce(leadRow());
        const byCode = jest.spyOn(leadsService, 'getLeadByCode').mockResolvedValueOnce(leadRow());
        const byUuid = jest.spyOn(leadsService, 'getLeadByUUID');

        await invokeGet('/by-seq/:seq', { seq: '31' });
        await invokeGet('/by-code/:code', { code: 'aB3xZ' });

        expect(bySeq).toHaveBeenCalledTimes(1);
        expect(byCode).toHaveBeenCalledTimes(1);
        expect(byUuid).not.toHaveBeenCalled();
        bySeq.mockRestore();
        byCode.mockRestore();
        byUuid.mockRestore();
    });
});
