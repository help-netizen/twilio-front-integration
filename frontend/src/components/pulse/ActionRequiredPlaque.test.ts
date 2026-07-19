import { describe, expect, it } from 'vitest';
import plaqueSource from './ActionRequiredPlaque.tsx?raw';
import mutationSource from '../tasks/useTaskMutations.ts?raw';
import assignSource from '../tasks/TaskAssignMenu.tsx?raw';
import { remainingTasksAfterCompletion, shouldShowActionRequiredPlaque } from './actionRequiredHelpers';

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
