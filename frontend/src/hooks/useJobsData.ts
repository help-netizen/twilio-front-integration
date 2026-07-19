import { useEffect, useMemo, useState } from 'react';
import { useLeadFormSettings } from '../hooks/useLeadFormSettings';
import { useAuthz } from './useAuthz';
import { useDebouncedSearch } from './useDebouncedSearch';
import { useLoadMoreList } from './useLoadMoreList';
import * as jobsApi from '../services/jobsApi';
import type { JobsListFacets, JobsListParams, JobTag, LocalJob } from '../services/jobsApi';
import {
    STATIC_COLUMNS, STATIC_FIELD_KEYS, DEFAULT_VISIBLE_FIELDS,
    makeMetaColumn, type ColumnDef,
} from '../components/jobs/jobHelpers';

export const LIMIT = 50;
const jobKey = (job: LocalJob) => job.id;

export function useJobsData() {
    const [searchQuery, setSearchQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<string[]>([]);
    const [providerFilter, setProviderFilter] = useState<string[]>([]);
    const [sourceFilter, setSourceFilter] = useState<string[]>([]);
    const [jobTypeFilter, setJobTypeFilter] = useState<string[]>([]);
    const [tagFilter, setTagFilter] = useState<number[]>([]);
    const [onlyOpen, setOnlyOpen] = useState(false);
    const [startDate, setStartDate] = useState<string | undefined>(undefined);
    const [endDate, setEndDate] = useState<string | undefined>(undefined);
    const [allTags, setAllTags] = useState<JobTag[]>([]);
    const [sortBy, setSortBy] = useState<string>('start_date');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
    const [visibleFields, setVisibleFields] = useState<string[]>(DEFAULT_VISIBLE_FIELDS);

    const { customFields } = useLeadFormSettings();
    const { company, user, membership, hasPermission } = useAuthz();
    const canManageCompany = hasPermission('tenant.company.manage');
    const canViewSource = hasPermission('lead_source.view');
    const debouncedSearch = useDebouncedSearch(searchQuery, 300);

    const allColumns = useMemo<Record<string, ColumnDef>>(() => {
        const columns: Record<string, ColumnDef> = { ...STATIC_COLUMNS };
        if (!canViewSource) delete columns.job_source;
        for (const customField of customFields) {
            if (customField.is_system) continue;
            columns[`meta:${customField.api_name}`] = makeMetaColumn(customField.api_name, customField.display_name);
        }
        return columns;
    }, [customFields, canViewSource]);

    const allFieldKeys = useMemo(() => {
        const staticKeys = canViewSource
            ? STATIC_FIELD_KEYS
            : STATIC_FIELD_KEYS.filter(key => key !== 'job_source');
        return [
            ...staticKeys,
            ...customFields
                .filter(field => !field.is_system)
                .map(field => `meta:${field.api_name}`),
        ];
    }, [customFields, canViewSource]);

    const normalizedStatuses = [...statusFilter].sort();
    const normalizedProviders = [...providerFilter].sort();
    const normalizedSources = [...sourceFilter].sort();
    const normalizedJobTypes = [...jobTypeFilter].sort();
    const normalizedTagIds = [...tagFilter].sort((left, right) => left - right);

    const jobsList = useLoadMoreList<LocalJob, JobsListFacets>({
        queryKey: [
            'jobs-list',
            company?.id ?? null,
            user?.sub ?? null,
            membership?.role_key ?? null,
            debouncedSearch,
            normalizedStatuses,
            normalizedProviders,
            normalizedSources,
            normalizedJobTypes,
            normalizedTagIds,
            onlyOpen,
            startDate ?? null,
            endDate ?? null,
            sortBy,
            sortOrder,
        ],
        pageSize: LIMIT,
        enabled: !!company?.id,
        fetchPage: async ({ cursor, limit, signal }) => {
            const params: JobsListParams = {
                limit,
                cursor: cursor ?? undefined,
                search: debouncedSearch || undefined,
                sort_by: sortBy,
                sort_order: sortOrder,
                only_open: onlyOpen || undefined,
                start_date: startDate,
                end_date: endDate,
                blanc_status: normalizedStatuses.length > 0 ? normalizedStatuses.join(',') : undefined,
                service_name: normalizedJobTypes.length > 0 ? normalizedJobTypes.join(',') : undefined,
                job_source: normalizedSources.length > 0 ? normalizedSources.join(',') : undefined,
                provider: normalizedProviders.length > 0 ? normalizedProviders.join(',') : undefined,
                tag_ids: normalizedTagIds.length > 0 ? normalizedTagIds.join(',') : undefined,
            };
            const data = await jobsApi.listJobs(params, signal);
            return {
                items: data.results || [],
                pagination: {
                    ...data.pagination,
                    mode: 'cursor' as const,
                },
                meta: data.facets,
            };
        },
        getItemKey: jobKey,
    });

    useEffect(() => {
        if (!canManageCompany) return;
        jobsApi.listJobTags().then(setAllTags).catch(() => { });
    }, [canManageCompany]);

    useEffect(() => {
        if (!canManageCompany) return;
        jobsApi.getJobsListFields()
            .then(fields => {
                if (fields.length > 0) setVisibleFields(fields);
            })
            .catch(() => { });
    }, [canManageCompany]);

    const handleSortChange = (field: string, order: 'asc' | 'desc') => {
        setSortBy(field);
        setSortOrder(order);
    };

    const saveVisibleFields = async (fields: string[]) => {
        await jobsApi.saveJobsListFields(fields);
        setVisibleFields(fields);
    };

    return {
        jobs: jobsList.items,
        loading: jobsList.isLoadingFirst,
        totalCount: jobsList.total ?? 0,
        listState: jobsList.state,
        listErrorPhase: jobsList.errorPhase,
        providerNames: jobsList.meta?.providers ?? [],
        allTags,
        allColumns,
        allFieldKeys,
        visibleFields,

        searchQuery, setSearchQuery,
        statusFilter, setStatusFilter,
        providerFilter, setProviderFilter,
        sourceFilter, setSourceFilter,
        jobTypeFilter, setJobTypeFilter,
        tagFilter, setTagFilter,
        onlyOpen, setOnlyOpen,
        startDate, setStartDate,
        endDate, setEndDate,

        sortBy,
        sortOrder,
        handleSortChange,

        loadMoreJobs: jobsList.loadMore,
        retryJobs: jobsList.retry,
        resetJobs: jobsList.reset,
        updateJob: jobsList.updateItem,
        saveVisibleFields,
    };
}
