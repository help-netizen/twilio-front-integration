import { useState, type ComponentType } from 'react';
import { Check, Phone, Wrench, Truck, Clock, X, ArrowRight, AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useFsmActions, useApplyTransition, useOverrideStatus, useFsmStates, type FsmAction } from '../../hooks/useFsmActions';
import { useAuthz } from '../../hooks/useAuthz';
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose,
} from '../ui/dialog';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select';

// ─── Icon map ────────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
    check: Check,
    phone: Phone,
    wrench: Wrench,
    truck: Truck,
    clock: Clock,
    x: X,
    'arrow-right': ArrowRight,
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface ActionsBlockProps {
    machineKey: string;
    entityId: number | string;
    currentState: string;
    onTransitionComplete?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ActionsBlock({ machineKey, entityId, currentState, onTransitionComplete }: ActionsBlockProps) {
    const { data: actions } = useFsmActions(machineKey, currentState);
    const applyMutation = useApplyTransition(machineKey);
    const { hasPermission } = useAuthz();
    const canOverride = hasPermission('fsm.override');

    // Confirm dialog state
    const [confirmAction, setConfirmAction] = useState<FsmAction | null>(null);

    // Override dialog state
    const [overrideOpen, setOverrideOpen] = useState(false);
    const [overrideTarget, setOverrideTarget] = useState('');
    const [overrideReason, setOverrideReason] = useState('');
    const overrideMutation = useOverrideStatus(machineKey);
    const { data: fsmData } = useFsmStates(machineKey, overrideOpen);
    const allStates = fsmData?.states ?? [];

    const sortedActions = (actions ?? []).slice().sort((a, b) => a.order - b.order);

    // Nothing to render
    if (sortedActions.length === 0 && !canOverride) return null;

    // ── Handlers ──

    function handleActionClick(action: FsmAction) {
        if (action.confirm) {
            setConfirmAction(action);
        } else {
            executeTransition(action);
        }
    }

    function executeTransition(action: FsmAction) {
        applyMutation.mutate(
            { entityId: Number(entityId), event: action.event },
            {
                onSuccess: (data) => {
                    toast.success(`Status changed to ${data.newState}`);
                    onTransitionComplete?.();
                },
                onError: (err) => {
                    toast.error(err.message || 'Transition failed');
                },
            },
        );
        setConfirmAction(null);
    }

    function handleOverrideSubmit() {
        if (!overrideTarget || !overrideReason.trim()) return;
        overrideMutation.mutate(
            { entityId: Number(entityId), targetState: overrideTarget, reason: overrideReason.trim() },
            {
                onSuccess: (data) => {
                    toast.success(`Status changed to ${data.newState}`);
                    setOverrideOpen(false);
                    setOverrideTarget('');
                    setOverrideReason('');
                    onTransitionComplete?.();
                },
                onError: (err) => {
                    toast.error(err.message || 'Override failed');
                },
            },
        );
    }

    // ── Render ──

    return (
        <div className="space-y-2">
            {/* Action buttons */}
            {sortedActions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {sortedActions.map((action) => {
                        const Icon = action.icon ? ICON_MAP[action.icon] : null;
                        return (
                            <button
                                key={action.event}
                                type="button"
                                disabled={applyMutation.isPending}
                                onClick={() => handleActionClick(action)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-[var(--blanc-line)] hover:bg-[rgba(117,106,89,0.04)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                style={{ color: 'var(--blanc-ink-1)', background: 'transparent' }}
                            >
                                {applyMutation.isPending ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                ) : Icon ? (
                                    <Icon className="size-3.5" />
                                ) : null}
                                {action.label}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Override link */}
            {canOverride && (
                <button
                    type="button"
                    onClick={() => setOverrideOpen(true)}
                    className="text-xs hover:underline transition-colors"
                    style={{ color: 'var(--blanc-ink-3)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                    onMouseEnter={(e) => { (e.target as HTMLElement).style.color = 'var(--blanc-ink-2)'; }}
                    onMouseLeave={(e) => { (e.target as HTMLElement).style.color = 'var(--blanc-ink-3)'; }}
                >
                    Change status...
                </button>
            )}

            {/* Confirm dialog */}
            <Dialog open={!!confirmAction} onOpenChange={(open) => { if (!open) setConfirmAction(null); }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Confirm Action</DialogTitle>
                        <DialogDescription>
                            {confirmAction?.confirmText || 'Are you sure you want to perform this action?'}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <DialogClose asChild>
                            <button
                                type="button"
                                className="px-4 py-2 text-sm rounded-lg border border-[var(--blanc-line)] hover:bg-[rgba(117,106,89,0.04)] transition-colors"
                                style={{ color: 'var(--blanc-ink-2)' }}
                            >
                                Cancel
                            </button>
                        </DialogClose>
                        <button
                            type="button"
                            disabled={applyMutation.isPending}
                            onClick={() => confirmAction && executeTransition(confirmAction)}
                            className="px-4 py-2 text-sm rounded-lg border border-[var(--blanc-line)] font-medium hover:bg-[rgba(117,106,89,0.08)] transition-colors disabled:opacity-50"
                            style={{ color: 'var(--blanc-ink-1)' }}
                        >
                            {applyMutation.isPending ? 'Applying...' : 'Confirm'}
                        </button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Override dialog */}
            <Dialog open={overrideOpen} onOpenChange={(open) => { if (!open) { setOverrideOpen(false); setOverrideTarget(''); setOverrideReason(''); } }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Override Status</DialogTitle>
                        <DialogDescription className="flex items-start gap-2 pt-1">
                            <AlertTriangle className="size-4 shrink-0 text-amber-500 mt-0.5" />
                            <span>This is an override. It bypasses allowed transitions.</span>
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-3 py-2">
                        <div className="space-y-1.5">
                            <label className="blanc-eyebrow">Target status</label>
                            <Select value={overrideTarget} onValueChange={setOverrideTarget}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Select a status..." />
                                </SelectTrigger>
                                <SelectContent>
                                    {(allStates ?? []).map((state) => (
                                        <SelectItem key={state} value={state}>
                                            {state}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-1.5">
                            <label className="blanc-eyebrow">Reason for override</label>
                            <textarea
                                value={overrideReason}
                                onChange={(e) => setOverrideReason(e.target.value)}
                                placeholder="Explain why this override is needed..."
                                rows={3}
                                className="w-full rounded-lg border border-[var(--blanc-line)] bg-transparent px-3 py-2 text-sm placeholder:text-[var(--blanc-ink-3)] focus:outline-none focus:ring-1 focus:ring-[var(--blanc-line)] resize-none"
                            />
                        </div>
                    </div>

                    <DialogFooter className="gap-2 sm:gap-0">
                        <DialogClose asChild>
                            <button
                                type="button"
                                className="px-4 py-2 text-sm rounded-lg border border-[var(--blanc-line)] hover:bg-[rgba(117,106,89,0.04)] transition-colors"
                                style={{ color: 'var(--blanc-ink-2)' }}
                            >
                                Cancel
                            </button>
                        </DialogClose>
                        <button
                            type="button"
                            disabled={!overrideTarget || !overrideReason.trim() || overrideMutation.isPending}
                            onClick={handleOverrideSubmit}
                            className="px-4 py-2 text-sm rounded-lg border border-[var(--blanc-line)] font-medium hover:bg-[rgba(117,106,89,0.08)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            style={{ color: 'var(--blanc-ink-1)' }}
                        >
                            {overrideMutation.isPending ? 'Applying...' : 'Override'}
                        </button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
