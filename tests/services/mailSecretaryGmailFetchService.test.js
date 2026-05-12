jest.mock('googleapis', () => ({
    google: {
        gmail: jest.fn(),
    },
}));

jest.mock('../../backend/src/db/emailQueries', () => ({
    getMailboxByCompany: jest.fn(),
}));

jest.mock('../../backend/src/services/emailMailboxService', () => ({
    createOAuth2Client: jest.fn(() => ({
        setCredentials: jest.fn(),
    })),
    getValidAccessToken: jest.fn(),
}));

const { google } = require('googleapis');
const emailQueries = require('../../backend/src/db/emailQueries');
const emailMailboxService = require('../../backend/src/services/emailMailboxService');
const mailSecretaryGmailFetchService = require('../../backend/src/services/mailSecretaryGmailFetchService');

describe('mailSecretaryGmailFetchService', () => {
    const gmailGet = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        emailQueries.getMailboxByCompany.mockResolvedValue({
            id: 'mailbox-1',
            provider: 'gmail',
            status: 'connected',
        });
        emailMailboxService.getValidAccessToken.mockResolvedValue('access-token');
        google.gmail.mockReturnValue({
            users: {
                messages: {
                    get: gmailGet,
                },
            },
        });
    });

    test('fetches Gmail message in full format and returns storage ref', async () => {
        gmailGet.mockResolvedValue({
            data: {
                id: 'msg-1',
                threadId: 'thread-1',
                labelIds: ['INBOX'],
                historyId: '99',
                internalDate: '1778500000000',
                sizeEstimate: 1234,
                snippet: 'Hello',
                payload: { mimeType: 'text/plain' },
            },
        });

        const result = await mailSecretaryGmailFetchService.fetchGmailMessage({
            companyId: 'company-1',
            gmailMessageId: 'msg-1',
            format: 'full',
        });

        expect(gmailGet).toHaveBeenCalledWith({
            userId: 'me',
            id: 'msg-1',
            format: 'full',
        });
        expect(result.storage_ref).toMatchObject({
            provider: 'gmail',
            mailbox_id: 'mailbox-1',
            gmail_message_id: 'msg-1',
            gmail_thread_id: 'thread-1',
        });
        expect(result.payload).toEqual({ mimeType: 'text/plain' });
        expect(result.raw_base64url).toBeUndefined();
    });

    test('fetches Gmail message in raw format transiently', async () => {
        gmailGet.mockResolvedValue({
            data: {
                id: 'msg-raw',
                threadId: 'thread-raw',
                raw: 'base64url-data',
            },
        });

        const result = await mailSecretaryGmailFetchService.fetchGmailMessage({
            companyId: 'company-1',
            gmailMessageId: 'msg-raw',
            format: 'raw',
        });

        expect(gmailGet).toHaveBeenCalledWith({
            userId: 'me',
            id: 'msg-raw',
            format: 'raw',
        });
        expect(result.raw_base64url).toBe('base64url-data');
        expect(result.payload).toBeUndefined();
    });

    test('passes metadataHeaders only for metadata format', async () => {
        gmailGet.mockResolvedValue({
            data: {
                id: 'msg-meta',
                threadId: 'thread-meta',
                payload: { headers: [{ name: 'Subject', value: 'Hi' }] },
            },
        });

        await mailSecretaryGmailFetchService.fetchGmailMessage({
            companyId: 'company-1',
            gmailMessageId: 'msg-meta',
            format: 'metadata',
            metadataHeaders: ['Subject', 'From'],
        });

        expect(gmailGet).toHaveBeenCalledWith({
            userId: 'me',
            id: 'msg-meta',
            format: 'metadata',
            metadataHeaders: ['Subject', 'From'],
        });
    });

    test('rejects when Gmail is not connected', async () => {
        emailQueries.getMailboxByCompany.mockResolvedValue({ id: 'mailbox-1', provider: 'gmail', status: 'disconnected' });

        await expect(mailSecretaryGmailFetchService.fetchGmailMessage({
            companyId: 'company-1',
            gmailMessageId: 'msg-1',
        })).rejects.toMatchObject({ code: 'GMAIL_REQUIRED', httpStatus: 409 });

        expect(gmailGet).not.toHaveBeenCalled();
    });

    test('rejects unsupported Gmail fetch format', async () => {
        await expect(mailSecretaryGmailFetchService.fetchGmailMessage({
            companyId: 'company-1',
            gmailMessageId: 'msg-1',
            format: 'minimal',
        })).rejects.toMatchObject({ code: 'INVALID_GMAIL_FORMAT', httpStatus: 400 });
    });
});
