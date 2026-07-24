import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleItem } from '../services/scheduleApi';
import appSource from '../App.tsx?raw';

const routingState = vi.hoisted(() => ({
    scheduledItems: [] as ScheduleItem[],
    detailJobs: new Map<number, Record<string, unknown>>(),
    requestedJobId: undefined as number | null | undefined,
    onNotFound: undefined as ((jobId: number) => void) | undefined,
    panelOpen: false,
    panelClose: undefined as (() => void) | undefined,
    selectFromCalendar: undefined as ((item: ScheduleItem) => void) | undefined,
    navigateImpl: undefined as ((to: string | number, options?: { replace?: boolean }) => Promise<void>) | undefined,
    selectSidebarItem: vi.fn(),
    toastError: vi.fn(),
    noop: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-router-dom')>();
    return {
        ...actual,
        useNavigate: () => (
            to: string | number,
            options?: { replace?: boolean },
        ) => routingState.navigateImpl?.(to, options),
    };
});

vi.mock('sonner', () => ({
    toast: { error: routingState.toastError },
}));

vi.mock('../hooks/useIsMobile', () => ({
    useIsMobile: () => false,
}));

vi.mock('../hooks/useScheduleData', () => ({
    useScheduleData: () => ({
        items: routingState.scheduledItems,
        scheduledItems: routingState.scheduledItems,
        unscheduledItems: [],
        providers: [],
        allTags: [],
        itemCounts: { total: routingState.scheduledItems.length, jobs: 0, leads: 0, tasks: 0 },
        settings: {
            timezone: 'America/New_York',
            work_start_time: '08:00',
            work_end_time: '18:00',
            work_days: [1, 2, 3, 4, 5],
            slot_duration: 60,
        },
        currentDate: new Date('2026-07-23T12:00:00Z'),
        viewMode: 'timeline',
        filters: {},
        routeByPair: new Map(),
        unavailability: [],
        unavailabilityError: null,
        sidebarStack: [],
        loading: false,
        error: null,
        canDispatch: false,
        refresh: routingState.noop,
        selectItem: routingState.selectSidebarItem,
        setCurrentDate: routingState.noop,
        setViewMode: routingState.noop,
        navigateDate: routingState.noop,
        setFilters: routingState.noop,
        popLayer: routingState.noop,
        clearStack: routingState.noop,
        pushLayer: routingState.noop,
        reloadUnavailability: routingState.noop,
        handleReschedule: routingState.noop,
        handleReassign: routingState.noop,
    }),
}));

vi.mock('../hooks/useJobDetail', () => ({
    useJobDetail: ({ jobId, onNotFound }: {
        jobId: number | null;
        onNotFound?: (jobId: number) => void;
    }) => {
        routingState.requestedJobId = jobId;
        routingState.onNotFound = onNotFound;
        const job = jobId == null ? null : routingState.detailJobs.get(jobId) || null;
        return {
            job,
            detailLoading: false,
            contactInfo: null,
            allTags: [],
            noteJobId: null,
            noteText: '',
            setNoteText: routingState.noop,
            setNoteJobId: routingState.noop,
            handleBlancStatusChange: routingState.noop,
            handleAddNote: routingState.noop,
            handleMarkEnroute: routingState.noop,
            handleMarkInProgress: routingState.noop,
            handleMarkComplete: routingState.noop,
            handleCancel: routingState.noop,
            handleTagsChange: routingState.noop,
            handleJobUpdated: routingState.noop,
            afterMutation: routingState.noop,
        };
    },
}));

vi.mock('../components/schedule/TimelineView', () => ({
    TimelineView: ({ onSelectItem }: { onSelectItem: (item: ScheduleItem) => void }) => {
        routingState.selectFromCalendar = onSelectItem;
        return <div data-schedule-view="timeline" />;
    },
}));

vi.mock('../components/ui/FloatingDetailPanel', () => ({
    FloatingDetailPanel: ({ open, onClose, children }: {
        open: boolean;
        onClose: () => void;
        children: React.ReactNode;
    }) => {
        routingState.panelOpen = open;
        routingState.panelClose = onClose;
        return <section data-panel-open={String(open)}>{children}</section>;
    },
}));

vi.mock('../components/jobs/JobDetailPanel', () => ({
    JobDetailPanel: ({ job }: { job: { id: number } }) => (
        <div data-job-detail-id={String(job.id)} />
    ),
}));

vi.mock('../components/jobs/NewJobDialog', () => ({
    NewJobDialog: () => null,
}));

vi.mock('../components/schedule/TimeOffDialog', () => ({
    TimeOffDialog: () => null,
}));

vi.mock('../components/schedule/SidebarStack', () => ({
    SidebarStack: () => null,
}));

vi.mock('../components/schedule/ScheduleProviderColorContext', () => ({
    ScheduleProviderColorProvider: ({ children }: { children: React.ReactNode }) => children,
    useScheduleProviderColorRegistry: () => new Map(),
    useScheduleProviderColor: () => null,
}));

import { SchedulePage } from './SchedulePage';

const routes = [
    { path: '/schedule', element: <SchedulePage /> },
    { path: '/schedule/jobs/:jobId', element: <SchedulePage /> },
];

function scheduleItem(entityType: ScheduleItem['entity_type'], entityId: number): ScheduleItem {
    return {
        entity_type: entityType,
        entity_id: entityId,
        title: `${entityType} ${entityId}`,
        subtitle: '',
        status: 'scheduled',
        start_at: '2026-07-23T14:00:00.000Z',
        end_at: '2026-07-23T15:00:00.000Z',
        address_summary: '',
        lat: null,
        lng: null,
        normalized_address: null,
        geocoding_status: null,
        google_maps_url: null,
        customer_name: '',
        customer_phone: '',
        customer_email: '',
        assigned_techs: [],
        job_type: null,
        job_source: null,
        tags: [],
    };
}

function renderRouter(router: ReturnType<typeof createMemoryRouter>): string {
    routingState.panelClose = undefined;
    routingState.selectFromCalendar = undefined;
    routingState.navigateImpl = (to, options) => (
        typeof to === 'number' ? router.navigate(to) : router.navigate(to, options)
    );
    return renderToStaticMarkup(<RouterProvider router={router} />);
}

async function settleNavigation(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    routingState.scheduledItems = [];
    routingState.detailJobs.clear();
    routingState.requestedJobId = undefined;
    routingState.onNotFound = undefined;
    routingState.panelOpen = false;
    routingState.panelClose = undefined;
    routingState.selectFromCalendar = undefined;
    routingState.navigateImpl = undefined;
    routingState.selectSidebarItem.mockReset();
    routingState.toastError.mockReset();
    routingState.noop.mockClear();
});

describe('Schedule job deep-link routing', () => {
    it('registers the deep route beside /schedule with the same permission and page', () => {
        expect(appSource).toContain(
            'path="/schedule/jobs/:jobId" element={<ProtectedRoute permissions={[\'schedule.view\']}><SchedulePage /></ProtectedRoute>}',
        );
    });

    it('opens a directly linked job even when it is outside the visible schedule items', () => {
        routingState.detailJobs.set(1463, { id: 1463 });
        const router = createMemoryRouter(routes, { initialEntries: ['/schedule/jobs/1463'] });

        const markup = renderRouter(router);

        expect(routingState.scheduledItems).toEqual([]);
        expect(routingState.requestedJobId).toBe(1463);
        expect(routingState.panelOpen).toBe(true);
        expect(markup).toContain('data-job-detail-id="1463"');
    });

    it('SAB-SJD-PUSH-REPLACE: first open pushes so Back returns to /schedule and closes the panel', async () => {
        routingState.detailJobs.set(41, { id: 41 });
        const router = createMemoryRouter(routes, { initialEntries: ['/schedule'] });
        renderRouter(router);

        routingState.selectFromCalendar?.(scheduleItem('job', 41));
        await settleNavigation();
        expect(router.state.location.pathname).toBe('/schedule/jobs/41');

        renderRouter(router);
        expect(routingState.panelOpen).toBe(true);

        await router.navigate(-1);
        expect(router.state.location.pathname).toBe('/schedule');

        renderRouter(router);
        expect(routingState.requestedJobId).toBeNull();
        expect(routingState.panelOpen).toBe(false);
    });

    it('replaces A with B so Back closes instead of reopening A', async () => {
        routingState.detailJobs.set(41, { id: 41 });
        routingState.detailJobs.set(52, { id: 52 });
        const router = createMemoryRouter(routes, { initialEntries: ['/schedule'] });
        renderRouter(router);

        routingState.selectFromCalendar?.(scheduleItem('job', 41));
        await settleNavigation();
        renderRouter(router);
        expect(routingState.requestedJobId).toBe(41);

        routingState.selectFromCalendar?.(scheduleItem('job', 52));
        await settleNavigation();
        expect(router.state.location.pathname).toBe('/schedule/jobs/52');

        await router.navigate(-1);
        expect(router.state.location.pathname).toBe('/schedule');
    });

    it('closes the panel by navigating to /schedule', async () => {
        routingState.detailJobs.set(73, { id: 73 });
        const router = createMemoryRouter(routes, { initialEntries: ['/schedule/jobs/73'] });
        renderRouter(router);

        expect(routingState.panelOpen).toBe(true);
        routingState.panelClose?.();
        await settleNavigation();

        expect(router.state.location.pathname).toBe('/schedule');
    });

    it.each(['/schedule/jobs/abc', '/schedule/jobs/0'])(
        'keeps the panel closed and passes no job id for invalid route %s',
        (path) => {
            const router = createMemoryRouter(routes, { initialEntries: [path] });
            const markup = renderRouter(router);

            expect(routingState.requestedJobId).toBeNull();
            expect(routingState.panelOpen).toBe(false);
            expect(markup).not.toContain('data-job-detail-id');
        },
    );

    it('reports an unavailable job and replaces the deep URL with /schedule', async () => {
        const router = createMemoryRouter(routes, { initialEntries: ['/schedule/jobs/404'] });
        renderRouter(router);

        expect(routingState.requestedJobId).toBe(404);
        expect(routingState.onNotFound).toBeTypeOf('function');
        routingState.onNotFound?.(404);
        await settleNavigation();

        expect(routingState.toastError).toHaveBeenCalledWith('Job not found or unavailable');
        expect(router.state.location.pathname).toBe('/schedule');
        await router.navigate(-1);
        expect(router.state.location.pathname).toBe('/schedule');
    });

    it('keeps non-job schedule items in SidebarStack without changing the URL', async () => {
        const router = createMemoryRouter(routes, { initialEntries: ['/schedule'] });
        renderRouter(router);
        const lead = scheduleItem('lead', 88);

        routingState.selectFromCalendar?.(lead);
        await settleNavigation();

        expect(routingState.selectSidebarItem).toHaveBeenCalledWith(lead);
        expect(router.state.location.pathname).toBe('/schedule');
    });
});
