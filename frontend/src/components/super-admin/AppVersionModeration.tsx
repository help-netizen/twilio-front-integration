import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Code2, Loader2, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '../ui/dialog';
import { FloatingField } from '../ui/floating-field';
import {
    approveAppVersion,
    getAppVersionReview,
    listAppVersionReviews,
    rejectAppVersion,
    revokeAppVersion,
    startAppVersionReview,
    type AppCadence,
    type AppVersionQueueStatus,
    type AppVersionReviewDetail,
    type AppVersionReviewRequest,
    type AppVersionStatus,
} from '../../services/platformAppReviewsApi';

const QUEUES: Array<{ id: AppVersionQueueStatus; label: string }> = [
    { id: 'pending', label: 'Pending' },
    { id: 'published', label: 'Published' },
    { id: 'rejected', label: 'Rejected' },
    { id: 'revoked', label: 'Revoked' },
];

export function reviewActionsFor(status: AppVersionStatus) {
    return {
        approve: status === 'in_review',
        reject: status === 'in_review',
        revoke: status === 'published',
    };
}

function formatDate(value: string | null | undefined, timeZone: string) {
    if (!value) return null;
    return new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone,
    }).format(new Date(value));
}

function cadenceText(cadence: AppCadence): string {
    if (cadence.kind === 'every_minutes') return `Every ${cadence.n} minute${cadence.n === 1 ? '' : 's'}`;
    if (cadence.kind === 'hourly') return `Hourly at :${String(cadence.minute).padStart(2, '0')}`;
    if (cadence.kind === 'daily') return `Daily at ${cadence.at}`;
    if (cadence.kind === 'weekly') return `Weekly on day ${cadence.dow} at ${cadence.at}`;
    return `Monthly on day ${cadence.dom} at ${cadence.at}`;
}

function Pills({ items, tone }: { items: string[]; tone?: 'danger' | 'accent' | 'warning' }) {
    const style = tone === 'danger'
        ? { background: 'var(--blanc-danger-soft)', color: 'var(--blanc-danger)' }
        : tone === 'warning'
            ? { background: 'var(--blanc-lead-soft)', color: 'var(--blanc-lead)' }
            : { background: 'var(--blanc-field)', color: 'var(--blanc-ink-2)' };
    return (
        <div className="flex flex-wrap gap-2">
            {items.map(item => (
                <span key={item} className="rounded-full px-3 py-1 text-xs font-medium" style={style}>{item}</span>
            ))}
        </div>
    );
}

/** Everything a version is asking for beyond its tools — the reach a moderator
 *  is actually approving: where it calls out, what it listens to, what it keeps,
 *  what it can do to a row, and what the tenant must fill in. */
function CapabilitySurface({ version }: { version: AppVersionReviewDetail['version'] }) {
    const rows: Array<{ label: string; tone?: 'danger' | 'warning'; body: React.ReactNode }> = [];

    if (version.connections?.length) {
        rows.push({
            label: 'Calls out to', tone: 'danger',
            body: <Pills tone="danger" items={version.connections.map(c => `${c.base_url} (${c.auth.kind})`)} />,
        });
    }
    if (version.subscribes?.length) {
        rows.push({ label: 'Triggered by events', tone: 'warning', body: <Pills tone="warning" items={version.subscribes} /> });
    }
    if (version.suggested_schedule) {
        rows.push({ label: 'Suggested schedule', body: <Pills items={[cadenceText(version.suggested_schedule)]} /> });
    }
    if (version.actions?.length) {
        rows.push({ label: 'Row actions', body: <Pills items={version.actions.map(a => a.label)} /> });
    }
    if (version.data_collections?.length) {
        rows.push({
            label: 'Stores data',
            body: <Pills items={version.data_collections.map(c => `${c.name} [${c.columns.map(col => col.key).join(', ')}]`)} />,
        });
    }
    if (version.settings?.length) {
        rows.push({
            label: 'Asks the tenant for',
            body: <Pills items={version.settings.map(s => `${s.label}${s.required ? ' *' : ''} (${s.type})`)} />,
        });
    }

    if (!rows.length) return null;
    return (
        <section className="space-y-3.5">
            <div className="blanc-eyebrow">Capabilities</div>
            <div className="space-y-3">
                {rows.map(row => (
                    <div key={row.label} className="space-y-1.5">
                        <div className="text-xs font-semibold" style={{ color: row.tone === 'danger' ? 'var(--blanc-danger)' : 'var(--blanc-ink-2)' }}>
                            {row.label}
                        </div>
                        {row.body}
                    </div>
                ))}
            </div>
        </section>
    );
}

function JsonReport({ value }: { value: unknown }) {
    return (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl bg-[var(--blanc-field)] p-3 text-xs leading-5 text-[var(--blanc-ink-2)]">
            {JSON.stringify(value, null, 2)}
        </pre>
    );
}

export function AppReviewQueue({
    requests,
    selectedId,
    busyId,
    onSelect,
}: {
    requests: AppVersionReviewRequest[];
    selectedId: string | null;
    busyId: string | null;
    onSelect: (request: AppVersionReviewRequest) => void;
}) {
    return (
        <div className="space-y-2">
            {requests.map(request => (
                <button
                    key={request.version_id}
                    type="button"
                    onClick={() => onSelect(request)}
                    aria-current={selectedId === request.version_id ? 'true' : undefined}
                    className={`grid w-full grid-cols-[1fr_auto] items-center gap-3 rounded-xl p-3.5 text-left transition-colors ${
                        selectedId === request.version_id
                            ? 'bg-[var(--blanc-accent-soft)]'
                            : 'bg-[var(--blanc-surface-strong)] hover:bg-[var(--blanc-field)]'
                    }`}
                >
                    <span className="min-w-0 space-y-1">
                        <span className="block truncate text-sm font-semibold text-[var(--blanc-ink-1)]">
                            {request.app_name}
                        </span>
                        <span className="block truncate text-xs text-[var(--blanc-ink-3)]">
                            {request.company_name} · {request.version_number}
                        </span>
                        <span className="block text-xs text-[var(--blanc-ink-3)]">
                            {formatDate(request.submitted_at || request.created_at, request.company_timezone)}
                        </span>
                    </span>
                    {busyId === request.version_id
                        ? <Loader2 className="size-4 animate-spin text-[var(--blanc-ink-3)]" />
                        : <ChevronRight className="size-4 text-[var(--blanc-ink-3)]" />}
                </button>
            ))}
        </div>
    );
}

export function AppReviewDetail({
    detail,
    sourceCode,
    sourceLoading,
    busy,
    onShowCode,
    onApprove,
    onReject,
    onRevoke,
}: {
    detail: AppVersionReviewDetail;
    sourceCode?: string;
    sourceLoading: boolean;
    busy: boolean;
    onShowCode: () => void;
    onApprove: () => void;
    onReject: () => void;
    onRevoke: () => void;
}) {
    const actions = reviewActionsFor(detail.version.status);
    const submittedAt = formatDate(detail.version.submitted_at, detail.company.timezone);
    return (
        <div className="space-y-6 rounded-2xl bg-[var(--blanc-surface-strong)] p-5 md:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 space-y-1.5">
                    <div className="blanc-eyebrow">{detail.company.name}</div>
                    <h2 className="text-2xl font-semibold text-[var(--blanc-ink-1)]">{detail.app.name}</h2>
                    <p className="text-sm text-[var(--blanc-ink-2)]">
                        {detail.version.version_number} · {detail.version.status}
                        {submittedAt ? ` · submitted ${submittedAt}` : ''}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    {actions.approve && (
                        <Button disabled={busy} onClick={onApprove}>
                            <Check className="size-4" /> Approve
                        </Button>
                    )}
                    {actions.reject && (
                        <Button disabled={busy} variant="outline" onClick={onReject}>
                            <X className="size-4" /> Reject
                        </Button>
                    )}
                    {actions.revoke && (
                        <Button disabled={busy} variant="destructive" onClick={onRevoke}>
                            <RotateCcw className="size-4" /> Revoke
                        </Button>
                    )}
                </div>
            </div>

            <section className="space-y-3.5">
                <div className="blanc-eyebrow">Profile</div>
                <p className="text-sm leading-6 text-[var(--blanc-ink-2)]">
                    {detail.app.long_description || detail.app.short_description}
                </p>
                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                    <div className="rounded-xl bg-[var(--blanc-field)] p-3">
                        <div className="text-xs text-[var(--blanc-ink-3)]">Provider</div>
                        <div className="mt-1 text-sm font-medium">{detail.app.provider_name}</div>
                    </div>
                    <div className="rounded-xl bg-[var(--blanc-field)] p-3">
                        <div className="text-xs text-[var(--blanc-ink-3)]">Artifact SHA-256</div>
                        <div className="mt-1 break-all font-mono text-xs">{detail.version.source_sha256}</div>
                    </div>
                </div>
            </section>

            {detail.version.tools.length > 0 && (
                <section className="space-y-3.5">
                    <div className="blanc-eyebrow">Requested tools</div>
                    <div className="flex flex-wrap gap-2">
                        {detail.version.tools.map(tool => {
                            const writes = tool.kind === 'write';
                            return (
                                <span
                                    key={tool.name}
                                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
                                    style={writes
                                        ? { background: 'var(--blanc-danger-soft)', color: 'var(--blanc-danger)' }
                                        : { background: 'var(--blanc-accent-soft)', color: 'var(--blanc-accent)' }}
                                >
                                    {tool.name}
                                    {writes && <span className="font-bold uppercase tracking-wide">write</span>}
                                </span>
                            );
                        })}
                    </div>
                </section>
            )}

            <CapabilitySurface version={detail.version} />

            <section className="space-y-3.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="blanc-eyebrow">
                        Diff{detail.previous_version ? ` from ${detail.previous_version.version_number}` : ' from empty artifact'}
                    </div>
                    <span className="text-xs text-[var(--blanc-ink-3)]">
                        +{detail.source_diff.added_lines} / −{detail.source_diff.removed_lines}
                    </span>
                </div>
                <pre className="max-h-80 overflow-auto rounded-xl bg-[var(--blanc-field)] p-3 font-mono text-xs leading-5">
                    {detail.source_diff.lines.map((line, index) => (
                        <span
                            key={`${line.type}-${index}`}
                            className={`block whitespace-pre-wrap ${
                                line.type === 'added'
                                    ? 'text-[var(--blanc-success)]'
                                    : line.type === 'removed'
                                        ? 'text-[var(--blanc-danger)]'
                                        : 'text-[var(--blanc-ink-3)]'
                            }`}
                        >
                            {line.type === 'added' ? '+ ' : line.type === 'removed' ? '− ' : '  '}{line.text}
                        </span>
                    ))}
                </pre>
                {detail.source_diff.truncated && (
                    <p className="text-xs text-[var(--blanc-ink-3)]">Diff is truncated to the review limit.</p>
                )}
            </section>

            <section className="space-y-3.5">
                <div className="blanc-eyebrow">Scanner report</div>
                <JsonReport value={detail.version.scanner_report} />
            </section>

            {detail.version.sandbox_run && (
                <section className="space-y-3.5">
                    <div className="blanc-eyebrow">Latest sandbox validation</div>
                    <JsonReport value={detail.version.sandbox_run} />
                </section>
            )}

            <section className="space-y-3.5">
                <div className="flex items-center justify-between gap-3">
                    <div className="blanc-eyebrow">Source code</div>
                    {!sourceCode && (
                        <Button variant="outline" size="sm" disabled={sourceLoading} onClick={onShowCode}>
                            {sourceLoading ? <Loader2 className="size-4 animate-spin" /> : <Code2 className="size-4" />}
                            Show code
                        </Button>
                    )}
                </div>
                {sourceCode && (
                    <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-[var(--blanc-field)] p-3 font-mono text-xs leading-5 text-[var(--blanc-ink-2)]">
                        {sourceCode}
                    </pre>
                )}
            </section>

            <section className="space-y-3.5">
                <div className="blanc-eyebrow">Builder conversation</div>
                <div className="space-y-6">
                    {detail.chats.map(chat => (
                        <div key={chat.id} className="space-y-3.5">
                            <h3 className="text-sm font-semibold text-[var(--blanc-ink-1)]">{chat.title}</h3>
                            <div className="space-y-3">
                                {chat.messages.map(message => (
                                    <div
                                        key={message.id}
                                        className={`max-w-[88%] rounded-xl px-3.5 py-3 text-sm leading-6 ${
                                            message.role === 'assistant'
                                                ? 'bg-[var(--blanc-field)]'
                                                : 'ml-auto bg-[var(--blanc-accent-soft)]'
                                        }`}
                                    >
                                        <div className="mb-1 text-xs font-medium text-[var(--blanc-ink-3)]">
                                            {message.role === 'assistant' ? 'App Studio' : 'Author'}
                                        </div>
                                        <p className="whitespace-pre-wrap">{message.text}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </section>
        </div>
    );
}

export function AppVersionModeration() {
    const queryClient = useQueryClient();
    const [queueStatus, setQueueStatus] = useState<AppVersionQueueStatus>('pending');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [claimingId, setClaimingId] = useState<string | null>(null);
    const [showCode, setShowCode] = useState(false);
    const [rejectOpen, setRejectOpen] = useState(false);
    const [rejectReason, setRejectReason] = useState('');

    const queue = useQuery({
        queryKey: ['app-version-reviews', queueStatus],
        queryFn: () => listAppVersionReviews(queueStatus),
    });
    const detail = useQuery({
        queryKey: ['app-version-review', selectedId],
        queryFn: () => getAppVersionReview(selectedId as string),
        enabled: Boolean(selectedId),
    });
    const source = useQuery({
        queryKey: ['app-version-review-source', selectedId],
        queryFn: () => getAppVersionReview(selectedId as string, true),
        enabled: Boolean(selectedId && showCode),
    });

    const decision = useMutation({
        mutationFn: async (input: { action: 'approve' | 'reject' | 'revoke'; reason?: string }) => {
            if (!selectedId) throw new Error('Select an app version first.');
            if (input.action === 'approve') return approveAppVersion(selectedId);
            if (input.action === 'reject') return rejectAppVersion(selectedId, input.reason || '');
            return revokeAppVersion(selectedId);
        },
        onSuccess: (_result, input) => {
            toast.success(input.action === 'approve'
                ? 'Version approved'
                : input.action === 'reject'
                    ? 'Version rejected'
                    : 'Version revoked');
            setRejectOpen(false);
            setRejectReason('');
            setSelectedId(null);
            setShowCode(false);
            queryClient.invalidateQueries({ queryKey: ['app-version-reviews'] });
        },
        onError: (error: Error) => toast.error(error.message || 'Version moderation failed'),
    });

    const selectRequest = async (request: AppVersionReviewRequest) => {
        setShowCode(false);
        if (request.status === 'submitted') {
            setClaimingId(request.version_id);
            try {
                await startAppVersionReview(request.version_id);
                await queryClient.invalidateQueries({ queryKey: ['app-version-reviews'] });
            } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Could not start review');
                setClaimingId(null);
                return;
            }
            setClaimingId(null);
        }
        setSelectedId(request.version_id);
    };

    const requests = queue.data?.requests || [];
    const review = showCode ? source.data || detail.data : detail.data;

    return (
        <section className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
                {QUEUES.map(item => (
                    <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                            setQueueStatus(item.id);
                            setSelectedId(null);
                            setShowCode(false);
                        }}
                        className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors ${
                            queueStatus === item.id
                                ? 'bg-[var(--blanc-accent-soft)] text-[var(--blanc-accent)]'
                                : 'bg-[var(--blanc-surface-strong)] text-[var(--blanc-ink-2)]'
                        }`}
                    >
                        {item.label}{queueStatus === item.id && queue.data ? ` · ${queue.data.total}` : ''}
                    </button>
                ))}
            </div>

            <div className="grid min-h-[580px] gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
                <aside aria-label="App review queue" className="min-h-0 overflow-y-auto">
                    {queue.isLoading ? (
                        <div className="flex items-center gap-2 py-8 text-sm text-[var(--blanc-ink-3)]">
                            <Loader2 className="size-4 animate-spin" /> Loading apps…
                        </div>
                    ) : queue.isError ? (
                        <p className="py-8 text-sm text-[var(--blanc-danger)]">Could not load the app queue.</p>
                    ) : requests.length === 0 ? (
                        <p className="py-8 text-sm text-[var(--blanc-ink-3)]">No apps in this queue.</p>
                    ) : (
                        <AppReviewQueue
                            requests={requests}
                            selectedId={selectedId}
                            busyId={claimingId}
                            onSelect={selectRequest}
                        />
                    )}
                </aside>

                <main aria-label="App review detail" className="min-w-0">
                    {!selectedId ? (
                        <div className="flex min-h-[420px] items-center justify-center text-sm text-[var(--blanc-ink-3)]">
                            Select an app version to review.
                        </div>
                    ) : detail.isLoading ? (
                        <div className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-[var(--blanc-ink-3)]">
                            <Loader2 className="size-4 animate-spin" /> Loading review…
                        </div>
                    ) : detail.isError || !review ? (
                        <div className="flex min-h-[420px] items-center justify-center text-sm text-[var(--blanc-danger)]">
                            Could not load this app review.
                        </div>
                    ) : (
                        <AppReviewDetail
                            detail={review}
                            sourceCode={showCode ? source.data?.version.source_code : undefined}
                            sourceLoading={showCode && source.isFetching}
                            busy={decision.isPending}
                            onShowCode={() => setShowCode(true)}
                            onApprove={() => decision.mutate({ action: 'approve' })}
                            onReject={() => setRejectOpen(true)}
                            onRevoke={() => decision.mutate({ action: 'revoke' })}
                        />
                    )}
                </main>
            </div>

            <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
                <DialogContent variant="dialog">
                    <DialogHeader>
                        <DialogTitle>Reject app version</DialogTitle>
                        <DialogDescription>
                            The author will receive this reason as a separate App Studio message.
                        </DialogDescription>
                    </DialogHeader>
                    <FloatingField
                        label="Rejection reason"
                        textarea
                        rows={4}
                        value={rejectReason}
                        onChange={event => setRejectReason(event.target.value)}
                    />
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setRejectOpen(false)}>Cancel</Button>
                        <Button
                            variant="destructive"
                            disabled={!rejectReason.trim() || decision.isPending}
                            onClick={() => decision.mutate({ action: 'reject', reason: rejectReason })}
                        >
                            Reject
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </section>
    );
}
