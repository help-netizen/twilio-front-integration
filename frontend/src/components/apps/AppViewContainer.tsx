import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppViewPanel, type AppRunSummary } from './AppViewPanel';
import { AppScheduleEditor } from './AppSchedule';
import type { ViewDocument } from './AppViewBlocks';
import {
    AppViewApiError,
    type AppRun,
    type Cadence,
    acceptAppVersion,
    fetchAppRun,
    fetchAppRuns,
    fetchAppSchedule,
    fetchLatestAppRun,
    runApp,
    saveAppSchedule,
} from '../../services/appViewsApi';

export interface AppViewContainerProps {
    installationId: number;
    appName: string;
    tools?: string[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

/** A stored result is shown the moment the panel opens, so the app never
 *  greets its user with a spinner when it already has an answer. */
function headline(run: AppRun): string | null {
    const first = run.view_document?.blocks?.find(block => block.type === 'stat_row');
    if (first && first.type === 'stat_row') return first.items[0]?.value ?? null;
    return null;
}

export function AppViewContainer({ installationId, appName, tools = [], open, onOpenChange }: AppViewContainerProps) {
    const queryClient = useQueryClient();
    const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) { setSelectedRunId(null); setError(null); }
    }, [open]);

    const latest = useQuery({
        queryKey: ['app-run-latest', installationId],
        queryFn: () => fetchLatestAppRun(installationId),
        enabled: open,
    });

    const history = useQuery({
        queryKey: ['app-runs', installationId],
        queryFn: () => fetchAppRuns(installationId),
        enabled: open,
    });

    const selected = useQuery({
        queryKey: ['app-run', installationId, selectedRunId],
        queryFn: () => fetchAppRun(installationId, selectedRunId as string),
        enabled: open && Boolean(selectedRunId),
    });

    const schedule = useQuery({
        queryKey: ['app-schedule', installationId],
        queryFn: () => fetchAppSchedule(installationId),
        enabled: open,
    });

    const invalidateSchedule = () => queryClient.invalidateQueries({
        queryKey: ['app-schedule', installationId],
    });

    const saveSchedule = useMutation({
        mutationFn: (body: { enabled: boolean; cadence: Cadence | null }) => saveAppSchedule(installationId, body),
        onMutate: () => setError(null),
        onSuccess: invalidateSchedule,
        onError: (failure: unknown) => setError(
            failure instanceof AppViewApiError ? failure.message : 'The schedule could not be saved.'
        ),
    });

    const acceptVersion = useMutation({
        mutationFn: (versionId: string) => acceptAppVersion(installationId, versionId),
        onMutate: () => setError(null),
        onSuccess: () => {
            invalidateSchedule();
            queryClient.invalidateQueries({ queryKey: ['app-run-latest', installationId] });
        },
        onError: (failure: unknown) => setError(
            failure instanceof AppViewApiError ? failure.message : 'This version could not be accepted.'
        ),
    });

    const run = useMutation({
        mutationFn: () => runApp(installationId),
        onMutate: () => setError(null),
        onSuccess: () => {
            setSelectedRunId(null);
            queryClient.invalidateQueries({ queryKey: ['app-run-latest', installationId] });
            queryClient.invalidateQueries({ queryKey: ['app-runs', installationId] });
        },
        onError: (failure: unknown) => {
            setError(failure instanceof AppViewApiError ? failure.message : 'This app could not be run.');
        },
    });

    const shown: AppRun | null | undefined = selectedRunId ? selected.data : latest.data;
    const document = (shown?.view_document as ViewDocument | undefined) || null;

    const runs: AppRunSummary[] = (history.data || []).map(entry => ({
        id: entry.run_id,
        started_at: entry.started_at,
        wall_ms: entry.duration_ms,
        gateway_calls: entry.gateway_calls,
        result_bytes: entry.result_bytes,
        error_code: entry.error_code,
        headline: null,
    }));

    return (
        <AppViewPanel
            open={open}
            onOpenChange={onOpenChange}
            appName={appName}
            tools={tools}
            document={document}
            lastRunAt={shown?.completed_at || shown?.started_at || null}
            lastWallMs={shown?.duration_ms ?? null}
            running={run.isPending || latest.isLoading || selected.isFetching}
            error={error || (shown?.error_message ?? null)}
            history={runs.map(entry => ({
                ...entry,
                headline: shown && entry.id === shown.run_id ? headline(shown) : null,
            }))}
            onRun={() => run.mutate()}
            onSelectRun={setSelectedRunId}
            schedule={schedule.data && (
                <AppScheduleEditor
                    schedule={schedule.data.schedule}
                    saving={saveSchedule.isPending}
                    onSave={body => saveSchedule.mutate(body)}
                />
            )}
            updateBanner={schedule.data?.version?.update_available && schedule.data.version.available && (
                <div
                    className="flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3"
                    style={{ background: 'var(--blanc-accent-soft)' }}
                >
                    <span className="text-sm" style={{ color: 'var(--blanc-ink-1)' }}>
                        Version {schedule.data.version.available.version_number.replace(/^builder-/, '')} is
                        approved and ready. It runs the old one until you accept.
                    </span>
                    <button
                        type="button"
                        className="ml-auto rounded-lg px-3 py-1.5 text-xs font-semibold"
                        style={{ background: 'var(--blanc-accent)', color: '#fff' }}
                        disabled={acceptVersion.isPending}
                        onClick={() => acceptVersion.mutate(schedule.data!.version.available!.version_id)}
                    >
                        Accept
                    </button>
                </div>
            )}
        />
    );
}
