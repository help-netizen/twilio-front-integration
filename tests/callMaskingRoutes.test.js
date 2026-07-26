'use strict';

const mockGetSettings = jest.fn();
const mockSaveSettings = jest.fn();
const mockGetMaskedDialForContact = jest.fn();
const mockGetMaskedDialForJob = jest.fn();

jest.mock('../backend/src/services/callMaskingService', () => ({
    getSettings: (...args) => mockGetSettings(...args),
    saveSettings: (...args) => mockSaveSettings(...args),
    getMaskedDialForContact: (...args) => mockGetMaskedDialForContact(...args),
    getMaskedDialForJob: (...args) => mockGetMaskedDialForJob(...args),
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn(() => Promise.resolve()),
}));

const telephonyNumbersRouter = require('../backend/src/routes/telephonyNumbers');
const contactsRouter = require('../backend/src/routes/contacts');
const jobsRouter = require('../backend/src/routes/jobs');

const COMPANY_A = '11111111-1111-1111-1111-111111111111';
const COMPANY_B = '22222222-2222-2222-2222-222222222222';
const ACTOR = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function routeRequest(permissions, scopes = { job_visibility: 'all' }) {
    return {
        method: 'GET',
        originalUrl: '/',
        params: {},
        body: {},
        companyFilter: { company_id: COMPANY_A },
        user: { crmUser: { id: ACTOR }, email: 'actor@example.test' },
        authz: {
            permissions,
            scopes,
            company: { id: COMPANY_A },
            membership: { role_key: 'provider' },
        },
    };
}

async function invokeRoute(router, path, method, req) {
    const layer = router.stack.find(item => (
        item.route?.path === path
        && item.route.methods?.[method.toLowerCase()]
    ));
    if (!layer) throw new Error(`Route ${method} ${path} not found`);

    const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        send(body) { this.body = body; return this; },
    };

    async function dispatch(index) {
        if (index >= layer.route.stack.length) return;
        const handler = layer.route.stack[index].handle;
        await new Promise((resolve, reject) => {
            let advanced = false;
            const next = (err) => {
                advanced = true;
                if (err) return reject(err);
                dispatch(index + 1).then(resolve, reject);
            };
            Promise.resolve(handler(req, res, next)).then(() => {
                if (!advanced) resolve();
            }, reject);
        });
    }

    await dispatch(0);
    return res;
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('call masking settings routes', () => {
    test('GET returns company-scoped settings', async () => {
        mockGetSettings.mockResolvedValue({
            call_masking_enabled: false,
            call_masking_number: '+16174044425',
        });
        const res = await invokeRoute(
            telephonyNumbersRouter,
            '/masking-settings',
            'GET',
            routeRequest(['tenant.telephony.manage'])
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.data.call_masking_number).toBe('+16174044425');
        expect(mockGetSettings).toHaveBeenCalledWith(COMPANY_A);
    });

    test('PUT ignores a body company_id and records the crm user actor', async () => {
        const saved = {
            call_masking_enabled: true,
            call_masking_number: '+16174044425',
        };
        mockSaveSettings.mockResolvedValue(saved);
        const req = routeRequest(['tenant.telephony.manage']);
        req.method = 'PUT';
        req.body = { ...saved, company_id: COMPANY_B };
        const res = await invokeRoute(
            telephonyNumbersRouter,
            '/masking-settings',
            'PUT',
            req
        );
        expect(res.statusCode).toBe(200);
        expect(mockSaveSettings).toHaveBeenCalledWith(
            COMPANY_A,
            expect.objectContaining({ company_id: COMPANY_B }),
            ACTOR
        );
    });

    test('R-matrix deny: missing tenant.telephony.manage returns 403 before service access', async () => {
        const res = await invokeRoute(
            telephonyNumbersRouter,
            '/masking-settings',
            'GET',
            routeRequest([])
        );
        expect(res.statusCode).toBe(403);
        expect(mockGetSettings).not.toHaveBeenCalled();
    });
});

describe('contact masking resolver route', () => {
    test('T-own passes company and provider scope to the resolver', async () => {
        mockGetMaskedDialForContact.mockResolvedValue({
            enabled: true,
            masking_number: '+16174044425',
            code: '000001',
            display_number: '+16174044425',
            tel_uri: 'tel:+16174044425,,000001',
        });
        const req = routeRequest(
            ['call_masking.use'],
            { job_visibility: 'assigned_only' }
        );
        req.params = { id: '42' };
        req.originalUrl = '/42/call-masking';
        const res = await invokeRoute(
            contactsRouter,
            '/:id/call-masking',
            'GET',
            req
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.data.code).toBe('000001');
        expect(mockGetMaskedDialForContact).toHaveBeenCalledWith(
            COMPANY_A,
            '42',
            { assignedOnly: true, userId: ACTOR }
        );
    });

    test('T-foreign is indistinguishable from missing and returns 404', async () => {
        mockGetMaskedDialForContact.mockResolvedValue(null);
        const req = routeRequest(['call_masking.use']);
        req.params = { id: '99' };
        const res = await invokeRoute(
            contactsRouter,
            '/:id/call-masking',
            'GET',
            req
        );
        expect(res.statusCode).toBe(404);
    });

    test('R-matrix deny: missing call_masking.use returns 403 before resolver access', async () => {
        const req = routeRequest([]);
        req.params = { id: '42' };
        const res = await invokeRoute(
            contactsRouter,
            '/:id/call-masking',
            'GET',
            req
        );
        expect(res.statusCode).toBe(403);
        expect(mockGetMaskedDialForContact).not.toHaveBeenCalled();
    });
});

describe('job masking resolver route', () => {
    test('T-own passes company and provider scope to the resolver', async () => {
        mockGetMaskedDialForJob.mockResolvedValue({
            enabled: true,
            masking_number: '+16174044425',
            code: '000001',
            display_number: '+16174044425',
            tel_uri: 'tel:+16174044425,,000001',
        });
        const req = routeRequest(
            ['call_masking.use'],
            { job_visibility: 'assigned_only' }
        );
        req.params = { id: '77' };
        const res = await invokeRoute(
            jobsRouter,
            '/:id/call-masking',
            'GET',
            req
        );
        expect(res.statusCode).toBe(200);
        expect(mockGetMaskedDialForJob).toHaveBeenCalledWith(
            COMPANY_A,
            '77',
            { assignedOnly: true, userId: ACTOR }
        );
    });

    test('T-foreign is indistinguishable from missing and returns 404', async () => {
        mockGetMaskedDialForJob.mockResolvedValue(null);
        const req = routeRequest(['call_masking.use']);
        req.params = { id: '99' };
        const res = await invokeRoute(
            jobsRouter,
            '/:id/call-masking',
            'GET',
            req
        );
        expect(res.statusCode).toBe(404);
    });

    test('R-matrix deny: missing call_masking.use returns 403 before resolver access', async () => {
        const req = routeRequest([]);
        req.params = { id: '77' };
        const res = await invokeRoute(
            jobsRouter,
            '/:id/call-masking',
            'GET',
            req
        );
        expect(res.statusCode).toBe(403);
        expect(mockGetMaskedDialForJob).not.toHaveBeenCalled();
    });
});
