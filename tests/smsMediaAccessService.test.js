'use strict';

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const COMPANY_B = '00000000-0000-4000-8000-00000000000b';

const mockGetMediaById = jest.fn();

jest.mock('../backend/src/db/conversationsQueries', () => ({
    getMediaById: (...args) => mockGetMediaById(...args),
}));

const accessService = require('../backend/src/services/smsMediaAccessService');

beforeEach(() => {
    jest.clearAllMocks();
    process.env.TWILIO_MEDIA_STREAM_TOKEN_SECRET = 'sms-media-access-test-secret-at-least-32-bytes';
    mockGetMediaById.mockImplementation(async (mediaId, companyId) => (
        mediaId === 'media-a' && companyId === COMPANY_A
            ? { id: 'media-a', company_id: COMPANY_A }
            : null
    ));
});

afterEach(() => {
    jest.restoreAllMocks();
});

test('T-own/T-blast: issue checks ownership and binds the signed link to company and media', async () => {
    const access = await accessService.issueMediaAccess('media-a', COMPANY_A);
    const capability = new URL(access.url, 'https://api.example.test').searchParams.get('cap');

    expect(mockGetMediaById).toHaveBeenCalledWith('media-a', COMPANY_A);
    expect(access.url).toMatch(/^\/api\/messaging\/media\/media-a\/temporary-url\?cap=/);
    expect(access.url).not.toContain('?token=');
    expect(accessService.verifyMediaAccessToken(capability, 'media-a')).toMatchObject({
        company_id: COMPANY_A,
        media_id: 'media-a',
        purpose: 'sms_media_access',
    });
    expect(accessService.verifyMediaAccessToken(capability, 'media-b')).toBeNull();
});

test('T-foreign: foreign media is not issued a capability', async () => {
    await expect(accessService.issueMediaAccess('media-a', COMPANY_B)).resolves.toBeNull();
    expect(mockGetMediaById).toHaveBeenCalledWith('media-a', COMPANY_B);
});

test('tampered signature is rejected', () => {
    const { token } = accessService.mintMediaAccessToken('media-a', COMPANY_A);
    const forged = `${token.slice(0, -1)}${token.endsWith('x') ? 'y' : 'x'}`;
    expect(accessService.verifyMediaAccessToken(forged, 'media-a')).toBeNull();
});

test('expired capability is rejected', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { token } = accessService.mintMediaAccessToken('media-a', COMPANY_A);
    now.mockReturnValue(1_000_000 + (accessService.TOKEN_TTL_SECONDS + 1) * 1000);
    expect(accessService.verifyMediaAccessToken(token, 'media-a')).toBeNull();
});

test('missing company fails before ownership lookup', async () => {
    await expect(accessService.issueMediaAccess('media-a'))
        .rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
    expect(mockGetMediaById).not.toHaveBeenCalled();
});
