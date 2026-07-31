import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useJobsData } from './useJobsData';

const testState = vi.hoisted(() => ({
    fetchPage: undefined as undefined | ((args: {
        cursor: string | null;
        limit: number;
        signal: AbortSignal;
    }) => Promise<unknown>),
    listJobs: vi.fn(),
    navigate: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-router-dom')>();
    return {
        ...actual,
        useNavigate: () => testState.navigate,
    };
});

vi.mock('../services/jobsApi', () => ({
    listJobs: testState.listJobs,
    listJobTags: vi.fn(async () => []),
    getJobsListFields: vi.fn(async () => []),
    saveJobsListFields: vi.fn(async () => undefined),
}));

vi.mock('./useLeadFormSettings', () => ({
    useLeadFormSettings: () => ({ customFields: [] }),
}));

vi.mock('./useAuthz', () => ({
    useAuthz: () => ({
        company: { id: 'company-1' },
        user: { sub: 'provider-1' },
        membership: { role_key: 'provider' },
        hasPermission: () => false,
    }),
}));

vi.mock('./useLoadMoreList', () => ({
    useLoadMoreList: (options: {
        fetchPage: (args: {
            cursor: string | null;
            limit: number;
            signal: AbortSignal;
        }) => Promise<unknown>;
    }) => {
        testState.fetchPage = options.fetchPage;
        return {
            items: [],
            total: 0,
            meta: null,
            state: null,
            errorPhase: null,
            isLoadingFirst: false,
            loadMore: vi.fn(),
            retry: vi.fn(),
            reset: vi.fn(),
            updateItem: vi.fn(),
        };
    },
}));

let setSearchQuery: ((value: string) => void) | undefined;

function JobsSearchHarness() {
    const data = useJobsData();
    setSearchQuery = data.setSearchQuery;
    return <input aria-label="Jobs search" value={data.searchQuery} readOnly />;
}

function jobsRouter() {
    return createMemoryRouter([
        { path: '/pulse/:timelineId', element: <div>Pulse</div> },
        { path: '/jobs', element: <JobsSearchHarness /> },
    ], {
        initialEntries: ['/pulse/19', '/jobs?search=Jane%20Doe&contact_id=731'],
        initialIndex: 1,
    });
}

beforeEach(() => {
    testState.fetchPage = undefined;
    testState.listJobs.mockReset();
    testState.navigate.mockReset();
    testState.listJobs.mockResolvedValue({
        results: [],
        facets: { providers: [] },
        pagination: {
            mode: 'cursor',
            limit: 50,
            returned: 0,
            has_more: false,
            next_cursor: null,
            total: 0,
        },
    });
    setSearchQuery = undefined;
});

describe('TECH-CONTACT-JOBS-001 — Jobs URL filters', () => {
    it('prefills the visible input on first paint and sends both URL filters to the API', async () => {
        const router = jobsRouter();

        const markup = renderToStaticMarkup(<RouterProvider router={router} />);
        expect(markup).toContain('value="Jane Doe"');

        await testState.fetchPage?.({
            cursor: null,
            limit: 50,
            signal: new AbortController().signal,
        });
        expect(testState.listJobs).toHaveBeenCalledWith(
            expect.objectContaining({ search: 'Jane Doe', contact_id: 731 }),
            expect.any(AbortSignal),
        );
    });

    it('editing the query drops the exact contact pin and replaces Jobs history', () => {
        const router = jobsRouter();
        renderToStaticMarkup(<RouterProvider router={router} />);

        setSearchQuery?.('Janet Doe');
        expect(testState.navigate).toHaveBeenCalledWith({
            pathname: '/jobs',
            search: '?search=Janet+Doe',
        }, { replace: true });
    });

    it('clearing the query removes both search and contact_id', () => {
        const router = jobsRouter();
        renderToStaticMarkup(<RouterProvider router={router} />);

        setSearchQuery?.('');
        expect(testState.navigate).toHaveBeenCalledWith({
            pathname: '/jobs',
            search: '',
        }, { replace: true });
    });
});
