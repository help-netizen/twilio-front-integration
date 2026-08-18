'use strict';

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';
const CRM_USER = '10000000-0000-4000-8000-000000000001';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/contactDedupeService', () => ({}));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    MAX_FILE_SIZE: 1024,
    MAX_FILES_PER_NOTE: 5,
}));
jest.mock('../backend/src/services/notesMutationService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => null) }));

const db = require('../backend/src/db/connection');
const contactsService = require('../backend/src/services/contactsService');
const chatgptMcpQueries = require('../backend/src/db/chatgptMcpQueries');
const agentSkillsMcpRegistry = require('../backend/src/services/agentSkillsMcpRegistry');
const contactsRouter = require('../backend/src/routes/contacts');

function contactRow(overrides = {}) {
    return {
        id: 701,
        public_code: 'aB3xZ',
        company_id: COMPANY_A,
        full_name: 'Ada Lovelace',
        first_name: 'Ada',
        last_name: 'Lovelace',
        phone_e164: '+16175550101',
        email: 'ada@example.test',
        zenbooker_data: {},
        created_at: new Date('2026-08-17T12:00:00.000Z'),
        updated_at: new Date('2026-08-17T12:00:00.000Z'),
        ...overrides,
    };
}

async function invokeGet(routePath, params, {
    permissions = ['contacts.view'],
    companyId = COMPANY_A,
} = {}) {
    const layer = contactsRouter.stack.find(candidate => (
        candidate.route?.path === routePath && candidate.route.methods.get
    ));
    if (!layer) throw new Error(`Route ${routePath} not found`);

    const req = {
        method: 'GET',
        originalUrl: routePath,
        params,
        user: { sub: 'kc-user', crmUser: { id: CRM_USER } },
        authz: {
            permissions,
            scopes: { job_visibility: 'all' },
        },
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

afterEach(() => {
    jest.restoreAllMocks();
});

describe('CONTACT-NUMBERING-001 service and DTO contract', () => {
    test('getContactByCode(publicCode, { client }) is the deliberate global lookup', async () => {
        const client = { query: jest.fn(async () => ({ rows: [contactRow()] })) };

        const contact = await contactsService.getContactByCode('aB3xZ', { client });

        const [sql, params] = client.query.mock.calls[0];
        expect(sql).toContain('WHERE c.public_code = $1');
        expect(sql).not.toMatch(/WHERE\s+c\.company_id/);
        expect(params).toEqual(['aB3xZ']);
        expect(contact).toMatchObject({
            id: 701,
            public_code: 'aB3xZ',
            company_id: COMPANY_A,
        });
    });

    test('getContactByCode returns a typed 404 when the global code is absent', async () => {
        const client = { query: jest.fn(async () => ({ rows: [] })) };

        await expect(contactsService.getContactByCode('xxxxx', { client })).rejects.toMatchObject({
            code: 'NOT_FOUND',
            httpStatus: 404,
        });
    });

    test('company-scoped detail and list DTOs project public_code while keeping id', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [contactRow()] })
            .mockResolvedValueOnce({ rows: [{ total: 1 }] })
            .mockResolvedValueOnce({ rows: [{ ...contactRow(), __cursor_id: '701' }] });

        const detail = await contactsService.getContactById(701, COMPANY_A);
        const page = await contactsService.listContacts({
            companyId: COMPANY_A,
            offset: 0,
            limit: 50,
        });

        expect(db.query.mock.calls[0][0]).toContain('c.public_code');
        expect(db.query.mock.calls[0][0]).toContain('c.company_id = $2');
        expect(detail).toMatchObject({ id: 701, public_code: 'aB3xZ' });
        expect(db.query.mock.calls[2][0]).toContain('c.public_code');
        expect(page.results[0]).toMatchObject({ id: 701, public_code: 'aB3xZ' });
    });

    test('MCP Contact projections and output schemas keep id and add public_code', async () => {
        db.query.mockResolvedValueOnce({ rows: [contactRow({ emails: [], addresses: [] })] });

        const contact = await chatgptMcpQueries.getContact(COMPANY_A, 701);
        expect(db.query.mock.calls[0][0]).toContain('c.public_code');
        expect(contact).toMatchObject({ id: 701, public_code: 'aB3xZ' });

        const searchSchema = agentSkillsMcpRegistry.getTool('svc.search_contacts')
            .outputSchema.properties.results.items.properties;
        const detailSchema = agentSkillsMcpRegistry.getTool('svc.get_contact')
            .outputSchema.properties;
        const historySchema = agentSkillsMcpRegistry.getTool('svc.get_contact_history')
            .outputSchema.properties.contact.properties;
        for (const schema of [searchSchema, detailSchema, historySchema]) {
            expect(schema.id).toBeDefined();
            expect(schema.public_code.description)
                .toBe('Durable global contact code for /contacts/:code links.');
        }
    });
});

describe('GET /api/contacts/by-code/:code', () => {
    test('returns the company-scoped hydrated Contact in the direct data envelope', async () => {
        const resolved = contactRow();
        const hydrated = { ...resolved, addresses: [{ id: 'addr-1' }] };
        const resolver = jest.spyOn(contactsService, 'getContactByCode').mockResolvedValueOnce(resolved);
        const scopedLookup = jest.spyOn(contactsService, 'getContactById').mockResolvedValueOnce(hydrated);

        const response = await invokeGet('/by-code/:code', { code: 'aB3xZ' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true, data: hydrated });
        expect(resolver).toHaveBeenCalledWith('aB3xZ');
        expect(scopedLookup).toHaveBeenCalledWith(
            701,
            COMPANY_A,
            { assignedOnly: false, userId: null }
        );
    });

    test('returns 404 without company-scoped hydration for a foreign Contact', async () => {
        const resolver = jest.spyOn(contactsService, 'getContactByCode')
            .mockResolvedValueOnce(contactRow({ company_id: COMPANY_B }));
        const scopedLookup = jest.spyOn(contactsService, 'getContactById');

        const response = await invokeGet('/by-code/:code', { code: 'aB3xZ' });

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('NOT_FOUND');
        expect(response.body.data).toBeUndefined();
        expect(resolver).toHaveBeenCalledTimes(1);
        expect(scopedLookup).not.toHaveBeenCalled();
    });

    test('fails closed without company context before the global lookup', async () => {
        const resolver = jest.spyOn(contactsService, 'getContactByCode');

        const response = await invokeGet(
            '/by-code/:code',
            { code: 'aB3xZ' },
            { companyId: null }
        );

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('TENANT_CONTEXT_REQUIRED');
        expect(resolver).not.toHaveBeenCalled();
    });

    test('requires contacts.view', async () => {
        const resolver = jest.spyOn(contactsService, 'getContactByCode');

        const response = await invokeGet(
            '/by-code/:code',
            { code: 'aB3xZ' },
            { permissions: [] }
        );

        expect(response.status).toBe(403);
        expect(response.body.code).toBe('ACCESS_DENIED');
        expect(resolver).not.toHaveBeenCalled();
    });

    test('the literal by-code route is registered before every parameter route', () => {
        const paths = contactsRouter.stack
            .filter(candidate => candidate.route)
            .map(candidate => candidate.route.path);
        const byCodeIndex = paths.indexOf('/by-code/:code');
        const firstParameterIndex = paths.findIndex(path => path.startsWith('/:'));

        expect(byCodeIndex).toBeGreaterThanOrEqual(0);
        expect(firstParameterIndex).toBeGreaterThan(byCodeIndex);
    });
});
