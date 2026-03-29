/**
 * useEstimates — state management hook for the Estimates page.
 */

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import * as estimatesApi from '../services/estimatesApi';
import type {
    Estimate,
    EstimatesListParams,
    EstimatesListResult,
    EstimateCreateData,
    EstimateSendData,
    EstimateEvent,
} from '../services/estimatesApi';

export interface EstimateFilters {
    status: string;
    search: string;
    page: number;
    limit: number;
}

const DEFAULT_FILTERS: EstimateFilters = {
    status: '',
    search: '',
    page: 1,
    limit: 50,
};

export function useEstimates() {
    const [estimates, setEstimates] = useState<Estimate[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedEstimate, setSelectedEstimate] = useState<Estimate | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [filters, setFilters] = useState<EstimateFilters>(DEFAULT_FILTERS);
    const [total, setTotal] = useState(0);
    const [events, setEvents] = useState<EstimateEvent[]>([]);

    // ── Load list ────────────────────────────────────────────────────────────
    const loadEstimates = useCallback(async (overrideFilters?: Partial<EstimateFilters>) => {
        setLoading(true);
        setError(null);
        try {
            const f = { ...filters, ...overrideFilters };
            const params: EstimatesListParams = {
                page: f.page,
                limit: f.limit,
            };
            if (f.status) params.status = f.status;
            if (f.search) params.search = f.search;

            const result: EstimatesListResult = await estimatesApi.fetchEstimates(params);
            setEstimates(result.estimates);
            setTotal(result.total);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to load estimates';
            setError(msg);
            toast.error('Failed to load estimates', { description: msg });
        } finally {
            setLoading(false);
        }
    }, [filters]);

    useEffect(() => {
        loadEstimates();
    }, [filters.status, filters.search, filters.page, filters.limit]);

    // ── Select / detail ──────────────────────────────────────────────────────
    const selectEstimate = useCallback(async (id: number) => {
        setDetailLoading(true);
        try {
            const estimate = await estimatesApi.fetchEstimate(id);
            setSelectedEstimate(estimate);
            // load events
            const evts = await estimatesApi.fetchEstimateEvents(id);
            setEvents(evts);
        } catch (err) {
            toast.error('Failed to load estimate details');
        } finally {
            setDetailLoading(false);
        }
    }, []);

    const closeDetail = useCallback(() => {
        setSelectedEstimate(null);
        setEvents([]);
    }, []);

    // ── CRUD ─────────────────────────────────────────────────────────────────
    const handleCreateEstimate = useCallback(async (data: EstimateCreateData) => {
        const estimate = await estimatesApi.createEstimate(data);
        toast.success('Estimate created');
        await loadEstimates();
        return estimate;
    }, [loadEstimates]);

    const handleUpdateEstimate = useCallback(async (id: number, data: Partial<EstimateCreateData>) => {
        const estimate = await estimatesApi.updateEstimate(id, data);
        toast.success('Estimate updated');
        await loadEstimates();
        if (selectedEstimate?.id === id) {
            setSelectedEstimate(estimate);
        }
        return estimate;
    }, [loadEstimates, selectedEstimate]);

    const handleDeleteEstimate = useCallback(async (id: number) => {
        await estimatesApi.deleteEstimate(id);
        toast.success('Estimate deleted');
        if (selectedEstimate?.id === id) {
            setSelectedEstimate(null);
            setEvents([]);
        }
        await loadEstimates();
    }, [loadEstimates, selectedEstimate]);

    // ── Actions ──────────────────────────────────────────────────────────────
    const handleSendEstimate = useCallback(async (id: number, data: EstimateSendData) => {
        const estimate = await estimatesApi.sendEstimate(id, data);
        toast.success('Estimate sent');
        await loadEstimates();
        if (selectedEstimate?.id === id) {
            setSelectedEstimate(estimate);
        }
        return estimate;
    }, [loadEstimates, selectedEstimate]);

    const handleApproveEstimate = useCallback(async (id: number) => {
        const estimate = await estimatesApi.approveEstimate(id);
        toast.success('Estimate approved');
        await loadEstimates();
        if (selectedEstimate?.id === id) {
            setSelectedEstimate(estimate);
        }
    }, [loadEstimates, selectedEstimate]);

    const handleDeclineEstimate = useCallback(async (id: number) => {
        const estimate = await estimatesApi.declineEstimate(id);
        toast.success('Estimate declined');
        await loadEstimates();
        if (selectedEstimate?.id === id) {
            setSelectedEstimate(estimate);
        }
    }, [loadEstimates, selectedEstimate]);

    const handleLinkJob = useCallback(async (id: number, jobId: number) => {
        const estimate = await estimatesApi.linkJobToEstimate(id, jobId);
        toast.success('Job linked to estimate');
        await loadEstimates();
        if (selectedEstimate?.id === id) {
            setSelectedEstimate(estimate);
        }
    }, [loadEstimates, selectedEstimate]);

    // ── Filter helpers ───────────────────────────────────────────────────────
    const setStatus = useCallback((status: string) => {
        setFilters(f => ({ ...f, status, page: 1 }));
    }, []);

    const setSearch = useCallback((search: string) => {
        setFilters(f => ({ ...f, search, page: 1 }));
    }, []);

    const setPage = useCallback((page: number) => {
        setFilters(f => ({ ...f, page }));
    }, []);

    // ── Pagination ───────────────────────────────────────────────────────────
    const totalPages = Math.ceil(total / filters.limit) || 1;

    return {
        estimates,
        loading,
        error,
        selectedEstimate,
        detailLoading,
        filters,
        total,
        totalPages,
        events,
        loadEstimates,
        selectEstimate,
        closeDetail,
        handleCreateEstimate,
        handleUpdateEstimate,
        handleDeleteEstimate,
        handleSendEstimate,
        handleApproveEstimate,
        handleDeclineEstimate,
        handleLinkJob,
        setStatus,
        setSearch,
        setPage,
    };
}
