import { describe, expect, it, vi } from 'vitest';
import messageThreadRaw from '../components/messaging/MessageThread.tsx?raw';
import smsListItemRaw from '../components/pulse/SmsListItem.tsx?raw';
import messagingApiRaw from '../services/messagingApi.ts?raw';

const getMediaUrl = vi.hoisted(() => vi.fn());
const hookState = vi.hoisted(() => ({
    initialized: false,
    value: undefined as string | undefined,
    writes: [] as Array<string | undefined>,
    cleanup: undefined as undefined | (() => void),
}));

vi.mock('react', () => ({
    useState: (initialValue?: string) => {
        if (!hookState.initialized) {
            hookState.initialized = true;
            hookState.value = initialValue;
        }
        return [hookState.value, (value: string | undefined) => {
            hookState.value = value;
            hookState.writes.push(value);
        }];
    },
    useEffect: (effect: () => void | (() => void)) => {
        const cleanup = effect();
        hookState.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    },
}));

vi.mock('../services/messagingApi', () => ({
    messagingApi: { getMediaUrl },
}));

import { loadSmsMediaAccessUrl, useSmsMediaAccessUrl } from './useSmsMediaAccessUrl';

describe('signed SMS media links', () => {
    it('keeps src empty until the authenticated mint request resolves', async () => {
        hookState.initialized = false;
        hookState.value = undefined;
        hookState.writes = [];
        const response = {
            url: '/api/messaging/media/media-a/temporary-url?cap=signed',
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        };
        getMediaUrl.mockResolvedValueOnce(response);

        expect(useSmsMediaAccessUrl('media-a')).toBeUndefined();
        expect(hookState.writes).toEqual([undefined]);
        await new Promise(resolve => setImmediate(resolve));
        expect(hookState.value).toBe(response.url);
        expect(hookState.writes).toEqual([undefined, response.url]);
        hookState.cleanup?.();
    });

    it('loads a narrow signed URL through the authenticated API before use', async () => {
        const response = {
            url: '/api/messaging/media/media-a/temporary-url?cap=signed',
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        };
        getMediaUrl.mockResolvedValueOnce(response);

        await expect(loadSmsMediaAccessUrl('media-a')).resolves.toEqual(response);
        expect(getMediaUrl).toHaveBeenCalledWith('media-a');
        expect(messagingApiRaw).toContain('apiClient.post<MediaUrlResponse>');
        expect(messagingApiRaw).toContain('/access-url`');
    });

    it('rejects an unsigned or already-expired response', async () => {
        getMediaUrl.mockResolvedValueOnce({
            url: '/api/messaging/media/media-a/temporary-url',
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        });
        await expect(loadSmsMediaAccessUrl('media-a')).rejects.toThrow('Invalid media access response');

        getMediaUrl.mockResolvedValueOnce({
            url: '/api/messaging/media/media-a/temporary-url?cap=signed',
            expiresAt: new Date(Date.now() - 1_000).toISOString(),
        });
        await expect(loadSmsMediaAccessUrl('media-a')).rejects.toThrow('Invalid media access response');
    });

    it('Pulse and MessageThread never put the bare media-id route into src/href/download', () => {
        for (const source of [smsListItemRaw, messageThreadRaw]) {
            expect(source).toContain('useSmsMediaAccessUrl(media.id)');
            expect(source).toContain('src={signedUrl}');
            expect(source).not.toContain('`/api/messaging/media/${media.id}/temporary-url`');
        }
        expect(smsListItemRaw).toContain('link.href = signedUrl');
        expect(messageThreadRaw).toContain('href={signedUrl}');
    });
});
