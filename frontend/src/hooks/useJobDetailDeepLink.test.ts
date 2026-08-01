import { beforeEach, describe, expect, it, vi } from 'vitest';

const hookState = vi.hoisted(() => ({
    getJob: vi.fn(),
    listJobTags: vi.fn(),
    getContact: vi.fn(),
    realtimeOptions: null as { onJobUpdated?: () => void } | null,
}));

vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    return {
        ...actual,
        useState: <T>(initial: T) => [initial, vi.fn()] as const,
        useEffect: (effect: () => void | (() => void)) => {
            effect();
        },
        useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    };
});

vi.mock('../services/jobsApi', () => ({
    getJob: hookState.getJob,
    listJobTags: hookState.listJobTags,
}));

vi.mock('../services/contactsApi', () => ({
    getContact: hookState.getContact,
}));

vi.mock('./useRealtimeEvents', () => ({
    useRealtimeEvents: (options: { onJobUpdated?: () => void }) => {
        hookState.realtimeOptions = options;
    },
}));

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

import { useJobDetail } from './useJobDetail';

beforeEach(() => {
    hookState.getJob.mockReset();
    hookState.listJobTags.mockReset().mockResolvedValue([]);
    hookState.getContact.mockReset();
    hookState.realtimeOptions = null;
});

describe('useJobDetail deep-link fetch contract', () => {
    it('fetches a positive URL-selected job id through the existing jobs API', async () => {
        hookState.getJob.mockResolvedValue({ id: 1463, contact_id: null });

        useJobDetail({ jobId: 1463 });

        await vi.waitFor(() => {
            expect(hookState.getJob).toHaveBeenCalledTimes(1);
            expect(hookState.getJob).toHaveBeenCalledWith(1463);
        });
    });

    it('does not fetch when route validation supplies no job id', () => {
        useJobDetail({ jobId: null });

        expect(hookState.getJob).not.toHaveBeenCalled();
    });

    it('fires onNotFound with the rejected job id', async () => {
        const onNotFound = vi.fn();
        hookState.getJob.mockRejectedValue(new Error('Forbidden'));

        useJobDetail({ jobId: 404, onNotFound });

        await vi.waitFor(() => {
            expect(hookState.getJob).toHaveBeenCalledWith(404);
            expect(onNotFound).toHaveBeenCalledWith(404);
        });
    });

    it('refetches the route-selected job when job.updated is only an invalidation', async () => {
        hookState.getJob.mockResolvedValue({ id: 1463, contact_id: null });

        useJobDetail({ jobId: 1463 });
        await vi.waitFor(() => expect(hookState.getJob).toHaveBeenCalledWith(1463));

        hookState.getJob.mockClear();
        hookState.realtimeOptions?.onJobUpdated?.();

        await vi.waitFor(() => {
            expect(hookState.getJob).toHaveBeenCalledTimes(1);
            expect(hookState.getJob).toHaveBeenCalledWith(1463);
        });
    });
});
