'use strict';

const ORIGINAL_ENV = {
    FEEDBACK_INBOX_EMAIL: process.env.FEEDBACK_INBOX_EMAIL,
    FEEDBACK_SENDER_COMPANY_ID: process.env.FEEDBACK_SENDER_COMPANY_ID,
    FEEDBACK_MAX_FILES: process.env.FEEDBACK_MAX_FILES,
    FEEDBACK_MAX_FILE_MB: process.env.FEEDBACK_MAX_FILE_MB,
};

delete process.env.FEEDBACK_INBOX_EMAIL;
delete process.env.FEEDBACK_SENDER_COMPANY_ID;
delete process.env.FEEDBACK_MAX_FILES;
delete process.env.FEEDBACK_MAX_FILE_MB;

const mockQuery = jest.fn();
const mockSendEmail = jest.fn();

jest.mock('../../src/db/connection', () => ({
    query: mockQuery,
}));
jest.mock('../../src/services/emailService', () => ({
    sendEmail: mockSendEmail,
}));

const feedbackQueries = require('../../src/db/feedbackQueries');
const feedbackService = require('../../src/services/feedbackService');

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const CRM_USER_ID = '30000000-0000-4000-8000-000000000003';
const FEEDBACK_ID = '40000000-0000-4000-8000-000000000004';
const CREATED_AT = '2026-07-13T12:00:00Z';

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

function file(overrides = {}) {
    return {
        originalname: 'evidence.png',
        mimetype: 'image/png',
        size: 4,
        buffer: Buffer.from('file'),
        ...overrides,
    };
}

function mockPersistence() {
    mockQuery
        .mockResolvedValueOnce({ rows: [{ id: FEEDBACK_ID, created_at: CREATED_AT }] })
        .mockResolvedValueOnce({ rows: [{ id: FEEDBACK_ID, created_at: CREATED_AT }] });
}

function validInput(overrides = {}) {
    return {
        companyId: COMPANY_ID,
        userId: CRM_USER_ID,
        userEmail: 'author@x.com',
        message: 'The save button is broken.',
        files: [],
        ...overrides,
    };
}

beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockSendEmail.mockResolvedValue({ provider_message_id: 'gmail-1' });
});

afterAll(() => {
    for (const [name, value] of Object.entries(ORIGINAL_ENV)) restoreEnv(name, value);
});

describe('feedbackService.submitFeedback', () => {
    test('inserts first, then sends through the platform company and persists sent status', async () => {
        mockPersistence();

        const result = await feedbackService.submitFeedback(validInput({
            userEmail: '  author@x.com  ',
            message: '  The save button is broken.  ',
            files: [file()],
        }));

        expect(result).toEqual({
            id: FEEDBACK_ID,
            created_at: CREATED_AT,
            meta: {
                attachments: [{ name: 'evidence.png', size: 4, mime: 'image/png' }],
                email_status: 'sent',
            },
        });
        expect(mockQuery).toHaveBeenCalledTimes(2);
        const [insertSql, insertParams] = mockQuery.mock.calls[0];
        expect(insertSql).toMatch(/INSERT INTO feedback_submissions/i);
        expect(insertSql).toMatch(/company_id/);
        expect(insertParams.slice(0, 4)).toEqual([
            COMPANY_ID,
            CRM_USER_ID,
            'author@x.com',
            'The save button is broken.',
        ]);
        expect(JSON.parse(insertParams[4])).toEqual({
            attachments: [{ name: 'evidence.png', size: 4, mime: 'image/png' }],
            email_status: 'skipped',
        });
        expect(mockSendEmail).toHaveBeenCalledWith(
            '00000000-0000-0000-0000-000000000001',
            expect.objectContaining({
                to: 'support@albusto.com',
                files: [expect.objectContaining({ originalname: 'evidence.png' })],
            })
        );
        const [updateSql, updateParams] = mockQuery.mock.calls[1];
        expect(updateSql).toMatch(/WHERE id = \$1 AND company_id = \$2/);
        expect(updateParams).toEqual([FEEDBACK_ID, COMPANY_ID, 'sent']);
        expect(mockQuery.mock.invocationCallOrder[0]).toBeLessThan(
            mockSendEmail.mock.invocationCallOrder[0]
        );
    });

    test('does not throw after email failure and stores failed status', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockPersistence();
        mockSendEmail.mockRejectedValueOnce(new Error('Gmail unavailable'));

        const result = await feedbackService.submitFeedback(validInput());

        expect(result.meta.email_status).toBe('failed');
        expect(mockQuery.mock.calls[1][1]).toEqual([FEEDBACK_ID, COMPANY_ID, 'failed']);
        expect(warn).toHaveBeenCalledWith(
            '[FeedbackService] Best-effort email failed:',
            'Gmail unavailable'
        );
    });

    test('still returns the durable row if the best-effort status update fails', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: FEEDBACK_ID, created_at: CREATED_AT }] })
            .mockRejectedValueOnce(new Error('status write failed'));

        const result = await feedbackService.submitFeedback(validInput());

        expect(result.id).toBe(FEEDBACK_ID);
        expect(result.meta.email_status).toBe('sent');
        expect(warn).toHaveBeenCalledWith(
            '[FeedbackService] Failed to persist email status:',
            'status write failed'
        );
    });

    test('does not send email if the authoritative INSERT fails', async () => {
        mockQuery.mockRejectedValueOnce(new Error('insert failed'));

        await expect(feedbackService.submitFeedback(validInput())).rejects.toThrow('insert failed');
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test.each([
        [validInput({ userEmail: 'invalid' }), 'invalid email'],
        [validInput({ userEmail: '' }), 'missing email'],
        [validInput({ message: '   ' }), 'empty message'],
        [validInput({ files: Array.from({ length: 6 }, () => file()) }), 'too many files'],
        [validInput({ files: [file({ size: 10 * 1024 * 1024 + 1 })] }), 'oversized file'],
        [validInput({ files: [file({ mimetype: 'application/x-msdownload' })] }), 'bad MIME'],
    ])('rejects %s with status 422 before persistence (%s)', async (input) => {
        await expect(feedbackService.submitFeedback(input)).rejects.toMatchObject({ status: 422 });
        expect(mockQuery).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    test('accepts exactly five files whose reported size is exactly 10 MB', async () => {
        mockPersistence();
        const files = Array.from({ length: 5 }, (_, index) => file({
            originalname: `file-${index}.png`,
            size: 10 * 1024 * 1024,
        }));

        const result = await feedbackService.submitFeedback(validInput({ files }));

        expect(result.meta.attachments).toHaveLength(5);
        expect(mockSendEmail.mock.calls[0][1].files).toHaveLength(5);
    });

    test('accepts text-only feedback with an empty files array', async () => {
        mockPersistence();

        const result = await feedbackService.submitFeedback(validInput({ files: [] }));

        expect(result.meta.attachments).toEqual([]);
        expect(mockSendEmail.mock.calls[0][1].files).toEqual([]);
    });
});

describe('feedbackQueries tenant scoping', () => {
    test('listFeedback filters and orders within the requested company', async () => {
        const rows = [{ id: FEEDBACK_ID, company_id: COMPANY_ID }];
        mockQuery.mockResolvedValueOnce({ rows });

        const result = await feedbackQueries.listFeedback(COMPANY_ID);

        expect(result).toBe(rows);
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/WHERE company_id = \$1/);
        expect(sql).toMatch(/ORDER BY created_at DESC/);
        expect(params).toEqual([COMPANY_ID]);
    });
});
