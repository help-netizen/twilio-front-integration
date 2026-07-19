import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
    DEFAULT_VISIBLE_FIELDS,
    STATIC_COLUMNS,
    STATIC_FIELD_KEYS,
    makeMetaColumn,
    type ColumnDef,
} from '../components/jobs/jobHelpers';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { SettingsSection } from '../components/settings/SettingsSection';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { useAuthz } from '../hooks/useAuthz';
import { useLeadFormSettings } from '../hooks/useLeadFormSettings';
import { getJobsListFields, saveJobsListFields } from '../services/jobsApi';

export const JOB_LIST_FIELDS_QUERY_KEY = ['jobs-list-fields'] as const;

function preserveUnavailableFields(
    storedFields: string[],
    editableFields: string[],
    columns: Record<string, ColumnDef>,
): string[] {
    const merged = [...editableFields];
    storedFields.forEach((field, originalIndex) => {
        if (!columns[field] && !merged.includes(field)) {
            merged.splice(Math.min(originalIndex, merged.length), 0, field);
        }
    });
    return merged;
}

export default function JobListColumnsPage() {
    const queryClient = useQueryClient();
    const { hasPermission } = useAuthz();
    const { customFields, isLoading: fieldsLoading } = useLeadFormSettings();
    const canViewSource = hasPermission('lead_source.view');
    const [visibleFields, setVisibleFields] = useState<string[]>(DEFAULT_VISIBLE_FIELDS);

    const allColumns = useMemo<Record<string, ColumnDef>>(() => {
        const columns = { ...STATIC_COLUMNS };
        if (!canViewSource) delete columns.job_source;
        customFields.forEach(field => {
            if (!field.is_system) {
                columns[`meta:${field.api_name}`] = makeMetaColumn(field.api_name, field.display_name);
            }
        });
        return columns;
    }, [canViewSource, customFields]);

    const allFieldKeys = useMemo(() => {
        const staticKeys = canViewSource
            ? STATIC_FIELD_KEYS
            : STATIC_FIELD_KEYS.filter(key => key !== 'job_source');
        return [
            ...staticKeys,
            ...customFields.filter(field => !field.is_system).map(field => `meta:${field.api_name}`),
        ];
    }, [canViewSource, customFields]);

    const columnsQuery = useQuery({
        queryKey: JOB_LIST_FIELDS_QUERY_KEY,
        queryFn: getJobsListFields,
    });

    useEffect(() => {
        if (!columnsQuery.data) return;
        const known = columnsQuery.data.filter(key => allColumns[key]);
        setVisibleFields(known.length > 0 ? known : DEFAULT_VISIBLE_FIELDS.filter(key => allColumns[key]));
    }, [allColumns, columnsQuery.data]);

    const saveMutation = useMutation({
        mutationFn: saveJobsListFields,
        onSuccess: fields => {
            setVisibleFields(fields.filter(key => allColumns[key]));
            queryClient.setQueryData(JOB_LIST_FIELDS_QUERY_KEY, fields);
            toast.success('Job list columns saved');
        },
        onError: (error: Error) => toast.error(error.message || 'Failed to save job list columns'),
    });

    const move = (index: number, direction: -1 | 1) => {
        setVisibleFields(current => {
            const target = index + direction;
            if (target < 0 || target >= current.length) return current;
            const next = [...current];
            [next[index], next[target]] = [next[target], next[index]];
            return next;
        });
    };

    const hiddenFields = allFieldKeys.filter(key => !visibleFields.includes(key));
    const loading = fieldsLoading || columnsQuery.isLoading;

    return (
        <SettingsPageShell
            title="Job list columns"
            description="Choose and order the columns shown in the company Jobs list."
        >
            <SettingsSection
                title="Visible columns"
                description="Checked fields appear from top to bottom here and from left to right in the Jobs list."
                footer={
                    <Button
                        onClick={() => saveMutation.mutate(preserveUnavailableFields(
                            columnsQuery.data ?? [],
                            visibleFields,
                            allColumns,
                        ))}
                        disabled={loading || columnsQuery.isError || saveMutation.isPending || visibleFields.length === 0}
                    >
                        {saveMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />} Save
                    </Button>
                }
            >
                {loading ? (
                    <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                        <Loader2 className="size-4 animate-spin" /> Loading columns…
                    </div>
                ) : columnsQuery.isError ? (
                    <div className="space-y-3">
                        <p className="text-sm" style={{ color: 'var(--blanc-danger)' }}>Could not load the column configuration.</p>
                        <Button variant="outline" size="sm" onClick={() => columnsQuery.refetch()}>Try again</Button>
                    </div>
                ) : (
                    <div className="space-y-5">
                        <div className="space-y-1">
                            {visibleFields.map((key, index) => {
                                const column = allColumns[key];
                                if (!column) return null;
                                return (
                                    <div key={key} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-[var(--blanc-field)]">
                                        <Checkbox
                                            checked
                                            aria-label={`Hide ${column.label}`}
                                            onCheckedChange={() => setVisibleFields(current => current.filter(field => field !== key))}
                                        />
                                        <span className="flex-1 text-sm" style={{ color: 'var(--blanc-ink-1)' }}>{column.label}</span>
                                        <button
                                            type="button"
                                            aria-label={`Move ${column.label} up`}
                                            disabled={index === 0}
                                            className="rounded-md p-1 disabled:opacity-30"
                                            onClick={() => move(index, -1)}
                                        >
                                            <ArrowUp className="size-4" />
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={`Move ${column.label} down`}
                                            disabled={index === visibleFields.length - 1}
                                            className="rounded-md p-1 disabled:opacity-30"
                                            onClick={() => move(index, 1)}
                                        >
                                            <ArrowDown className="size-4" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>

                        {hiddenFields.length > 0 && (
                            <div className="space-y-1">
                                <div className="blanc-eyebrow px-2">Hidden</div>
                                {hiddenFields.map(key => (
                                    <label key={key} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-[var(--blanc-field)]">
                                        <Checkbox
                                            checked={false}
                                            aria-label={`Show ${allColumns[key].label}`}
                                            onCheckedChange={() => setVisibleFields(current => [...current, key])}
                                        />
                                        <span className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>{allColumns[key].label}</span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </SettingsSection>
        </SettingsPageShell>
    );
}
