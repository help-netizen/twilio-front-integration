/**
 * Email Routes — Unit Tests
 * Settings routes, workspace routes, permission guards.
 */

const express = require('express');
const request = require('supertest');

// Mock all service dependencies
jest.mock('../../backend/src/services/emailMailboxService', () => ({
    getMailboxStatus: jest.fn(),
    buildAuthUrl: jest.fn(),
    disconnectMailbox: jest.fn(),
}));

jest.mock('../../backend/src/services/emailSyncService', () => ({
    syncMailbox: jest.fn().mockResolvedValue(0),
}));

jest.mock('../../backend/src/db/emailQueries', () => ({
    getThreads: jest.fn(),
    getThreadById: jest.fn(),
    getMessagesByThread: jest.fn(),
    markThreadRead: jest.fn(),
    getAttachmentById: jest.fn(),
}));

jest.mock('../../backend/src/services/emailService', () => ({
    sendEmail: jest.fn(),
    replyToThread: jest.fn(),
    getAttachmentStream: jest.fn(),
}));

jest.mock('../../backend/src/middleware/authorization', () => ({
    requirePermission: () => (req, res, next) => next(),
}));

const emailMailboxService = require('../../backend/src/services/emailMailboxService');
const emailQueries = require('../../backend/src/db/emailQueries');
const emailService = require('../../backend/src/services/emailService');

function createTestApp(routerPath, router) {
    const app = express();
    app.use(express.json());
    // Simulate auth middleware
    app.use((req, res, next) => {
        req.companyFilter = { company_id: 'test-company-id' };
        req.user = { sub: 'user-1', email: 'op@test.com' };
        next();
    });
    app.use(routerPath, router);
    return app;
}

// ─── Settings Routes ─────────────────────────────────────────────────────

describe('email-settings routes', () => {
    let app;

    beforeAll(() => {
        const settingsRouter = require('../../backend/src/routes/email-settings');
        app = createTestApp('/api/settings/email', settingsRouter);
    });

    beforeEach(() => jest.clearAllMocks());

    test('GET / returns null when no mailbox', async () => {
        emailMailboxService.getMailboxStatus.mockResolvedValue(null);
        const res = await request(app).get('/api/settings/email');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.mailbox).toBeNull();
    });

    test('GET / returns mailbox status', async () => {
        emailMailboxService.getMailboxStatus.mockResolvedValue({
            provider: 'gmail',
            email_address: 'test@company.com',
            status: 'connected',
        });
        const res = await request(app).get('/api/settings/email');
        expect(res.status).toBe(200);
        expect(res.body.data.mailbox.email_address).toBe('test@company.com');
    });

    test('POST /google/start returns auth URL', async () => {
        emailMailboxService.buildAuthUrl.mockReturnValue('https://google.com/oauth');
        const res = await request(app).post('/api/settings/email/google/start');
        expect(res.status).toBe(200);
        expect(res.body.data.auth_url).toBe('https://google.com/oauth');
    });

    test('POST /disconnect returns 404 when no mailbox', async () => {
        emailMailboxService.disconnectMailbox.mockResolvedValue(null);
        const res = await request(app).post('/api/settings/email/disconnect');
        expect(res.status).toBe(404);
    });

    test('POST /disconnect succeeds', async () => {
        emailMailboxService.disconnectMailbox.mockResolvedValue({ status: 'disconnected' });
        const res = await request(app).post('/api/settings/email/disconnect');
        expect(res.status).toBe(200);
        expect(res.body.data.mailbox.status).toBe('disconnected');
    });

    test('POST /sync returns 404 when no mailbox', async () => {
        emailMailboxService.getMailboxStatus.mockResolvedValue(null);
        const res = await request(app).post('/api/settings/email/sync');
        expect(res.status).toBe(404);
    });

    test('POST /sync returns 409 when disconnected', async () => {
        emailMailboxService.getMailboxStatus.mockResolvedValue({ status: 'disconnected' });
        const res = await request(app).post('/api/settings/email/sync');
        expect(res.status).toBe(409);
    });
});

// ─── Workspace Routes ────────────────────────────────────────────────────

describe('email workspace routes', () => {
    let app;

    beforeAll(() => {
        const emailRouter = require('../../backend/src/routes/email');
        app = createTestApp('/api/email', emailRouter);
    });

    beforeEach(() => jest.clearAllMocks());

    test('GET /mailbox returns mailbox status', async () => {
        emailMailboxService.getMailboxStatus.mockResolvedValue({ status: 'connected', email_address: 'test@co.com' });
        const res = await request(app).get('/api/email/mailbox');
        expect(res.status).toBe(200);
        expect(res.body.data.mailbox.status).toBe('connected');
    });

    test('GET /threads returns thread list', async () => {
        emailQueries.getThreads.mockResolvedValue({
            threads: [{ id: 1, subject: 'Test', unread_count: 1 }],
            nextCursor: null,
            hasMore: false,
        });
        const res = await request(app).get('/api/email/threads?view=inbox&limit=10');
        expect(res.status).toBe(200);
        expect(res.body.data.threads).toHaveLength(1);
    });

    test('GET /threads/:id returns thread detail', async () => {
        emailQueries.getThreadById.mockResolvedValue({ id: 1, subject: 'Hello' });
        emailQueries.getMessagesByThread.mockResolvedValue([{ id: 10, body_text: 'Test message' }]);
        const res = await request(app).get('/api/email/threads/1');
        expect(res.status).toBe(200);
        expect(res.body.data.thread.subject).toBe('Hello');
        expect(res.body.data.messages).toHaveLength(1);
    });

    test('GET /threads/:id returns 404 for missing thread', async () => {
        emailQueries.getThreadById.mockResolvedValue(null);
        const res = await request(app).get('/api/email/threads/999');
        expect(res.status).toBe(404);
    });

    test('POST /threads/:id/read marks thread as read', async () => {
        emailQueries.markThreadRead.mockResolvedValue({ id: 1, unread_count: 0 });
        const res = await request(app).post('/api/email/threads/1/read');
        expect(res.status).toBe(200);
        expect(emailQueries.markThreadRead).toHaveBeenCalledWith('1', 'test-company-id');
    });

    test('POST /threads/compose validates required fields', async () => {
        const res = await request(app)
            .post('/api/email/threads/compose')
            .field('subject', 'Test')
            .field('body', 'Hello');
        // Missing 'to' should return 400
        expect(res.status).toBe(400);
    });

    test('GET /attachments/:id/download returns 404 for missing attachment', async () => {
        emailService.getAttachmentStream.mockResolvedValue(null);
        const res = await request(app).get('/api/email/attachments/999/download');
        expect(res.status).toBe(404);
    });
});
