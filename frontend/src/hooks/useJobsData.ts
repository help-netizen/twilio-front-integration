import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { useLeadFormSettings } from '../hooks/useLeadFormSettings';
import { useAuthz } from './useAuthz';
import { useIsMobile } from './useIsMobile';
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
    const { hasPermission } = useAuthz();
    const isMobile = useIsMobile();
    // Tag catalog and list-field settings live under tenant management APIs —
    // don't even request them without the backing permission (PF007).
    const canManageCompany = hasPermission('tenant.company.manage');
    // When the operator can't see lead/job source, drop the job_source column
    // from the table model entirely so it can't be rendered OR column-picked.
    const canViewSource = hasPermission('lead_source.view');

    // ─── Derived data ────────────────────────────────────────────────

    const allColumns = useMemo<Record<string, ColumnDef>>(() => {
        const cols: Record<string, ColumnDef> = { ...STATIC_COLUMNS };
        if (!canViewSource) delete cols.job_source;
        for (const cf of customFields) {
            if (cf.is_system) continue;
            cols[`meta:${cf.api_name}`] = makeMetaColumn(cf.api_name, cf.display_name);
        }
        return cols;
    }, [customFields, canViewSource]);

    const allFieldKeys = useMemo(() => {
        const staticKeys = canViewSource ? STATIC_FIELD_KEYS : STATIC_FIELD_KEYS.filter(k => k !== 'job_source');
        return [...staticKeys, ...customFields.filter(f => !f.is_system).map(f => `meta:${f.api_name}`)];
    }, [customFields, canViewSource]);

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

    // JOBS-MOBILE-001: fetch the NEXT page and APPEND (mobile "Load more").
    // Mirrors loadJobs' param building but never replaces the list — desktop
    // prev/next (loadJobs) is left untouched.
    const loadMoreJobs = useCallback(async () => {
        const nextOffset = offset + LIMIT;
        setLoading(true);
        try {
            const params: JobsListParams = {
                limit: LIMIT,
                offset: nextOffset,
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
            setJobs(prev => [...prev, ...(data.results || [])]);
            setHasMore(data.has_more);
            setTotalCount(data.total);
            setOffset(nextOffset);
        } catch (error) {
            toast.error('Failed to load more jobs', {
                description: error instanceof Error ? error.message : 'Unknown error',
            });
        } finally {
            setLoading(false);
        }
    }, [offset, searchQuery, sortBy, sortOrder, onlyOpen, startDate, endDate, statusFilter, jobTypeFilter, providerFilter, tagFilter]);

    // JOBS-MOBILE-001: on mobile, default the sort to start_date desc on first
    // mount so date-grouped paging is coherent. Runs once and never clobbers a
    // user's later sort change.
    const mobileSortApplied = useRef(false);
    useEffect(() => {
        if (isMobile && !mobileSortApplied.current) {
            mobileSortApplied.current = true;
            setSortBy('start_date');
            setSortOrder('desc');
        }
    }, [isMobile]);

    // Load tag catalog on mount (management API — permission-gated)
    useEffect(() => {
        if (!canManageCompany) return;
        jobsApi.listJobTags().then(setAllTags).catch(() => { });
    }, [canManageCompany]);

    // Load column config on mount (management API — permission-gated)
    useEffect(() => {
        if (!canManageCompany) return;
        jobsApi.getJobsListFields()
            .then(fields => {
                if (fields.length > 0) setVisibleFields(fields);
            })
            .catch(() => { });
    }, [canManageCompany]);

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
        loadMoreJobs,
        saveVisibleFields,
    };
}
