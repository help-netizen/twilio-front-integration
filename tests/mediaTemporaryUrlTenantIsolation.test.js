'use strict';

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const COMPANY_B = '00000000-0000-4000-8000-00000000000b';

const mockGetMediaById = jest.fn();
const mockDbQuery = jest.fn();
const mockFetchMessage = jest.fn();
const mockGetTwilioClient = jest.fn(() => ({
    conversations: {
        v1: {
            services: () => ({
                conversations: () => ({
                    messages: () => ({ fetch: mockFetchMessage }),
                }),
            }),
        },
    },
}));

jest.mock('../backend/src/db/conversationsQueries', () => ({ getMediaById: mockGetMediaById }));
jest.mock('../backend/src/db/connection', () => ({ query: mockDbQuery }));
jest.mock('../backend/src/services/twilioClient', () => ({ getTwilioClient: mockGetTwilioClient }));
jest.mock('../backend/src/services/realtimeService', () => ({}));
jest.mock('../backend/src/services/eventBus', () => ({}));

const conversationsService = require('../backend/src/services/conversationsService');

beforeEach(() => {
    jest.clearAllMocks();
    mockGetMediaById.mockImplementation(async (mediaId, companyId) => {
        if (mediaId !== 'media-a' || companyId !== COMPANY_A) return null;
        return {
            id: mediaId,
            company_id: COMPANY_A,
            conversation_sid: 'CH-A',
            twilio_message_sid: 'IM-A',
            twilio_media_sid: 'ME-A',
            content_type: 'image/jpeg',
            temporary_url: null,
            temporary_url_expires_at: null,
        };
    });
});

test('T-foreign/T-blast: company B cannot fetch company A media or reach Twilio', async () => {
    await expect(conversationsService.getMediaTemporaryUrl('media-a', COMPANY_B))
        .rejects.toThrow('Media media-a not found');

    expect(mockGetMediaById).toHaveBeenCalledWith('media-a', COMPANY_B);
    expect(mockGetTwilioClient).not.toHaveBeenCalled();
    expect(mockFetchMessage).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
});

test('T-own: refresh lookup and cache update both use the request company', async () => {
    mockFetchMessage.mockResolvedValue({ media: [{ sid: 'ME-A', url: 'https://temporary.example/a' }] });
    mockDbQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    const result = await conversationsService.getMediaTemporaryUrl('media-a', COMPANY_A, true);

    expect(result.url).toBe('https://temporary.example/a');
    expect(mockGetMediaById).toHaveBeenCalledWith('media-a', COMPANY_A);
    expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining('message.company_id = $4'),
        expect.arrayContaining(['media-a', 'https://temporary.example/a', COMPANY_A])
    );
    expect(mockDbQuery.mock.calls[0][1][3]).toBe(COMPANY_A);
});

test('fail-closed: missing company is rejected before media lookup', async () => {
    await expect(conversationsService.getMediaTemporaryUrl('media-a'))
        .rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
    expect(mockGetMediaById).not.toHaveBeenCalled();
});
