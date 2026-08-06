'use strict';

const BLANC_STATUSES = [
    'Submitted',
    'Waiting for parts',
    'Part arrived',
    'Follow Up with Client',
    'Visit completed',
    'Job is Done',
    'Rescheduled',
    'Canceled',
    'On the way',
];

const ALLOWED_TRANSITIONS = {
    'Submitted': ['Follow Up with Client', 'Waiting for parts', 'Canceled', 'On the way'],
    'Waiting for parts': ['Submitted', 'Follow Up with Client', 'Canceled', 'Part arrived'],
    'Part arrived': ['On the way', 'Visit completed', 'Rescheduled', 'Waiting for parts', 'Follow Up with Client', 'Submitted', 'Canceled'],
    'Follow Up with Client': ['Waiting for parts', 'Submitted', 'Canceled'],
    'Visit completed': ['Follow Up with Client', 'Job is Done', 'Canceled'],
    'Job is Done': ['Canceled'],
    'Rescheduled': ['Submitted', 'Canceled', 'On the way'],
    'Canceled': [],
    'On the way': ['Visit completed', 'Canceled'],
};

function fallbackEvent(target) {
    return `TO_${target.toUpperCase().replace(/ /g, '_')}`;
}

function getFallbackJobActions(currentState) {
    const allowed = ALLOWED_TRANSITIONS[currentState] || [];
    return allowed.map((target, index) => ({
        event: fallbackEvent(target),
        target: target,
        targetStatusName: target,
        label: target,
        icon: null,
        confirm: target === 'Canceled',
        confirmText: target === 'Canceled' ? 'Are you sure you want to cancel this job?' : null,
        roles: [],
        order: (index + 1) * 10,
        action: true,
        button: true,
        variant: 'neutral',
        op: null,
    }));
}

function resolveFallbackJobTransition(currentState, eventOrTarget) {
    const action = getFallbackJobActions(currentState).find(candidate => (
        candidate.event === eventOrTarget || candidate.targetStatusName === eventOrTarget
    ));
    if (!action) return { valid: false, fallback: true, error: 'Transition not allowed' };
    return {
        valid: true,
        fallback: true,
        targetState: action.targetStatusName,
        event: action.event,
        transition: action,
        op: null,
    };
}

module.exports = {
    ALLOWED_TRANSITIONS,
    BLANC_STATUSES,
    getFallbackJobActions,
    resolveFallbackJobTransition,
};
