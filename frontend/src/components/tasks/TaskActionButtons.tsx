import { useState } from 'react';
import { Bot, Phone, Loader2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { runTaskAction, type TaskAction } from './tasksApi';
import { useSoftPhone } from '../../contexts/SoftPhoneContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useAuthz } from '../../hooks/useAuthz';

/**
 * OUTBOUND-PARTS-CALL-BTN-001: the typed action-button row for a task, shared by
 * the Job-card `TaskCard` and the Pulse "Action Required" banner. Renders one
 * button per `actions[]` entry (🤖 robot_call / 📞 manual_call), with a spinner
 * while a request runs and a reason line under any previously-failed action.
 *
 * - `manual_call` → dials (softphone on desktop, `tel:` on mobile), NO confirm.
 * - `robot_call` → `window.confirm` first; only POSTs if confirmed.
 *
 * Self-gates on `tasks.manage` so a button is never shown that the execute route
 * (`requirePermission('tasks.manage')`) would 403.
 *
 * Deliberately decoupled from the full `Task` type — takes a compact shape that
 * both the Job card and a Pulse `open_task` can satisfy.
 */
export interface TaskActionButtonsProps {
    /** Task id — the `:id` in `POST /api/tasks/:id/actions/:type`. */
    id: number;
    actions?: TaskAction[];
    /** Completed tasks show no action buttons. */
    done: boolean;
    /** Fallback dial target if the manual_call response omits one. */
    phone?: string | null;
    contactName?: string | null;
    /** Refetch after a robot_call so the buttons reflect the new action state
     *  (e.g. failed + reason, or the task closing). */
    onChanged?: () => void;
}

function actionIcon(type: TaskAction['type']) {
    return type === 'robot_call' ? Bot : Phone;
}

export function TaskActionButtons({ id, actions, done, phone, contactName, onChanged }: TaskActionButtonsProps) {
    const { hasPermission } = useAuthz();
    const { openDialer } = useSoftPhone();
    const isMobile = useIsMobile();
    const [runningType, setRunningType] = useState<TaskAction['type'] | null>(null);

    // Self-gate: the execute route requires tasks.manage — never show a button that
    // would 403 on click (matches Job-card + Pulse gating).
    if (!hasPermission('tasks.manage')) return null;
    if (done || !actions || actions.length === 0) return null;

    const runAction = async (action: TaskAction) => {
        if (runningType) return;
        // robot_call queues an automated outbound call to the customer — confirm first.
        if (action.type === 'robot_call' && !window.confirm('Start automated call to the customer?')) {
            return;
        }
        setRunningType(action.type);
        try {
            const result = await runTaskAction(id, action.type);
            if (action.type === 'manual_call') {
                // Pure client affordance: dial the returned number. Desktop → softphone;
                // mobile has no softphone (MOBILE-NO-SOFTPHONE-001) → native tel:.
                const dir = result.client;
                const dialPhone = (dir?.action === 'open_softphone' ? dir.phone : null) || phone || null;
                const dialName = dir?.contactName || contactName || undefined;
                if (dialPhone) {
                    if (isMobile) window.location.href = `tel:${dialPhone.replace(/[^\d+]/g, '')}`;
                    else openDialer(dialPhone, dialName);
                } else {
                    toast.error('No reachable number for this task');
                }
                return;
            }
            // robot_call: server queued (or refused) the outbound-call lifecycle.
            if (result.ok) {
                toast.success('Robot call queued');
            } else {
                toast.error(result.reason || 'The robot could not place the call');
            }
            onChanged?.();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Action failed');
        } finally {
            setRunningType(null);
        }
    };

    return (
        <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 flex-wrap">
                {actions.map((action) => {
                    const Icon = actionIcon(action.type);
                    const running = runningType === action.type;
                    const disabled = runningType !== null;
                    return (
                        <button
                            key={action.type}
                            type="button"
                            onClick={() => runAction(action)}
                            disabled={disabled}
                            className="inline-flex items-center gap-1.5 transition-opacity hover:opacity-70 disabled:opacity-50 disabled:cursor-not-allowed"
                            style={{ fontSize: 12, padding: '4px 10px', borderRadius: 8, border: '1px solid var(--blanc-line)', background: 'transparent', color: 'var(--blanc-ink-1)', cursor: 'pointer' }}
                        >
                            {running
                                ? <Loader2 className="size-3.5 animate-spin" />
                                : <Icon className="size-3.5" />}
                            {action.label}
                        </button>
                    );
                })}
            </div>
            {actions
                .filter((a) => a.state === 'failed' && a.reason)
                .map((a) => (
                    <p
                        key={`reason-${a.type}`}
                        className="inline-flex items-start gap-1.5 text-xs"
                        style={{ color: 'var(--blanc-ink-2)' }}
                    >
                        <TriangleAlert className="size-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)', marginTop: 1 }} />
                        <span>{a.reason}</span>
                    </p>
                ))}
        </div>
    );
}
