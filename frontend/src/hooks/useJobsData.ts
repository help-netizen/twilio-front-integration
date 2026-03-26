import { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { useLeadFormSettings } from '../hooks/useLeadFormSettings';
import * as jobsApi from '../services/jobsApi';
import type { LocalJob, JobsListParams, JobTag } from '../services/jobsApi';
import {
    STATIC_COLUMNS, STATIC_FIELD_KEYS, DEFAULT_VISIBLE_FIELDS,
    makeMetaColumn, type ColumnDef,
} from '../components/jobs/jobHelpers';

// ─── Constants ───────────────────────────────────────────────────────────────

export const LIMIT = 50;

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useJobsData() {
    const [jobs, setJobs] = useState<LocalJob[]>([]);
    const [loading, setLoading] = useState(true);
    const [totalCount, setTotalCount] = useState(0);

    // Filters
    const [searchQuery, setSearchQuery] = useState('');
    const [offset, setOffset] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [statusFilter, setStatusFilter] = useState<string[]>([]);
    const [providerFilter, setProviderFilter] = useState<string[]>([]);
    const [sourceFilter, setSourceFilter] = useState<string[]>([]);
    const [jobTypeFilter, setJobTypeFilter] = useState<string[]>([]);
    const [tagFilter, setTagFilter] = useState<number[]>([]);
    const [onlyOpen, setOnlyOpen] = useState(false);
    const [startDate, setStartDate] = useState<string | undefined>(undefined);
    const [endDate, setEndDate] = useState<string | undefined>(undefined);

    // Tag catalog
    const [allTags, setAllTags] = useState<JobTag[]>([]);

    // Sort
    const [sortBy, setSortBy] = useState<string>('created_at');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

    // Column config
    const [visibleFields, setVisibleFields] = useState<string[]>(DEFAULT_VISIBLE_FIELDS);

    // Custom fields from shared settings hook
    const { customFields } = useLeadFormSettings();

    // ─── Derived data ────────────────────────────────────────────────

    const allColumns = useMemo<Record<string, ColumnDef>>(() => {
        const cols: Record<string, ColumnDef> = { ...STATIC_COLUMNS };
        for (const cf of customFields) {
            if (cf.is_system) continue;
            cols[`meta:${cf.api_name}`] = makeMetaColumn(cf.api_name, cf.display_name);
        }
        return cols;
    }, [customFields]);

    const allFieldKeys = useMemo(() => {
        return [...STATIC_FIELD_KEYS, ...customFields.filter(f => !f.is_system).map(f => `meta:${f.api_name}`)];
    }, [customFields]);

    const filteredJobs = useMemo(() => {
        let result = jobs;
        if (sourceFilter.length > 0) {
            result = result.filter(j => j.job_source && sourceFilter.includes(j.job_source));
        }
        return result;
    }, [jobs, sourceFilter]);

    // ─── Data Loading ────────────────────────────────────────────────

    const loadJobs = useCallback(async (newOffset = 0) => {
        setLoading(true);
        try {
            const params: JobsListParams = {
                limit: LIMIT,
                offset: newOffset,
            };
            if (searchQuery.trim()) params.search = searchQuery.trim();
            if (sortBy) params.sort_by = sortBy;
            if (sortOrder) params.sort_order = sortOrder;
            if (onlyOpen) params.only_open = true;
            if (startDate) params.start_date = startDate;
            if (endDate) params.end_date = endDate;
            if (statusFilter.length > 0) params.blanc_status = statusFilter.join(',');
            if (jobTypeFilter.length > 0) params.service_name = jobTypeFilter.join(',');
            if (providerFilter.length > 0) params.provider = providerFilter.join(',');
            if (tagFilter.length > 0) params.tag_ids = tagFilter.join(',');

            const data = await jobsApi.listJobs(params);
            setJobs(data.results || []);
            setHasMore(data.has_more);
            setTotalCount(data.total);
            setOffset(newOffset);
        } catch (error) {
            toast.error('Failed to load jobs', {
                description: error instanceof Error ? error.message : 'Unknown error',
            });
        } finally {
            setLoading(false);
        }
    }, [searchQuery, sortBy, sortOrder, onlyOpen, startDate, endDate, statusFilter, jobTypeFilter, providerFilter, tagFilter]);

    // Load tag catalog on mount
    useEffect(() => {
        jobsApi.listJobTags().then(setAllTags).catch(() => { });
    }, []);

    // Load column config on mount
    useEffect(() => {
        jobsApi.getJobsListFields()
            .then(fields => {
                if (fields.length > 0) setVisibleFields(fields);
            })
            .catch(() => { });
    }, []);

    useEffect(() => { loadJobs(0); }, [loadJobs]);

    // Sort handler
    const handleSortChange = (field: string, order: 'asc' | 'desc') => {
        setSortBy(field);
        setSortOrder(order);
    };

    // Column config save
    const saveVisibleFields = async (fields: string[]) => {
        await jobsApi.saveJobsListFields(fields);
        setVisibleFields(fields);
    };

    return {
        // Data
        jobs, setJobs,
        filteredJobs,
        loading,
        totalCount,
        offset,
        hasMore,
        allTags,
        allColumns,
        allFieldKeys,
        visibleFields,

        // Filters
        searchQuery, setSearchQuery,
        statusFilter, setStatusFilter,
        providerFilter, setProviderFilter,
        sourceFilter, setSourceFilter,
        jobTypeFilter, setJobTypeFilter,
        tagFilter, setTagFilter,
        onlyOpen, setOnlyOpen,
        startDate, setStartDate,
        endDate, setEndDate,

        // Sort
        sortBy,
        sortOrder,
        handleSortChange,

        // Actions
        loadJobs,
        saveVisibleFields,
    };
}
