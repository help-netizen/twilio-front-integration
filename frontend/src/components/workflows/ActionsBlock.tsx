import { useState, type ComponentType } from 'react';
import { Check, Phone, Wrench, Truck, Clock, X, ArrowRight, AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useFsmActions, useApplyTransition, useOverrideStatus, useFsmStates, type FsmAction } from '../../hooks/useFsmActions';
import { useAuthz } from '../../hooks/useAuthz';
import {
    Dialog, DialogContent, DialogPanelHeader, DialogTitle, DialogDescription, DialogBody, DialogPanelFooter,
} from '../ui/dialog';
import { SelectItem } from '../ui/select';
import { Button } from '../ui/button';
import { FloatingField } from '../ui/floating-field';
import { FloatingSelect } from '../ui/floating-select';

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
    const [confirmReason, setConfirmReason] = useState('');

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
            setConfirmReason('');
            setConfirmAction(action);
        } else {
            executeTransition(action);
        }
    }

    function executeTransition(action: FsmAction, reason?: string) {
        applyMutation.mutate(
            { entityId: Number(entityId), event: action.event, reason },
            {
                onSuccess: (data) => {
                    const nextState = data.newState || data.targetState || action.target;
                    toast.success(`Status changed to ${nextState}`);
                    onTransitionComplete?.();
                },
                onError: (err) => {
                    toast.error(err.message || 'Couldn\'t change status');
                },
            },
        );
        setConfirmAction(null);
        setConfirmReason('');
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
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-[var(--blanc-line)] hover:bg-[rgba(25,25,25,0.03)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
            <Dialog
                open={!!confirmAction}
                onOpenChange={(open) => {
                    if (!open) {
                        setConfirmAction(null);
                        setConfirmReason('');
                    }
                }}
            >
                <DialogContent variant="panel">
                    <DialogPanelHeader>
                        <DialogTitle
                            className="text-[22px] font-semibold leading-tight"
                            style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                        >
                            {confirmAction?.target === 'Canceled' ? 'Cancel Job' : 'Confirm action'}
                        </DialogTitle>
                        <DialogDescription>
                            {confirmAction?.confirmText || 'Are you sure you want to perform this action?'}
                        </DialogDescription>
                    </DialogPanelHeader>

                    <DialogBody className="md:px-8 md:py-7">
                      <div className="mx-auto w-full max-w-[740px] space-y-6">
                        {confirmAction?.target === 'Canceled' && (
                            <FloatingField
                                id="fsm-cancel-reason"
                                label="Cancel reason"
                                textarea
                                rows={4}
                                value={confirmReason}
                                onChange={(e) => setConfirmReason(e.target.value)}
                                disabled={applyMutation.isPending}
                            />
                        )}
                      </div>
                    </DialogBody>

                    <DialogPanelFooter>
                        <Button
                            variant="ghost"
                            onClick={() => { setConfirmAction(null); setConfirmReason(''); }}
                        >
                            {confirmAction?.target === 'Canceled' ? 'Keep Job' : 'Cancel'}
                        </Button>
                        <Button
                            variant={confirmAction?.target === 'Canceled' ? 'destructive' : 'default'}
                            disabled={applyMutation.isPending || (confirmAction?.target === 'Canceled' && !confirmReason.trim())}
                            onClick={() => confirmAction && executeTransition(confirmAction, confirmReason.trim() || undefined)}
                        >
                            {applyMutation.isPending
                                ? 'Applying...'
                                : confirmAction?.target === 'Canceled'
                                    ? 'Cancel Job'
                                    : 'Confirm'}
                        </Button>
                    </DialogPanelFooter>
                </DialogContent>
            </Dialog>

            {/* Override dialog */}
            <Dialog open={overrideOpen} onOpenChange={(open) => { if (!open) { setOverrideOpen(false); setOverrideTarget(''); setOverrideReason(''); } }}>
                <DialogContent variant="panel">
                    <DialogPanelHeader>
                        <DialogTitle
                            className="text-[22px] font-semibold leading-tight"
                            style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                        >
                            Change status manually
                        </DialogTitle>
                        <DialogDescription className="flex items-start gap-2 pt-1">
                            <AlertTriangle className="size-4 shrink-0 text-amber-500 mt-0.5" />
                            <span>This skips the normal status flow — use with care.</span>
                        </DialogDescription>
                    </DialogPanelHeader>

                    <DialogBody className="md:px-8 md:py-7">
                      <div className="mx-auto w-full max-w-[740px] space-y-6">
                        <div className="space-y-3.5">
                            <FloatingSelect label="Target status" value={overrideTarget} onValueChange={setOverrideTarget}>
                                {(allStates ?? []).map((state) => (
                                    <SelectItem key={state} value={state}>
                                        {state}
                                    </SelectItem>
                                ))}
                            </FloatingSelect>

                            <FloatingField
                                label="Reason for override"
                                textarea
                                rows={3}
                                value={overrideReason}
                                onChange={(e) => setOverrideReason(e.target.value)}
                            />
                        </div>
                      </div>
                    </DialogBody>

                    <DialogPanelFooter>
                        <Button
                            variant="ghost"
                            onClick={() => { setOverrideOpen(false); setOverrideTarget(''); setOverrideReason(''); }}
                        >
                            Cancel
                        </Button>
                        <Button
                            disabled={!overrideTarget || !overrideReason.trim() || overrideMutation.isPending}
                            onClick={handleOverrideSubmit}
                        >
                            {overrideMutation.isPending ? 'Applying...' : 'Change status'}
                        </Button>
                    </DialogPanelFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
