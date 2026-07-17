import React, { useState } from 'react';
import { toast } from 'sonner';
import { RotateCcw, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '../ui/dialog';
import { Button } from '../ui/button';
import {
    useFsmVersions,
    useRestoreVersion,
    type FsmVersionListItem,
} from '../../hooks/useFsmEditor';

interface VersionHistoryProps {
    machineKey: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onRestored: () => void;
}

const statusConfig: Record<
    FsmVersionListItem['status'],
    { label: string; className: string }
> = {
    published: {
        label: 'Published',
        className: 'bg-emerald-100 text-emerald-800',
    },
    draft: {
        label: 'Draft',
        className: 'bg-amber-100 text-amber-800',
    },
    archived: {
        label: 'Archived',
        className: 'bg-stone-100 text-stone-500',
    },
};

function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function VersionRow({
    version,
    onRestore,
    isRestoring,
}: {
    version: FsmVersionListItem;
    onRestore: (versionId: number) => void;
    isRestoring: boolean;
}) {
    const [expanded, setExpanded] = useState(false);
    const config = statusConfig[version.status];
    const author = version.published_by || version.created_by;
    const date = version.published_at || version.created_at;
    const hasNote = !!version.change_note;
    const canRestore = version.status !== 'draft';

    return (
        <div className="rounded-xl border border-[var(--blanc-line)] px-4 py-3 transition-colors hover:border-[rgba(117,106,89,0.32)]">
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                    <span className="font-medium text-[var(--blanc-ink-1)] whitespace-nowrap">
                        v{version.version_number}
                    </span>
                    <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${config.className}`}
                    >
                        {config.label}
                    </span>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                    {canRestore && (
                        <Button
                            variant="ghost"
                            size="sm"
                            disabled={isRestoring}
                            onClick={() => onRestore(version.version_id)}
                            className="text-xs gap-1.5"
                        >
                            {isRestoring ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <RotateCcw className="h-3.5 w-3.5" />
                            )}
                            Restore as Draft
                        </Button>
                    )}
                </div>
            </div>

            <div className="mt-1.5 flex items-center gap-2 text-xs text-[var(--blanc-ink-3)]">
                <span>{author}</span>
                <span>&middot;</span>
                <span>{formatDate(date)}</span>
            </div>

            {hasNote && (
                <div className="mt-2">
                    <button
                        type="button"
                        onClick={() => setExpanded((p) => !p)}
                        className="flex items-center gap-1 text-xs text-[var(--blanc-ink-2)] hover:text-[var(--blanc-ink-1)] transition-colors"
                    >
                        {expanded ? (
                            <ChevronUp className="h-3 w-3" />
                        ) : (
                            <ChevronDown className="h-3 w-3" />
                        )}
                        {expanded ? 'Hide note' : 'Show note'}
                    </button>
                    {expanded && (
                        <p className="mt-1.5 text-sm text-[var(--blanc-ink-2)] whitespace-pre-wrap">
                            {version.change_note}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}

export default function VersionHistory({
    machineKey,
    open,
    onOpenChange,
    onRestored,
}: VersionHistoryProps) {
    const { data, isLoading } = useFsmVersions(open ? machineKey : null);
    const restoreMutation = useRestoreVersion(machineKey);
    const [restoringId, setRestoringId] = useState<number | null>(null);

    const versions = React.useMemo(() => {
        if (!data?.versions) return [];
        return [...data.versions].sort(
            (a, b) => b.version_number - a.version_number,
        );
    }, [data]);

    const handleRestore = async (versionId: number) => {
        setRestoringId(versionId);
        try {
            await restoreMutation.mutateAsync({ versionId });
            toast.success('Version restored as draft');
            onRestored();
            onOpenChange(false);
        } catch (err: unknown) {
            const message =
                err instanceof Error ? err.message : 'Failed to restore version';
            toast.error(message);
        } finally {
            setRestoringId(null);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="md:max-w-xl">
                <DialogHeader>
                    <DialogTitle>Version History</DialogTitle>
                    <DialogDescription>
                        Browse previous versions and restore any as a new draft.
                    </DialogDescription>
                </DialogHeader>

                <div className="mt-2 max-h-[60vh] overflow-y-auto space-y-2 pr-1">
                    {isLoading && (
                        <div className="flex items-center justify-center py-12 text-[var(--blanc-ink-3)]">
                            <Loader2 className="h-5 w-5 animate-spin" />
                        </div>
                    )}

                    {!isLoading && versions.length === 0 && (
                        <p className="py-12 text-center text-sm text-[var(--blanc-ink-3)]">
                            No versions yet.
                        </p>
                    )}

                    {versions.map((v) => (
                        <VersionRow
                            key={v.version_id}
                            version={v}
                            onRestore={handleRestore}
                            isRestoring={restoringId === v.version_id}
                        />
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    );
}
