'use strict';

const ORIGINAL_ENV = {
    FEATURE_AUTH_ENABLED: process.env.FEATURE_AUTH_ENABLED,
    KEYCLOAK_REALM_URL: process.env.KEYCLOAK_REALM_URL,
    FEEDBACK_INBOX_EMAIL: process.env.FEEDBACK_INBOX_EMAIL,
    FEEDBACK_SENDER_COMPANY_ID: process.env.FEEDBACK_SENDER_COMPANY_ID,
    FEEDBACK_MAX_FILES: process.env.FEEDBACK_MAX_FILES,
    FEEDBACK_MAX_FILE_MB: process.env.FEEDBACK_MAX_FILE_MB,
};

process.env.FEATURE_AUTH_ENABLED = 'true';
process.env.KEYCLOAK_REALM_URL = 'http://localhost:8080/realms/crm-prod';
delete process.env.FEEDBACK_INBOX_EMAIL;
delete process.env.FEEDBACK_SENDER_COMPANY_ID;
delete process.env.FEEDBACK_MAX_FILES;
delete process.env.FEEDBACK_MAX_FILE_MB;

const COMPANY_A = '10000000-0000-4000-8000-000000000001';
const COMPANY_B = '20000000-0000-4000-8000-000000000002';
const CRM_USER_ID = '30000000-0000-4000-8000-000000000003';
const FEEDBACK_ID = '40000000-0000-4000-8000-000000000004';
const PLATFORM_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

let mockDecoded;
let mockCrmUser;
let mockAuthz;
const mockJwtVerify = jest.fn((_token, _getKey, _options, callback) => callback(null, mockDecoded));
const mockFindOrCreateUser = jest.fn(() => Promise.resolve(mockCrmUser));
const mockResolveAuthzContext = jest.fn(() => Promise.resolve(mockAuthz));
const mockAuditLog = jest.fn(() => Promise.resolve());
const mockInsertFeedback = jest.fn();
const mockUpdateFeedbackEmailStatus = jest.fn();
const mockSendEmail = jest.fn();

jest.mock('jsonwebtoken', () => ({ verify: mockJwtVerify }));
jest.mock('jwks-rsa', () => jest.fn(() => ({ getSigningKey: jest.fn() })));
jest.mock('../../src/services/userService', () => ({
    findOrCreateUser: mockFindOrCreateUser,
}));
jest.mock('../../src/services/auditService', () => ({
    log: mockAuditLog,
}));
jest.mock('../../src/services/authorizationService', () => ({
    buildDevAuthzContext: jest.fn(),
    resolveAuthzContext: mockResolveAuthzContext,
}));
jest.mock('../../src/db/feedbackQueries', () => ({
    insertFeedback: mockInsertFeedback,
    updateFeedbackEmailStatus: mockUpdateFeedbackEmailStatus,
    listFeedback: jest.fn(),
}));
jest.mock('../../src/services/emailService', () => ({
    sendEmail: mockSendEmail,
}));

const express = require('express');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const feedbackRouter = require('../../src/routes/feedback');
const { authenticate, requireCompanyAccess } = require('../../src/middleware/keycloakAuth');

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

function makeApp() {
    const app = express();
    app.use('/api/feedback', authenticate, requireCompanyAccess, feedbackRouter);
    return app;
}

function postFeedback(fields = { email: 'ok@x.com', message: 'button broken' }) {
    let pending = request(makeApp())
        .post('/api/feedback')
        .set('Authorization', 'Bearer valid-token');
    for (const [key, value] of Object.entries(fields)) {
        pending = pending.field(key, value);
    }
    return pending;
}

function attachFile(pending, filename, contentType, buffer = Buffer.from('file')) {
    return pending.attach('files', buffer, { filename, contentType });
}

beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockDecoded = {
        sub: 'keycloak-subject',
        email: 'account@x.com',
        name: 'Feedback User',
        realm_access: { roles: ['company_member'] },
    };
    mockCrmUser = {
        id: CRM_USER_ID,
        company_id: COMPANY_A,
        email: 'account@x.com',
    };
    mockAuthz = {
        scope: 'tenant',
        platform_role: 'none',
        company: { id: COMPANY_A, name: 'Company A' },
        membership: { role_key: 'dispatcher' },
        permissions: [],
    };
    mockInsertFeedback.mockResolvedValue({ id: FEEDBACK_ID, created_at: '2026-07-13T12:00:00Z' });
    mockUpdateFeedbackEmailStatus.mockResolvedValue({ id: FEEDBACK_ID });
    mockSendEmail.mockResolvedValue({ provider_message_id: 'gmail-1' });
});

afterAll(() => {
    for (const [name, value] of Object.entries(ORIGINAL_ENV)) restoreEnv(name, value);
});

describe('POST /api/feedback', () => {
    test('returns 201 after tenant-scoped persistence and platform-sender email', async () => {
        const response = await postFeedback();

        expect(response.status).toBe(201);
        expect(response.body).toEqual({ ok: true, data: { id: FEEDBACK_ID } });
        expect(mockInsertFeedback).toHaveBeenCalledWith(expect.objectContaining({
            companyId: COMPANY_A,
            userId: CRM_USER_ID,
            userEmail: 'ok@x.com',
            message: 'button broken',
        }));
        expect(mockSendEmail).toHaveBeenCalledWith(
            PLATFORM_COMPANY_ID,
            expect.objectContaining({ to: 'support@albusto.com', files: [] })
        );
    });

    test('keeps the 201 response and persists failed status when email rejects', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockSendEmail.mockRejectedValueOnce(new Error('no mailbox'));

        const response = await postFeedback();

        expect(response.status).toBe(201);
        expect(mockInsertFeedback).toHaveBeenCalledTimes(1);
        expect(mockUpdateFeedbackEmailStatus).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            id: FEEDBACK_ID,
            emailStatus: 'failed',
        });
        expect(warn).toHaveBeenCalledWith(
            '[FeedbackService] Best-effort email failed:',
            'no mailbox'
        );
    });

    test.each([
        [{ email: 'not-an-email', message: 'x' }, 'invalid email'],
        [{ email: 'ok@x.com', message: '   ' }, 'empty message'],
    ])('returns 422 for %s (%s)', async (fields) => {
        const response = await postFeedback(fields);

        expect(response.status).toBe(422);
        expect(response.body.ok).toBe(false);
        expect(mockInsertFeedback).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    test('maps a file larger than 10 MB to 422 before persistence', async () => {
        const pending = postFeedback();
        attachFile(pending, 'large.png', 'image/png', Buffer.alloc(10 * 1024 * 1024 + 1));

        const response = await pending;

        expect(response.status).toBe(422);
        expect(mockInsertFeedback).not.toHaveBeenCalled();
    });

    test('maps a sixth file to 422 before persistence', async () => {
        let pending = postFeedback();
        for (let i = 0; i < 6; i += 1) {
            pending = attachFile(pending, `file-${i}.txt`, 'text/plain');
        }

        const response = await pending;

        expect(response.status).toBe(422);
        expect(mockInsertFeedback).not.toHaveBeenCalled();
    });

    test('returns 422 for a disallowed MIME type', async () => {
        const pending = attachFile(
            postFeedback(),
            'program.exe',
            'application/x-msdownload'
        );

        const response = await pending;

        expect(response.status).toBe(422);
        expect(mockInsertFeedback).not.toHaveBeenCalled();
    });

    test('accepts exactly five allowed files and records attachment metadata', async () => {
        const files = [
            ['one.png', 'image/png'],
            ['two.pdf', 'application/pdf'],
            ['three.jpg', 'image/jpeg'],
            ['four.webp', 'image/webp'],
            ['five.txt', 'text/plain'],
        ];
        let pending = postFeedback();
        for (const [filename, contentType] of files) {
            pending = attachFile(pending, filename, contentType);
        }

        const response = await pending;

        expect(response.status).toBe(201);
        expect(mockSendEmail.mock.calls[0][1].files).toHaveLength(5);
        expect(mockInsertFeedback.mock.calls[0][0].meta.attachments).toEqual(
            files.map(([name, mime]) => ({ name, size: 4, mime }))
        );
    });

    test('accepts feedback without attachments', async () => {
        const response = await postFeedback();

        expect(response.status).toBe(201);
        expect(mockSendEmail.mock.calls[0][1].files).toEqual([]);
        expect(mockInsertFeedback.mock.calls[0][0].meta.attachments).toEqual([]);
    });

    test('returns 401 without a bearer token and never runs the route body', async () => {
        const response = await request(makeApp())
            .post('/api/feedback')
            .field('email', 'ok@x.com')
            .field('message', 'x');

        expect(response.status).toBe(401);
        expect(mockInsertFeedback).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    test('returns 403 when the authenticated user has no company membership', async () => {
        mockAuthz = {
            scope: null,
            platform_role: 'none',
            company: null,
            membership: null,
            permissions: [],
        };

        const response = await postFeedback();

        expect(response.status).toBe(403);
        expect(mockInsertFeedback).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    test('ignores a body company_id and uses req.companyFilter company_id', async () => {
        const response = await postFeedback({
            email: 'ok@x.com',
            message: 'x',
            company_id: COMPANY_B,
        });

        expect(response.status).toBe(201);
        expect(mockInsertFeedback.mock.calls[0][0].companyId).toBe(COMPANY_A);
    });

    test('uses crmUser.id rather than the Keycloak subject', async () => {
        const response = await postFeedback();

        expect(response.status).toBe(201);
        expect(mockInsertFeedback.mock.calls[0][0].userId).toBe(CRM_USER_ID);
        expect(mockInsertFeedback.mock.calls[0][0].userId).not.toBe(mockDecoded.sub);
    });

    test('falls back to req.user.email when the multipart email field is absent', async () => {
        const response = await postFeedback({ message: 'x' });

        expect(response.status).toBe(201);
        expect(mockInsertFeedback.mock.calls[0][0].userEmail).toBe('account@x.com');
    });

    test('returns 422 when neither the body nor authenticated user has an email', async () => {
        delete mockDecoded.email;

        const response = await postFeedback({ message: 'x' });

        expect(response.status).toBe(422);
        expect(mockInsertFeedback).not.toHaveBeenCalled();
    });

    test('returns 500 and does not email when authoritative persistence fails', async () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockInsertFeedback.mockRejectedValueOnce(new Error('database unavailable'));

        const response = await postFeedback();

        expect(response.status).toBe(500);
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith(
            '[FeedbackRoute] Submission failed:',
            'database unavailable'
        );
    });
});

describe('server mount', () => {
    test('mounts feedback with authenticate then requireCompanyAccess', () => {
        const source = fs.readFileSync(path.join(__dirname, '../../../src/server.js'), 'utf8');
        expect(source).toContain(
            "app.use('/api/feedback', authenticate, requireCompanyAccess, require('../backend/src/routes/feedback'));"
        );
    });
});
