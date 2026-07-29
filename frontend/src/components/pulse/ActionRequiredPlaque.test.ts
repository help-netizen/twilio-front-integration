import { describe, expect, it } from 'vitest';
import plaqueSource from './ActionRequiredPlaque.tsx?raw';
import mutationSource from '../tasks/useTaskMutations.ts?raw';
import assignSource from '../tasks/TaskAssignMenu.tsx?raw';
import { remainingTasksAfterCompletion, shouldShowActionRequiredPlaque, taskTitle } from './actionRequiredHelpers';

describe('ActionRequiredPlaque — AR-TASKS-001', () => {
    it('OB-11 regression: completing one row leaves the other open task visible', () => {
        const openTasks = [
            { id: 101, title: 'Confirm access' },
            { id: 102, title: 'Send revised estimate' },
        ];

        expect(remainingTasksAfterCompletion(openTasks, 101)).toEqual([
            { id: 102, title: 'Send revised estimate' },
        ]);
    });

    it('shows a taskless manual flag but no empty plaque', () => {
        expect(shouldShowActionRequiredPlaque([], true)).toBe(true);
        expect(shouldShowActionRequiredPlaque([], false)).toBe(false);
    });

    it('AR-TEXT-EXPAND-001: agent reason is NOT appended when the description already contains it', () => {
        const reason = 'The customer is confirming payment details and requesting the invoice be sent to their landlord for coordination.';
        const description = `${reason} From: dlee <d@x.com> Subject: Re: You have a new invoice.`;
        // Mail-Secretary shape: description already carries the reason → no doubling.
        expect(taskTitle({ title: 'Reply', description, kind: 'agent', agent_output: { reason } }))
            .toBe(description);
        // Reason genuinely absent from the description → still appended.
        expect(taskTitle({ title: 'Reply', description: 'Follow up with the customer', kind: 'agent', agent_output: { reason: 'Payment is blocked' } }))
            .toBe('Follow up with the customer. Payment is blocked');
        // Non-agent tasks never append.
        expect(taskTitle({ title: 'Call back', description: null, kind: 'user', agent_output: { reason: 'x' } }))
            .toBe('Call back');
    });

    it('AR-TEXT-EXPAND-001: the row copy is a tap-to-expand toggle', () => {
        expect(plaqueSource).toContain("pulse-ar-task-copy--expanded");
        expect(plaqueSource).toContain('onClick={() => toggleExpanded(task.id)}');
        expect(plaqueSource).toContain('aria-expanded={expanded}');
        // The hover tooltip is suppressed once expanded (the full text is visible).
        expect(plaqueSource).toContain('title={expanded ? undefined : taskTitle(task)}');
    });

    it('targets all three mutations by the row task, never by the timeline', () => {
        expect(plaqueSource).toContain('onClick={() => mutations.complete(task)}');
        expect(plaqueSource).toContain('onSnooze={until => mutations.snooze(task, until)}');
        expect(plaqueSource).toContain('onAssign={ownerUserId => mutations.assign(task, ownerUserId)}');
        expect(plaqueSource).not.toContain('pulseApi.markHandled');
        expect(mutationSource).toContain('await completeTask(task.id)');
        expect(mutationSource).toContain("label: 'Undo'");
    });

    it('keeps accessible names on every compact row action', () => {
        for (const label of ['Done', 'Snooze', 'Assign']) {
            expect(plaqueSource + assignSource).toContain(`aria-label="${label}"`);
        }
        expect(plaqueSource + assignSource).toContain('pulse-ar-task-action-label');
    });
});
