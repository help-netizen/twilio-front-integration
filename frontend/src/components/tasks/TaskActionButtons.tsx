import { useState } from 'react';
import { Bot, Phone, Loader2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { runTaskAction, type TaskAction } from './tasksApi';
import { RobotCallSlotModal } from './RobotCallSlotModal';
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
 * - `robot_call` → opens `RobotCallSlotModal` (the dispatcher explicitly picks the
 *   slot there; the modal is the single confirm — no `window.confirm`, no immediate
 *   POST). Needs a `jobId`; without one the button toasts instead of opening
 *   (SLOTPICK-001).
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
    /** Linked job id — required to open the robot_call slot-picker modal
     *  (SLOTPICK-001). Absent → the 🤖 button toasts instead of opening. */
    jobId?: number | string;
    /** Refetch after a robot_call so the buttons reflect the new action state
     *  (e.g. failed + reason, or the task closing). */
    onChanged?: () => void;
}

function actionIcon(type: TaskAction['type']) {
    return type === 'robot_call' ? Bot : Phone;
}

export function TaskActionButtons({ id, actions, done, phone, contactName, jobId, onChanged }: TaskActionButtonsProps) {
    const { hasPermission } = useAuthz();
    const { openDialer } = useSoftPhone();
    const isMobile = useIsMobile();
    const [runningType, setRunningType] = useState<TaskAction['type'] | null>(null);
    const [robotModalOpen, setRobotModalOpen] = useState(false);

    // Self-gate: the execute route requires tasks.manage — never show a button that
    // would 403 on click (matches Job-card + Pulse gating).
    if (!hasPermission('tasks.manage')) return null;
    if (done || !actions || actions.length === 0) return null;

    const runAction = async (action: TaskAction) => {
        if (runningType) return;
        // robot_call: open the slot-picker modal (SLOTPICK-001) — the dispatcher
        // explicitly picks a slot there; that modal is the single confirm and owns
        // the POST. Needs a linked job for coords; without one, toast and bail.
        if (action.type === 'robot_call') {
            if (jobId == null) { toast.error('This task has no linked job to schedule'); return; }
            setRobotModalOpen(true);
            return;
        }
        // manual_call: pure client affordance — dial the returned number. Desktop →
        // softphone; mobile has no softphone (MOBILE-NO-SOFTPHONE-001) → native tel:.
        setRunningType(action.type);
        try {
            const result = await runTaskAction(id, action.type);
            const dir = result.client;
            const dialPhone = (dir?.action === 'open_softphone' ? dir.phone : null) || phone || null;
            const dialName = dir?.contactName || contactName || undefined;
            if (dialPhone) {
                if (isMobile) window.location.href = `tel:${dialPhone.replace(/[^\d+]/g, '')}`;
                else openDialer(dialPhone, dialName);
            } else {
                toast.error('No reachable number for this task');
            }
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

            {/* SLOTPICK-001: robot_call opens the slot-picker (reuses CustomTimeModal).
                Guarded on jobId so it only mounts when there's a job to schedule. */}
            {jobId != null && (
                <RobotCallSlotModal
                    open={robotModalOpen}
                    onClose={() => setRobotModalOpen(false)}
                    taskId={id}
                    jobId={jobId}
                    onQueued={onChanged}
                />
            )}
        </div>
    );
}
