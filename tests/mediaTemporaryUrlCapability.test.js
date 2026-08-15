'use strict';

const express = require('express');
const request = require('supertest');

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const COMPANY_B = '00000000-0000-4000-8000-00000000000b';
const mockGetMediaTemporaryUrl = jest.fn();

jest.mock('../backend/src/services/conversationsService', () => ({
    getMediaTemporaryUrl: (...args) => mockGetMediaTemporaryUrl(...args),
}));

const accessService = require('../backend/src/services/smsMediaAccessService');
const { mediaTemporaryUrlHandler } = require('../backend/src/routes/mediaTemporaryUrl');

function app() {
    const server = express();
    server.get('/api/messaging/media/:mediaId/temporary-url', mediaTemporaryUrlHandler);
    return server;
}

function pathFor(mediaId, token) {
    return `/api/messaging/media/${mediaId}/temporary-url?cap=${encodeURIComponent(token)}`;
}

beforeEach(() => {
    jest.clearAllMocks();
    process.env.TWILIO_MEDIA_STREAM_TOKEN_SECRET = 'sms-media-access-test-secret-at-least-32-bytes';
    global.fetch = jest.fn();
});

afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
});

test('SAB-E-CAPABILITY/T-foreign: a media id plus spoofed company without a signed capability is 404 before tenant/Twilio work', async () => {
    const response = await request(app())
        .get(`/api/messaging/media/media-a/temporary-url?companyId=${COMPANY_B}`);

    expect(response.status).toBe(404);
    expect(mockGetMediaTemporaryUrl).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
});

test('tampered signature is 404 before tenant/Twilio work', async () => {
    const { token } = accessService.mintMediaAccessToken('media-a', COMPANY_A);
    const forged = `${token.slice(0, -1)}${token.endsWith('x') ? 'y' : 'x'}`;
    const response = await request(app()).get(pathFor('media-a', forged));

    expect(response.status).toBe(404);
    expect(mockGetMediaTemporaryUrl).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
});

test('expired capability is 404 before tenant/Twilio work', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { token } = accessService.mintMediaAccessToken('media-a', COMPANY_A);
    now.mockReturnValue(1_000_000 + (accessService.TOKEN_TTL_SECONDS + 1) * 1000);

    const response = await request(app()).get(pathFor('media-a', token));

    expect(response.status).toBe(404);
    expect(mockGetMediaTemporaryUrl).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
});

test('T-foreign: company B capability cannot read company A media and never fetches upstream', async () => {
    const { token } = accessService.mintMediaAccessToken('media-a', COMPANY_B);
    mockGetMediaTemporaryUrl.mockRejectedValueOnce(new Error('Media media-a not found'));

    const response = await request(app()).get(pathFor('media-a', token));

    expect(response.status).toBe(404);
    expect(mockGetMediaTemporaryUrl).toHaveBeenCalledWith('media-a', COMPANY_B);
    expect(global.fetch).not.toHaveBeenCalled();
});

test('T-own/download: valid capability proxies bytes with a private no-store response', async () => {
    const { token } = accessService.mintMediaAccessToken('media-a', COMPANY_A);
    mockGetMediaTemporaryUrl.mockResolvedValueOnce({
        url: 'https://twilio.example/media-a',
        contentType: 'image/png',
    });
    global.fetch.mockResolvedValueOnce(new Response(Buffer.from('image-bytes'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
    }));

    const response = await request(app()).get(pathFor('media-a', token));

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^image\/png/);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.body).toEqual(Buffer.from('image-bytes'));
});
