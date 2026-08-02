import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppViewPanel, type AppRunSummary } from './AppViewPanel';
import type { ViewDocument } from './AppViewBlocks';
import {
    AppViewApiError,
    type AppRun,
    fetchAppRun,
    fetchAppRuns,
    fetchLatestAppRun,
    runApp,
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
        />
    );
}
