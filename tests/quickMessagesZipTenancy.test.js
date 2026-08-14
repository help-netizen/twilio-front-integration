'use strict';

const mockGetQuickMessages = jest.fn();
const mockCreateQuickMessage = jest.fn();
const mockReorderQuickMessages = jest.fn();
const mockUpdateQuickMessage = jest.fn();
const mockDeleteQuickMessage = jest.fn();
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../backend/src/db/quickMessagesQueries', () => ({
    getQuickMessages: mockGetQuickMessages,
    createQuickMessage: mockCreateQuickMessage,
    reorderQuickMessages: mockReorderQuickMessages,
    updateQuickMessage: mockUpdateQuickMessage,
    deleteQuickMessage: mockDeleteQuickMessage,
}));

const mockIsZipInTerritory = jest.fn();
jest.mock('../backend/src/services/territoryService', () => ({
    isZipInTerritory: mockIsZipInTerritory,
}));

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';

function requestFor({ companyId = COMPANY_A, permissions = ['messages.send'], body = {}, query = {}, params = {} } = {}) {
    return {
        method: 'TEST',
        originalUrl: '/test',
        body,
        query,
        params,
        user: { crmUser: { id: 'user-a' } },
        authz: { permissions, membership: { role_key: 'dispatcher' } },
        ...(companyId ? { companyFilter: { company_id: companyId } } : {}),
    };
}

function routeHandlers(router, method, routePath) {
    const layer = router.stack.find(item => item.route?.path === routePath
        && item.route.methods[method.toLowerCase()]);
    if (!layer) throw new Error(`route not found: ${method} ${routePath}`);
    return layer.route.stack.map(item => item.handle);
}

async function invoke(handler, req) {
    const output = { status: 200, body: null, next: false };
    const res = {
        status(code) { output.status = code; return this; },
        json(body) { output.body = body; return this; },
    };
    await handler(req, res, () => { output.next = true; });
    return output;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetQuickMessages.mockResolvedValue([]);
    mockCreateQuickMessage.mockResolvedValue({ id: 'qm-1' });
    mockReorderQuickMessages.mockResolvedValue([]);
    mockUpdateQuickMessage.mockResolvedValue({ id: 'qm-1' });
    mockDeleteQuickMessage.mockResolvedValue({ id: 'qm-1' });
    mockIsZipInTerritory.mockResolvedValue({ inside: true, zip: '02101' });
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('Quick Messages explicit tenant context', () => {
    const quickRouter = require('../backend/src/routes/quick-messages');

    it.each([
        ['GET', '/', {}, {}],
        ['POST', '/', { title: 'Hi', content: 'Hello' }, {}],
        ['PUT', '/reorder', { orderedIds: ['00000000-0000-0000-0000-000000000099'] }, {}],
        ['PUT', '/:id', { title: 'Hi' }, { id: '00000000-0000-0000-0000-000000000099' }],
        ['DELETE', '/:id', {}, { id: '00000000-0000-0000-0000-000000000099' }],
    ])('%s %s returns typed 403 before query when company is absent', async (method, routePath, body, params) => {
        const handlers = routeHandlers(quickRouter, method, routePath);
        const res = await invoke(handlers.at(-1), requestFor({ companyId: null, body, params }));
        expect(res).toMatchObject({
            status: 403,
            body: { code: 'TENANT_CONTEXT_REQUIRED', message: 'Company context is required' },
        });
        expect(mockGetQuickMessages).not.toHaveBeenCalled();
        expect(mockCreateQuickMessage).not.toHaveBeenCalled();
        expect(mockReorderQuickMessages).not.toHaveBeenCalled();
        expect(mockUpdateQuickMessage).not.toHaveBeenCalled();
        expect(mockDeleteQuickMessage).not.toHaveBeenCalled();
    });

    it('T-own list passes only req.companyFilter.company_id', async () => {
        const res = await invoke(routeHandlers(quickRouter, 'GET', '/').at(-1), requestFor());
        expect(res.status).toBe(200);
        expect(mockGetQuickMessages).toHaveBeenCalledWith(COMPANY_A);
    });

    it('T-foreign id returns 404 and leaves the foreign row untouched', async () => {
        const foreignBefore = { id: 'foreign', company_id: 'company-b', title: 'B' };
        mockUpdateQuickMessage.mockResolvedValue(null);
        const res = await invoke(
            routeHandlers(quickRouter, 'PUT', '/:id').at(-1),
            requestFor({ body: { title: 'changed' }, params: { id: 'foreign' } })
        );
        expect(res.status).toBe(404);
        expect(mockUpdateQuickMessage).toHaveBeenCalledWith('foreign', COMPANY_A, { title: 'changed', content: undefined });
        expect(foreignBefore).toStrictEqual({ id: 'foreign', company_id: 'company-b', title: 'B' });
    });

    it('R-matrix deny: messages.send is required', async () => {
        const res = await invoke(
            routeHandlers(quickRouter, 'GET', '/')[0],
            requestFor({ permissions: [] })
        );
        expect(res.status).toBe(403);
        expect(mockGetQuickMessages).not.toHaveBeenCalled();
    });
});

describe('ZIP check explicit tenant context', () => {
    const zipRouter = require('../backend/src/routes/zip-check');

    it('returns typed 403 and does no lookup without a company', async () => {
        const res = await invoke(
            routeHandlers(zipRouter, 'GET', '/').at(-1),
            requestFor({ companyId: null, permissions: [], query: { q: '02101' } })
        );
        expect(res).toMatchObject({
            status: 403,
            body: { code: 'TENANT_CONTEXT_REQUIRED', message: 'Company context is required' },
        });
        expect(mockIsZipInTerritory).not.toHaveBeenCalled();
    });

    it('T-own is role-neutral but always passes the selected company', async () => {
        const res = await invoke(
            routeHandlers(zipRouter, 'GET', '/').at(-1),
            requestFor({ permissions: [], query: { q: '02101' } })
        );
        expect(res.status).toBe(200);
        expect(mockIsZipInTerritory).toHaveBeenCalledWith(COMPANY_A, '02101');
    });
});
