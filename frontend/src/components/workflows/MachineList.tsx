import { useNavigate } from 'react-router-dom';
import { useFsmMachines, type FsmMachine } from '../../hooks/useFsmEditor';
import { Badge } from '../ui/badge';

function formatDate(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function MachineCard({ machine, onSelect }: { machine: FsmMachine; onSelect: () => void }) {
    return (
        <div
            className="border border-[var(--blanc-line)] rounded-xl p-4 hover:border-[rgba(117,106,89,0.3)] transition-colors"
        >
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                    <h3 className="text-lg font-medium text-[var(--blanc-ink-1)]">
                        {machine.title}
                    </h3>
                    {machine.description && (
                        <p className="text-sm text-[var(--blanc-ink-2)] mt-1">
                            {machine.description}
                        </p>
                    )}
                    <div className="flex items-center gap-2 mt-3 flex-wrap">
                        {machine.active_version && (
                            <>
                                <Badge variant="secondary" className="text-xs">
                                    v{machine.active_version.version_number}
                                </Badge>
                                <span className="text-xs text-[var(--blanc-ink-3)]">
                                    Published {formatDate(machine.active_version.published_at)}
                                </span>
                            </>
                        )}
                        {!machine.active_version && (
                            <span className="text-xs text-[var(--blanc-ink-3)]">No published version</span>
                        )}
                        {machine.has_draft && (
                            <Badge variant="outline" className="text-xs">
                                Draft
                            </Badge>
                        )}
                    </div>
                </div>
                <button
                    onClick={onSelect}
                    className="shrink-0 px-3 py-1.5 text-sm font-medium rounded-lg border border-[var(--blanc-line)] hover:border-[rgba(117,106,89,0.3)] text-[var(--blanc-ink-1)] transition-colors"
                >
                    Open Editor
                </button>
            </div>
        </div>
    );
}

export default function MachineList() {
    const { data: machines, isLoading, error, refetch } = useFsmMachines();
    const navigate = useNavigate();

    if (isLoading) {
        return (
            <div className="py-8 text-center text-sm text-[var(--blanc-ink-3)]">
                Loading workflows...
            </div>
        );
    }

    if (error) {
        return (
            <div className="py-8 text-center">
                <p className="text-sm text-[var(--blanc-ink-2)] mb-3">
                    Failed to load workflows: {(error as Error).message}
                </p>
                <button
                    onClick={() => refetch()}
                    className="text-sm font-medium px-3 py-1.5 rounded-lg border border-[var(--blanc-line)] hover:border-[rgba(117,106,89,0.3)] text-[var(--blanc-ink-1)] transition-colors"
                >
                    Retry
                </button>
            </div>
        );
    }

    if (!machines || machines.length === 0) {
        return (
            <div className="py-8 text-center text-sm text-[var(--blanc-ink-3)]">
                No workflows configured yet.
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3 py-4">
            {machines.map((machine) => (
                <MachineCard
                    key={machine.machine_key}
                    machine={machine}
                    onSelect={() => navigate(`/settings/workflows/${machine.machine_key}`)}
                />
            ))}
        </div>
    );
}
