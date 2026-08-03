import { useState } from 'react';
import { CalendarClock, History, Loader2, RefreshCw } from 'lucide-react';
import { Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle, DialogDescription } from '../ui/dialog';
import { Button } from '../ui/button';
import { AppViewDocument, type ViewDocument } from './AppViewBlocks';

/**
 * The screen of an installed app (APP-VIEW-001 §6). It belongs to the app, not
 * to App Studio: once a version is published the author's chat is irrelevant to
 * whoever opens this.
 */

export interface AppRunSummary {
    id: string;
    started_at: string;
    wall_ms: number | null;
    gateway_calls: number | null;
    result_bytes: number | null;
    error_code: string | null;
    headline: string | null;
}

export interface AppViewPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    appName: string;
    tools: string[];
    document: ViewDocument | null;
    lastRunAt: string | null;
    lastWallMs: number | null;
    running: boolean;
    error: string | null;
    history: AppRunSummary[];
    onRun: () => void;
    onSelectRun: (runId: string) => void;
    onAction?: (actionId: string, rowKey: string) => void;
    /** Phase B: the schedule editor, and the banner offering a newer approved version. */
    schedule?: React.ReactNode;
    updateBanner?: React.ReactNode;
}

function relativeTime(iso: string | null): string | null {
    if (!iso) return null;
    const elapsed = Date.now() - Date.parse(iso);
    if (!Number.isFinite(elapsed)) return null;
    const minutes = Math.round(elapsed / 60000);
    if (minutes < 1) return 'Updated just now';
    if (minutes < 60) return `Updated ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `Updated ${hours} hour${hours === 1 ? '' : 's'} ago`;
    return `Updated ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function seconds(ms: number | null): string | null {
    return ms === null || ms === undefined ? null : `${(ms / 1000).toFixed(1)} s`;
}

function RunHistory({ history, onSelectRun }: { history: AppRunSummary[]; onSelectRun: (runId: string) => void }) {
    if (!history.length) {
        return <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>This app has not run yet.</p>;
    }
    return (
        <div>
            {history.map((run, index) => (
                <button
                    key={run.id}
                    type="button"
                    onClick={() => onSelectRun(run.id)}
                    className="flex w-full items-center gap-3 py-3 text-left"
                    style={index > 0 ? { borderTop: '1px solid var(--blanc-line)' } : undefined}
                >
                    <div className="min-w-0">
                        <div className="text-sm">
                            {new Date(run.started_at).toLocaleString('en-US', {
                                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                            })}
                        </div>
                        <div className="mt-0.5 text-xs tabular-nums" style={{ color: 'var(--blanc-ink-3)' }}>
                            {run.error_code
                                ? 'Stopped'
                                : [seconds(run.wall_ms), run.gateway_calls === null ? null : `${run.gateway_calls} calls`]
                                    .filter(Boolean).join(' · ')}
                        </div>
                    </div>
                    <span
                        className="ml-auto text-[13px] font-semibold tabular-nums"
                        style={{ color: run.error_code ? 'var(--blanc-danger)' : 'var(--blanc-success)' }}
                    >
                        {run.error_code ? 'Failed' : (run.headline || 'Done')}
                    </span>
                </button>
            ))}
        </div>
    );
}

type PanelView = 'result' | 'history' | 'schedule';

export function AppViewPanel({
    open, onOpenChange, appName, tools, document, lastRunAt, lastWallMs,
    running, error, history, onRun, onSelectRun, onAction, schedule, updateBanner,
}: AppViewPanelProps) {
    const [view, setView] = useState<PanelView>('result');
    const showHistory = view === 'history';
    const meta = [relativeTime(lastRunAt), seconds(lastWallMs)].filter(Boolean).join(' · ');

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        {appName}
                    </DialogTitle>
                    <DialogDescription className="sr-only">Result of the {appName} app</DialogDescription>
                    {meta && (
                        <div className="mt-1 text-[13px]" style={{ color: 'var(--blanc-ink-2)' }}>{meta}</div>
                    )}
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        {error && (
                            <div
                                className="rounded-2xl px-4 py-3 text-sm"
                                style={{ background: 'rgba(240, 80, 63, 0.08)', color: 'var(--blanc-danger)' }}
                            >
                                {error}
                            </div>
                        )}

                        {updateBanner}

                        {view === 'schedule'
                            ? schedule
                            : showHistory
                            ? <RunHistory history={history} onSelectRun={onSelectRun} />
                            : (running && !document
                                ? (
                                    <div className="flex items-center gap-2 py-10 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                                        <Loader2 className="size-4 animate-spin" /> Running…
                                    </div>
                                )
                                : document
                                    ? <AppViewDocument document={document} onAction={onAction} actionBusy={running} />
                                    : (
                                        <p className="py-10 text-center text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                                            Run this app to see its result.
                                        </p>
                                    ))}
                    </div>
                </DialogBody>

                <DialogPanelFooter>
                    <Button
                        variant="ghost"
                        onClick={() => setView(current => (current === 'history' ? 'result' : 'history'))}
                    >
                        <History className="mr-1.5 size-4" />
                        {showHistory ? 'Result' : 'History'}
                    </Button>
                    {schedule && (
                        <Button
                            variant="ghost"
                            onClick={() => setView(current => (current === 'schedule' ? 'result' : 'schedule'))}
                        >
                            <CalendarClock className="mr-1.5 size-4" />
                            {view === 'schedule' ? 'Result' : 'Schedule'}
                        </Button>
                    )}
                    <Button onClick={onRun} disabled={running}>
                        {running ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <RefreshCw className="mr-1.5 size-4" />}
                        {running ? 'Running' : 'Run again'}
                    </Button>
                    {tools.length > 0 && (
                        <span className="ml-auto hidden text-xs md:inline" style={{ color: 'var(--blanc-ink-3)' }}>
                            Reads {tools.map(tool => tool.replace(/^svc\.list_|^svc\.get_/, '')).join(', ')}
                        </span>
                    )}
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}
