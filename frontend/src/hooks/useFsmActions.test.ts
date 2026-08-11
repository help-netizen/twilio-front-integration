import { describe, expect, it } from 'vitest';
import { targetCarriesArrivalEta, type FsmAction } from './useFsmActions';

// FSM-SYSTEM-TRANSITIONS-001 — the "On the way" arrival-ETA behaviour is carried by
// the target status's FSM op (surfaced on the action into it). The frontend decides
// whether to open the notify-ETA modal purely from that op, never from a hardcoded
// status-name list (the retired ONWAY_SOURCE_STATUSES / edge notify_on_the_way).

function action(overrides: Partial<FsmAction> = {}): FsmAction {
    return {
        event: 'to_target',
        target: 'Some status',
        label: 'Some status',
        icon: null,
        confirm: false,
        confirmText: null,
        order: 0,
        roles: null,
        button: false,
        variant: 'primary',
        op: null,
        system: null,
        ...overrides,
    };
}

describe('targetCarriesArrivalEta', () => {
    const actions: FsmAction[] = [
        action({ target: 'On the way', label: 'On the way', button: true, op: 'arrival_eta', system: 'on_the_way' }),
        action({ target: 'In progress', label: 'Start job', button: true }),
        action({ target: 'Visit completed', label: 'Complete', button: true, system: 'visit_completed' }),
    ];

    it('is true for a target whose action declares op=arrival_eta', () => {
        expect(targetCarriesArrivalEta(actions, 'On the way')).toBe(true);
    });

    it('is false for a plain target with no op', () => {
        expect(targetCarriesArrivalEta(actions, 'In progress')).toBe(false);
    });

    it('is false for a system target that is not arrival_eta (e.g. visit_completed)', () => {
        expect(targetCarriesArrivalEta(actions, 'Visit completed')).toBe(false);
    });

    // Sabotage anchor: a status NAMED "On the way" but WITHOUT the op must not
    // trigger — the decision is op-driven, not name-driven. If someone reverts to
    // matching on the status name, this goes red.
    it('is false when a same-named target lacks the arrival_eta op', () => {
        const noOp: FsmAction[] = [action({ target: 'On the way', label: 'On the way', button: true, op: null })];
        expect(targetCarriesArrivalEta(noOp, 'On the way')).toBe(false);
    });

    it('is false for a target not present in the actions', () => {
        expect(targetCarriesArrivalEta(actions, 'Nonexistent')).toBe(false);
    });

    it('handles undefined and empty actions', () => {
        expect(targetCarriesArrivalEta(undefined, 'On the way')).toBe(false);
        expect(targetCarriesArrivalEta([], 'On the way')).toBe(false);
    });
});
