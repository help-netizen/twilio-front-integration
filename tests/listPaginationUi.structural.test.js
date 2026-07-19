'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('LIST-PAGINATION-UNIFY-001 shared frontend contracts', () => {
    const hookPath = 'frontend/src/hooks/useLoadMoreList.ts';
    const corePath = 'frontend/src/hooks/loadMoreListCore.ts';
    const footerPath = 'frontend/src/components/lists/LoadMoreFooter.tsx';

    test('LPU-UI-01 · continuation is manual-only with no hidden viewport or lifecycle path', () => {
        const hook = read(hookPath);
        const footer = read(footerPath);

        for (const forbidden of [
            'IntersectionObserver',
            'sentinelRef',
            "addEventListener('scroll'",
            'addEventListener("scroll"',
            "addEventListener('pageshow'",
            'addEventListener("pageshow"',
            "addEventListener('visibilitychange'",
            'addEventListener("visibilitychange"',
            "addEventListener('online'",
            'addEventListener("online"',
        ]) {
            expect(`${hook}\n${footer}`).not.toContain(forbidden);
        }

        const effects = hook.match(/useEffect\(\(\) => \{[\s\S]*?\n    \}, \[[^\]]*\]\);/g) || [];
        expect(effects).toHaveLength(1);
        expect(effects[0]).not.toMatch(/loadMore|fetchNextPage/);
        expect(footer).toContain('onClick={onLoadMore}');
        expect(footer).toContain("state === 'idle-with-more' || isLoading");
    });

    test('LPU-UI-02 · hook threads abort, disables automatic retries, and gates each cursor', () => {
        const hook = read(hookPath);
        const core = read(corePath);

        expect(hook).toContain('queryFn: async ({ pageParam, signal })');
        expect(hook).toContain('fetchPage({');
        expect(hook).toContain('signal,');
        expect(hook).toContain('retry: false');
        expect(hook).toContain('refetchOnReconnect: false');
        expect(hook).toContain('refetchOnWindowFocus: false');
        expect(hook).toContain('admitCursorRequest(requestGateRef.current, cursor)');
        expect(hook).toContain('fetchNextPage({ cancelRefetch: false })');
        expect(hook).toContain('const generationRef = useRef(0)');
        expect(hook).toContain("throw new DOMException('Stale list generation', 'AbortError')");
        expect(hook).toContain('queryClient.cancelQueries({ queryKey: stableQueryKey, exact: true })');
        expect(hook).toContain('queryClient.resetQueries({ queryKey: stableQueryKey, exact: true })');
        expect(core).toContain('gate.inFlight.has(cursor) || gate.succeeded.has(cursor)');
    });

    test('LPU-UI-03 · footer implements the five states and agreed count copy', () => {
        const core = read(corePath);
        const footer = read(footerPath);

        for (const state of [
            'idle-with-more',
            'loading-more',
            'all-loaded',
            'error+retry',
            'empty',
        ]) {
            expect(core).toContain(`'${state}'`);
        }
        expect(footer).toContain('`All ${knownTotal} ${noun} loaded`');
        expect(footer).toContain('`${loadedCount} of ${knownTotal} ${noun} loaded`');
        expect(footer).toContain("'Load more'");
        expect(footer).toContain("'Retry load more'");
        expect(footer).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
});

describe('LIST-PAGINATION-UNIFY-001 Leads integration', () => {
    test('LPU-LEADS-01 · all controls are server-backed cursor query inputs', () => {
        const page = read('frontend/src/pages/LeadsPage.tsx');
        const api = read('frontend/src/services/leadsApi.ts');

        expect(page).toContain('useLoadMoreList<Lead>');
        expect(page).toContain('useDebouncedSearch(searchQuery, 300)');
        expect(page).toContain("'leads-list'");
        expect(page).toContain('company?.id ?? null');
        for (const input of [
            'search: debouncedSearch || undefined',
            'source: normalizedSources',
            'job_type: normalizedJobTypes',
            'rejected_only: rejectedOnly',
            'sort_by: sortBy',
            'sort_order: sortOrder',
            'cursor: cursor ?? undefined',
        ]) {
            expect(page).toContain(input);
        }
        expect(page).not.toMatch(/const filteredLeads = useMemo|handleNextPage|handlePrevPage|loadMoreLeads/);
        expect(api).toContain('params.cursor');
        expect(api).toContain('{ signal }');
    });

    test('LPU-LEADS-02 · desktop and mobile preserve their shells and share the footer', () => {
        const page = read('frontend/src/pages/LeadsPage.tsx');
        const table = read('frontend/src/components/leads/LeadsTable.tsx');
        const mobile = read('frontend/src/components/leads/LeadsMobileList.tsx');

        expect(page).toContain('<MobileListPage');
        expect(page.match(/footerProps=\{footerProps\}/g)).toHaveLength(2);
        expect(table).toContain('<LoadMoreFooter {...footerProps} />');
        expect(mobile).toContain('<LoadMoreFooter {...footerProps} />');
        expect(`${table}\n${mobile}`).not.toMatch(/Showing \{|>Previous<|>Next</);
        expect(page).toContain("singularLabel: 'lead'");
        expect(page).toContain("pluralLabel: 'leads'");
    });
});

describe('LIST-PAGINATION-UNIFY-001 Jobs integration', () => {
    test('LPU-JOBS-01 · one start-date default and every filter belongs to the cursor query', () => {
        const hook = read('frontend/src/hooks/useJobsData.ts');
        const api = read('frontend/src/services/jobsApi.ts');

        expect(hook).toContain("useState<string>('start_date')");
        expect(hook).toContain("useState<'asc' | 'desc'>('desc')");
        expect(hook).not.toMatch(/mobileSortApplied|setSortBy\('start_date'\).*useEffect|useIsMobile/);
        expect(hook).toContain('useDebouncedSearch(searchQuery, 300)');
        expect(hook).toContain('useLoadMoreList<LocalJob, JobsListFacets>');
        for (const input of [
            'job_source: normalizedSources',
            'provider: normalizedProviders',
            'service_name: normalizedJobTypes',
            'tag_ids: normalizedTagIds',
            'cursor: cursor ?? undefined',
        ]) {
            expect(hook).toContain(input);
        }
        expect(hook).not.toMatch(/result\.filter|\bsetJobs\b|offset:/);
        expect(api).toContain('params: JobsListParams = {}, signal?: AbortSignal');
        expect(api).toContain('{ signal }');
    });

    test('LPU-JOBS-02 · facets and one shared footer drive both unchanged shells', () => {
        const hook = read('frontend/src/hooks/useJobsData.ts');
        const page = read('frontend/src/pages/JobsPage.tsx');
        const filters = read('frontend/src/components/jobs/JobsFilters.tsx');
        const mobileBar = read('frontend/src/components/jobs/JobsMobileBar.tsx');
        const table = read('frontend/src/components/jobs/JobsTable.tsx');
        const mobileList = read('frontend/src/components/jobs/JobsMobileList.tsx');

        expect(hook).toContain('providerNames: jobsList.meta?.providers ?? []');
        expect(filters).not.toMatch(/assigned_techs|new Set<string>/);
        expect(mobileBar).not.toMatch(/assigned_techs|new Set<string>/);
        expect(page.match(/footerProps=\{footerProps\}/g)).toHaveLength(2);
        expect(table).toContain('<LoadMoreFooter {...footerProps} />');
        expect(mobileList).toContain('<LoadMoreFooter {...footerProps} />');
        expect(page).toContain('<MobileListPage');
        expect(table).not.toMatch(/ChevronLeft|ChevronRight|onLoadJobs|offset/);
        expect(mobileList).not.toContain('new Date(a.start_date');
    });
});

describe('LIST-PAGINATION-UNIFY-001 Tasks integration', () => {
    test('LPU-TASKS-01 · search and every sort use the 50-row cursor endpoint', () => {
        const page = read('frontend/src/pages/TasksPage.tsx');
        const api = read('frontend/src/components/tasks/tasksApi.ts');

        expect(page).toContain('useLoadMoreList<Task>');
        expect(page).toContain('useDebouncedSearch(searchQuery, 300)');
        expect(page).toContain('pageSize: TASKS_PAGE_SIZE');
        expect(page).toContain('const TASKS_PAGE_SIZE = 50');
        expect(page).toContain('search: debouncedSearch || undefined');
        expect(page).toContain('sort_by: sortBy');
        expect(page).toContain('sort_order: sortOrder');
        expect(page).toContain('cursor: cursor ?? undefined');
        expect(page).not.toMatch(/limit: 500|filteredTasks|tasks\.filter|\[\.\.\.filtered\]\.sort/);
        expect(api).toContain('export async function listTasksPage');
        expect(api).toContain('{ signal }');
    });

    test('LPU-TASKS-02 · desktop and grouped mobile lists retain MobileListPage and share the footer', () => {
        const page = read('frontend/src/pages/TasksPage.tsx');

        expect(page).toContain('<MobileListPage');
        expect(page.match(/<LoadMoreFooter \{\.\.\.footerProps\} \/>/g).length).toBeGreaterThanOrEqual(2);
        expect(page).toContain("singularLabel: 'task'");
        expect(page).toContain("pluralLabel: 'tasks'");
        expect(page).not.toContain('Count line');
    });
});

describe('LIST-PAGINATION-UNIFY-001 Contacts integration', () => {
    test('LPU-CONTACTS-01 · one debounced cursor query replaces the direct-call double fire', () => {
        const page = read('frontend/src/pages/ContactsPage.tsx');
        const api = read('frontend/src/services/contactsApi.ts');

        expect(page).toContain('useDebouncedSearch(search, 300)');
        expect(page).toContain('useLoadMoreList<Contact>');
        expect(page).toContain("'contacts-list'");
        expect(page).toContain('user?.sub ?? null');
        expect(page).toContain('membership?.role_key ?? null');
        expect(page).toContain('cursor: cursor ?? undefined');
        expect(page).not.toMatch(/loadContacts|handleSearch|handleNextPage|handlePrevPage|setOffset|\boffset\b/);
        expect(api).toContain('params: ContactsListParams = {}, signal?: AbortSignal');
        expect(api).toContain('params.cursor');
        expect(api).toContain('{ signal }');
    });

    test('LPU-CONTACTS-02 · the current responsive shell and tiles keep one in-scroll footer', () => {
        const page = read('frontend/src/pages/ContactsPage.tsx');
        const list = read('frontend/src/components/contacts/ContactsList.tsx');

        expect(page).not.toContain('MobileListPage');
        expect(list).toContain('<LoadMoreFooter {...footerProps} />');
        expect(list).not.toMatch(/ChevronLeft|ChevronRight|onNextPage|onPrevPage|> Prev|> Next/);
        expect(page).toContain("singularLabel: 'contact'");
        expect(page).toContain("pluralLabel: 'contacts'");
    });
});

describe('LIST-PAGINATION-UNIFY-001 Payments integration', () => {
    test('LPU-PAYMENTS-01 · every filter and sort belongs to the 50-row cursor request', () => {
        const hook = read('frontend/src/hooks/usePaymentsPage.ts');

        expect(hook).toContain('useLoadMoreList<PaymentRow, PaymentsPageMeta>');
        expect(hook).toContain('useDebouncedSearch(searchInput, 400)');
        expect(hook).toContain('const PAYMENTS_PAGE_SIZE = 50');
        for (const parameter of [
            "query.set('cursor', cursor)",
            "query.set('payment_method', methodFilter)",
            "query.set('quick_filter', quickFilter)",
            "query.set('search', searchQuery)",
            "query.set('provider', providerFilter)",
            "query.set('paid_status', paidFilter)",
            'sort_by: sortField',
            'sort_order: sortDir',
            '{ signal }',
        ]) {
            expect(hook).toContain(parameter);
        }
        expect(hook).not.toMatch(/limit.*1000|setRows|sortedRows|pagedRows|totalPages|\.slice\(|rows\.filter|rows\.reduce/);
    });

    test('LPU-PAYMENTS-02 · header money and facets are retained server metadata', () => {
        const hook = read('frontend/src/hooks/usePaymentsPage.ts');
        const page = read('frontend/src/pages/PaymentsPage.tsx');

        expect(hook).toContain('aggregates: data.aggregates, facets: data.facets');
        expect(hook).toContain('transactionCount: aggregates?.transaction_count ?? 0');
        expect(hook).toContain("totalAmount: aggregates?.total_amount ?? '0'");
        expect(hook).toContain('uniqueMethods: facets?.payment_methods ?? []');
        expect(hook).toContain('uniqueProviders: facets?.providers ?? []');
        expect(hook).toContain('undepositedCheckCount: facets?.undeposited_check_count ?? 0');
        expect(page).toContain('{pm.transactionCount} transactions');
        expect(page).toContain('formatCurrency(pm.totalAmount)');
        expect(page).not.toMatch(/toFixed\(|sortedRows\.length|totalAmount\.toFixed/);
    });

    test('LPU-PAYMENTS-03 · current responsive shell uses the shared footer with no local pager', () => {
        const page = read('frontend/src/pages/PaymentsPage.tsx');
        const css = read('frontend/src/pages/PaymentsPage.css');

        expect(page).toContain('<LoadMoreFooter {...footerProps} />');
        expect(page).not.toContain('MobileListPage');
        expect(page).not.toMatch(/ChevronLeft|ChevronRight|setPage|pagedRows/);
        expect(css).not.toContain('.payments-pagination');
        expect(page).toContain("singularLabel: 'transaction'");
        expect(page).toContain("pluralLabel: 'transactions'");
    });
});
