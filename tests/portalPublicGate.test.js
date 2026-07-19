/**
 * PORTAL-PUBLIC-GATE-001 — the public portal token flow is fail-closed.
 *
 * POST /auth/request-access took company_id from the request body and returned
 * a raw portal token to the caller — a cross-tenant, proof-free way to mint a
 * client-portal session (documents, payments). The safe path is the
 * authenticated, company-scoped GET /links. Until the public flow is redesigned
 * to deliver the token over a verified channel, it is gated behind
 * PORTAL_PUBLIC_ENABLED (default off) and returns 404 so the surface is not even
 * advertised.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/portalService', () => ({
    requestAccess: jest.fn().mockResolvedValue({ rawToken: 'TOK', expiresAt: 'later' }),
    verifyToken: jest.fn().mockResolvedValue({ sessionId: 's', contactId: 'c', scope: 'full', expiresAt: 'later' }),
}));
jest.mock('../backend/src/middleware/keycloakAuth', () => ({
    authenticate: (req, res, next) => next(),
    requireCompanyAccess: (req, res, next) => next(),
}));
jest.mock('../backend/src/middleware/authorization', () => ({
    requirePermission: () => (req, res, next) => next(),
}));

const portalService = require('../backend/src/services/portalService');
const portalRouter = require('../backend/src/routes/portal');

function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/portal', portalRouter);
    return a;
}

const ORIGINAL = process.env.PORTAL_PUBLIC_ENABLED;
afterAll(() => { process.env.PORTAL_PUBLIC_ENABLED = ORIGINAL; });

describe('public portal flow is fail-closed by default', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.PORTAL_PUBLIC_ENABLED;
    });

    test('request-access returns 404 and never mints a token when the flag is off', async () => {
        const res = await request(app())
            .post('/api/portal/auth/request-access')
            .send({ company_id: 'co-B', contact_id: 'c-1' });
        expect(res.status).toBe(404);
        expect(portalService.requestAccess).not.toHaveBeenCalled();
    });

    test('verify returns 404 when the flag is off', async () => {
        const res = await request(app())
            .post('/api/portal/auth/verify')
            .send({ token: 'x' });
        expect(res.status).toBe(404);
        expect(portalService.verifyToken).not.toHaveBeenCalled();
    });

    test('when explicitly enabled, the handler runs (flag is the only gate)', async () => {
        process.env.PORTAL_PUBLIC_ENABLED = 'true';
        const res = await request(app())
            .post('/api/portal/auth/request-access')
            .send({ company_id: 'co-A', contact_id: 'c-1' });
        expect(res.status).toBe(200);
        expect(portalService.requestAccess).toHaveBeenCalledTimes(1);
    });
});
