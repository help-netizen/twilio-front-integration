import { useEffect, useState } from 'react';
import { CheckCircle2, Clock } from 'lucide-react';
import { useAuthz } from '../../hooks/useAuthz';
import type { PulseTask } from '../../types/pulse';
import { formatDeadline } from '../tasks/taskUtils';
import { TaskActionButtons } from '../tasks/TaskActionButtons';
import { TaskAssignMenu } from '../tasks/TaskAssignMenu';
import { TaskSnoozeMenu } from '../tasks/TaskSnoozeMenu';
import { useTaskMutations } from '../tasks/useTaskMutations';
import { AssignOwnerDropdown } from './AssignOwnerDropdown';
import { REASON_LABELS } from './PulseContactItem';
import { SnoozeDropdown } from './SnoozeDropdown';
import { remainingTasksAfterCompletion, shouldShowActionRequiredPlaque } from './actionRequiredHelpers';

interface Props {
    timelineId: number | null;
    tasks: PulseTask[];
    isManuallyRequired: boolean;
    reason?: string | null;
    snoozedUntil?: string | null;
    companyTz: string;
    phone?: string | null;
    contactName?: string | null;
    onChanged: () => void | Promise<unknown>;
    onClearManual: () => void;
    onSnoozeManual: (until: string) => void;
}

function taskTitle(task: PulseTask): string {
    const title = task.description || task.title;
    if (task.kind === 'agent' && task.agent_output?.reason) {
        return `${title}. ${task.agent_output.reason}`;
    }
    return title;
}

export function ActionRequiredPlaque({
    timelineId,
    tasks,
    isManuallyRequired,
    reason,
    snoozedUntil,
    companyTz,
    phone,
    contactName,
    onChanged,
    onClearManual,
    onSnoozeManual,
}: Props) {
    const { user, hasPermission, hasAnyPermission } = useAuthz();
    const [visibleTasks, setVisibleTasks] = useState(tasks);

    useEffect(() => setVisibleTasks(tasks), [tasks]);

    const mutations = useTaskMutations({
        refetch: onChanged,
        onOptimisticComplete: taskId => {
            setVisibleTasks(current => remainingTasksAfterCompletion(current, taskId));
        },
    });

    const canActOn = (task: PulseTask) => hasPermission('tasks.view') && (
        hasPermission('tasks.manage')
        || (!!user?.email && (task.assignee_email === user.email || task.author_email === user.email))
    );
    const canAssign = (task: PulseTask) => canActOn(task)
        && hasAnyPermission('tasks.create', 'tasks.manage');

    const manualOnly = tasks.length === 0 && isManuallyRequired;
    if (!shouldShowActionRequiredPlaque(visibleTasks, manualOnly)) return null;

    const manualSnoozed = manualOnly && !!snoozedUntil && new Date(snoozedUntil) > new Date();

    return (
        // Sticky moved to the shared .pulse-sticky-stack wrapper (PULSE-CONTACT-PIN-001):
        // the plaque and the pinned contact bar must stick as ONE stack, not fight for top:0.
        <section className="pulse-card pulse-card-visible-overflow pulse-ar-plaque" aria-label="Action Required">
            <div className="blanc-eyebrow pulse-ar-eyebrow">Action Required</div>
            {visibleTasks.length > 0 && (
                <div className="pulse-ar-task-list">
                    {visibleTasks.map(task => {
                        const canAct = canActOn(task);
                        return (
                            <div className="pulse-ar-task-item" key={task.id} data-task-id={task.id}>
                                <div className="pulse-ar-task-row">
                                    <span className="pulse-ar-task-copy" title={taskTitle(task)}>{taskTitle(task)}</span>
                                    {task.due_at && (
                                        <span className="pulse-ar-task-due">Due {formatDeadline(task.due_at, companyTz)}</span>
                                    )}
                                    {canAct && (
                                        <div className="pulse-ar-task-actions">
                                            <button
                                                type="button"
                                                className="pulse-ar-task-action pulse-ar-task-action-done"
                                                aria-label="Done"
                                                title="Done"
                                                data-task-id={task.id}
                                                onClick={() => mutations.complete(task)}
                                            >
                                                <CheckCircle2 aria-hidden="true" />
                                                <span className="pulse-ar-task-action-label">Done</span>
                                            </button>
                                            <TaskSnoozeMenu
                                                tz={companyTz}
                                                onSnooze={until => mutations.snooze(task, until)}
                                                trigger={(
                                                    <button
                                                        type="button"
                                                        className="pulse-ar-task-action"
                                                        aria-label="Snooze"
                                                        title="Snooze"
                                                        data-task-id={task.id}
                                                    >
                                                        <Clock aria-hidden="true" />
                                                        <span className="pulse-ar-task-action-label">Snooze</span>
                                                    </button>
                                                )}
                                            />
                                            {canAssign(task) && (
                                                <TaskAssignMenu
                                                    taskId={task.id}
                                                    onAssign={ownerUserId => mutations.assign(task, ownerUserId)}
                                                />
                                            )}
                                        </div>
                                    )}
                                </div>
                                {(task.actions?.length ?? 0) > 0 && (
                                    <div className="pulse-ar-task-extra-actions">
                                        <TaskActionButtons
                                            id={task.id}
                                            actions={task.actions}
                                            done={false}
                                            phone={phone}
                                            contactName={contactName}
                                            jobId={task.parent_type === 'job' ? task.parent_id : undefined}
                                            onChanged={onChanged}
                                        />
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
            {manualOnly && (
                <div className="pulse-ar-task-row pulse-ar-manual-row">
                    <span className="pulse-ar-task-copy">
                        {REASON_LABELS[reason || 'manual'] || reason || 'Manual follow-up'}
                    </span>
                    {manualSnoozed && (
                        <span className="pulse-ar-task-due">
                            Snoozed until {new Date(snoozedUntil!).toLocaleString('en-US', {
                                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: companyTz,
                            })}
                        </span>
                    )}
                    {!manualSnoozed && (
                        <div className="pulse-ar-task-actions">
                            <button
                                type="button"
                                className="pulse-ar-task-action pulse-ar-task-action-done"
                                aria-label="Done"
                                title="Done"
                                onClick={onClearManual}
                            >
                                <CheckCircle2 aria-hidden="true" />
                                <span className="pulse-ar-task-action-label">Done</span>
                            </button>
                            <SnoozeDropdown companyTz={companyTz} onSnooze={onSnoozeManual} compact />
                            <AssignOwnerDropdown timelineId={timelineId} onAssigned={onChanged} compact />
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}
