import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { authedFetch } from '../services/apiClient';
import type {
    PaymentRow,
    PaymentDetail,
    PaymentsListAggregates,
    PaymentsListFacets,
    PaymentsListResult,
    SortField,
    SortDir,
} from '../components/payments/paymentTypes';
import { defaultDateFrom, defaultDateTo } from '../components/payments/paymentTypes';
import { exportPaymentsCSV } from './paymentExport';
import { useAuthz } from './useAuthz';
import { useDebouncedSearch } from './useDebouncedSearch';
import { useLoadMoreList } from './useLoadMoreList';

const API_BASE = import.meta.env.VITE_API_URL || '';
const PAYMENTS_PAGE_SIZE = 50;
const paymentKey = (payment: PaymentRow) => payment.id;

interface PaymentsPageMeta {
    aggregates: PaymentsListAggregates;
    facets: PaymentsListFacets;
}

/**
 * What the detail panel must do when the URL says one payment and another one
 * (or none) is loaded.
 *
 * This lived inline as `parsedId !== selectedId`, comparing the selection to a
 * value seeded from the same URL — so on a direct link the two were equal on
 * the first render and the load never happened. The panel then reported
 * "Unable to load payment details" without ever having asked for them, while
 * the same card opened from the list because the click fetched imperatively.
 */
export function nextDetailAction(
    wantedId: number | null,
    loadedId: number | null
): 'clear' | 'load' | 'skip' {
    if (wantedId === null) return 'clear';
    return wantedId === loadedId ? 'skip' : 'load';
}

export function usePaymentsPage() {
    const { paymentId: urlPaymentId } = useParams<{ paymentId?: string }>();
    const navigate = useNavigate();
    const { company } = useAuthz();
    const [dateFrom, setDateFrom] = useState(defaultDateFrom);
    const [dateTo, setDateTo] = useState(defaultDateTo);
    const [methodFilter, setMethodFilter] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const searchQuery = useDebouncedSearch(searchInput, 400);
    const [sortField, setSortField] = useState<SortField>('payment_date');
    const [sortDir, setSortDir] = useState<SortDir>('desc');
    // The URL is the only source of truth for which payment is open. Seeding a
    // separate selectedId from it and then comparing the two meant a direct link
    // never fetched: the values were already equal on the first render, so the
    // guard skipped the load and the panel said "Unable to load payment details"
    // while the same card opened fine from the list, which fetched imperatively.
    const selectedId = urlPaymentId ? parseInt(urlPaymentId, 10) || null : null;
    const loadedIdRef = useRef<number | null>(null);
    const [detail, setDetail] = useState<PaymentDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [providerFilter, setProviderFilter] = useState('');
    const [paidFilter, setPaidFilter] = useState<'' | 'paid' | 'due'>('');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [datePickerOpen, setDatePickerOpen] = useState(false);
    const [quickFilter, setQuickFilter] = useState<'all' | 'new_checks'>('all');
    const filterRef = useRef<HTMLDivElement>(null);
    const [exporting, setExporting] = useState(false);

    useEffect(() => {
        const handler = (event: MouseEvent) => {
            if (filterRef.current && !filterRef.current.contains(event.target as Node)) {
                setFiltersOpen(false);
            }
        };
        if (filtersOpen) document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [filtersOpen]);

    const paymentsList = useLoadMoreList<PaymentRow, PaymentsPageMeta>({
        queryKey: [
            'payments-list',
            company?.id ?? null,
            dateFrom,
            dateTo,
            methodFilter,
            searchQuery,
            providerFilter,
            paidFilter,
            quickFilter,
            sortField,
            sortDir,
        ],
        pageSize: PAYMENTS_PAGE_SIZE,
        enabled: !!company?.id && !!dateFrom && !!dateTo,
        fetchPage: async ({ cursor, limit, signal }) => {
            const query = new URLSearchParams({
                date_from: dateFrom,
                date_to: dateTo,
                limit: String(limit),
                sort_by: sortField,
                sort_order: sortDir,
            });
            if (cursor) query.set('cursor', cursor);
            if (methodFilter) query.set('payment_method', methodFilter);
            if (quickFilter !== 'all') query.set('quick_filter', quickFilter);
            if (searchQuery) query.set('search', searchQuery);
            if (providerFilter) query.set('provider', providerFilter);
            if (paidFilter) query.set('paid_status', paidFilter);

            const response = await authedFetch(
                `${API_BASE}/api/payments?${query.toString()}`,
                { signal },
            );
            const json = await response.json() as {
                ok?: boolean;
                data?: PaymentsListResult;
                error?: string | { message?: string };
            };
            if (!response.ok || !json.ok || !json.data) {
                const message = typeof json.error === 'string' ? json.error : json.error?.message;
                throw new Error(message || `Request failed (${response.status})`);
            }

            const data = json.data;
            return {
                items: data.rows || [],
                pagination: {
                    ...data.pagination,
                    mode: 'cursor' as const,
                },
                meta: data.aggregates && data.facets
                    ? { aggregates: data.aggregates, facets: data.facets }
                    : null,
            };
        },
        getItemKey: paymentKey,
    });

    const fetchDetail = useCallback(async (paymentId: number) => {
        setDetailLoading(true);
        try {
            const response = await authedFetch(`${API_BASE}/api/payments/${paymentId}?view=ledger`);
            const json = await response.json();
            if (!response.ok || !json.ok) throw new Error(json.error || 'Failed to load detail');
            setDetail(json.data);
        } catch {
            setDetail(null);
        } finally {
            setDetailLoading(false);
        }
    }, []);

    // Both entry points do the same thing — change the URL. The effect below is
    // the single place that loads, so a deep link, a click and the back button
    // all travel the one path that is actually exercised.
    const handleSelectRow = (paymentId: number) => {
        navigate(`/payments/${paymentId}`, { replace: true });
    };
    const handleCloseDetail = () => {
        navigate('/payments', { replace: true });
    };

    const handleToggleDeposited = useCallback(async (deposited: boolean) => {
        if (!detail || !selectedId) return;
        try {
            const response = await authedFetch(`${API_BASE}/api/payments/${selectedId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ check_deposited: deposited }),
            });
            const json = await response.json();
            if (!response.ok || !json.ok) throw new Error(json.error || 'Failed');
            setDetail(previous => previous ? { ...previous, check_deposited: deposited } : previous);
            paymentsList.updateItem(selectedId, row => ({ ...row, check_deposited: deposited }));
            await paymentsList.reset();
        } catch (error) {
            console.error('Toggle deposited error:', error);
        }
    }, [detail, paymentsList.reset, paymentsList.updateItem, selectedId]);

    useEffect(() => {
        const action = nextDetailAction(selectedId, loadedIdRef.current);
        if (action === 'skip') return;
        if (action === 'clear') {
            loadedIdRef.current = null;
            setDetail(null);
            return;
        }
        loadedIdRef.current = selectedId;
        void fetchDetail(selectedId as number);
    }, [fetchDetail, selectedId]);

    const handleSort = (field: SortField) => {
        if (sortField === field) setSortDir(direction => direction === 'asc' ? 'desc' : 'asc');
        else {
            setSortField(field);
            setSortDir('desc');
        }
    };

    const activeFilterCount = (methodFilter ? 1 : 0) + (providerFilter ? 1 : 0) + (paidFilter ? 1 : 0);
    const clearAllFilters = () => {
        setMethodFilter('');
        setProviderFilter('');
        setPaidFilter('');
    };

    const handleExportCSV = async () => {
        setExporting(true);
        try {
            await exportPaymentsCSV(dateFrom, dateTo);
        } catch (error) {
            console.error('Export error:', error);
        } finally {
            setExporting(false);
        }
    };

    const aggregates = paymentsList.meta?.aggregates ?? null;
    const facets = paymentsList.meta?.facets ?? null;

    return {
        rows: paymentsList.items,
        loading: paymentsList.isLoadingFirst,
        listState: paymentsList.state,
        listErrorPhase: paymentsList.errorPhase,
        loadMore: paymentsList.loadMore,
        retry: paymentsList.retry,
        hasSummary: aggregates !== null,
        transactionCount: aggregates?.transaction_count ?? 0,
        totalAmount: aggregates?.total_amount ?? '0',

        dateFrom, setDateFrom,
        dateTo, setDateTo,
        methodFilter, setMethodFilter,
        searchInput, setSearchInput,
        providerFilter, setProviderFilter,
        paidFilter, setPaidFilter,
        filtersOpen, setFiltersOpen,
        datePickerOpen, setDatePickerOpen,
        quickFilter, setQuickFilter,
        filterRef,
        uniqueMethods: facets?.payment_methods ?? [],
        uniqueProviders: facets?.providers ?? [],
        activeFilterCount,
        clearAllFilters,
        undepositedCheckCount: facets?.undeposited_check_count ?? 0,

        sortField,
        sortDir,
        handleSort,
        selectedId,
        detail,
        detailLoading,
        handleSelectRow,
        handleCloseDetail,
        handleToggleDeposited,

        exporting,
        handleExportCSV,
    };
}
