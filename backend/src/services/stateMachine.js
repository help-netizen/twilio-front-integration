/**
 * Call State Machine
 * 
 * Manages call status transitions and lifecycle state tracking.
 * Prevents invalid state transitions and manages final/frozen states.
 */

/**
 * Call status definitions
 */
const CallStatus = {
    // Non-final (active) statuses
    QUEUED: 'queued',
    INITIATED: 'initiated',
    RINGING: 'ringing',
    IN_PROGRESS: 'in-progress',
    VOICEMAIL_RECORDING: 'voicemail_recording',

    // Final (terminal) statuses
    COMPLETED: 'completed',
    BUSY: 'busy',
    NO_ANSWER: 'no-answer',
    CANCELED: 'canceled',
    FAILED: 'failed',
    VOICEMAIL_LEFT: 'voicemail_left'
};

/**
 * State categories
 */
const NON_FINAL_STATUSES = [
    CallStatus.QUEUED,
    CallStatus.INITIATED,
    CallStatus.RINGING,
    CallStatus.IN_PROGRESS,
    CallStatus.VOICEMAIL_RECORDING
];

const FINAL_STATUSES = [
    CallStatus.COMPLETED,
    CallStatus.BUSY,
    CallStatus.NO_ANSWER,
    CallStatus.CANCELED,
    CallStatus.FAILED,
    CallStatus.VOICEMAIL_LEFT
];

/**
 * Valid state transitions
 * Maps: fromStatus -> [allowedToStatuses]
 */
const VALID_TRANSITIONS = {
    [CallStatus.QUEUED]: [
        CallStatus.INITIATED,
        CallStatus.RINGING,
        CallStatus.IN_PROGRESS,
        CallStatus.COMPLETED,
        CallStatus.CANCELED,
        CallStatus.FAILED
    ],
    [CallStatus.INITIATED]: [
        CallStatus.RINGING,
        CallStatus.IN_PROGRESS,
        CallStatus.COMPLETED,
        CallStatus.BUSY,
        CallStatus.NO_ANSWER,
        CallStatus.CANCELED,
        CallStatus.FAILED
    ],
    [CallStatus.RINGING]: [
        CallStatus.IN_PROGRESS,
        CallStatus.COMPLETED,
        CallStatus.BUSY,
        CallStatus.NO_ANSWER,
        CallStatus.CANCELED,
        CallStatus.FAILED
    ],
    [CallStatus.IN_PROGRESS]: [
        CallStatus.COMPLETED,
        CallStatus.FAILED,
        CallStatus.VOICEMAIL_RECORDING
    ],
    [CallStatus.VOICEMAIL_RECORDING]: [
        CallStatus.VOICEMAIL_LEFT,
        CallStatus.COMPLETED,
        CallStatus.FAILED
    ],
    // Final statuses cannot transition (except to themselves for idempotency)
    [CallStatus.COMPLETED]: [CallStatus.COMPLETED],
    [CallStatus.BUSY]: [CallStatus.BUSY],
    [CallStatus.NO_ANSWER]: [CallStatus.NO_ANSWER, CallStatus.VOICEMAIL_RECORDING],
    [CallStatus.CANCELED]: [CallStatus.CANCELED, CallStatus.VOICEMAIL_RECORDING],
    [CallStatus.FAILED]: [CallStatus.FAILED],
    [CallStatus.VOICEMAIL_LEFT]: [CallStatus.VOICEMAIL_LEFT]
};

/**
 * Check if status is final
 */
function isFinalStatus(status) {
    return FINAL_STATUSES.includes(status?.toLowerCase());
}

/**
 * Check if status is non-final (active)
 */
function isActiveStatus(status) {
    return NON_FINAL_STATUSES.includes(status?.toLowerCase());
}

/**
 * Validate state transition
 * @param {string} fromStatus - Current status
 * @param {string} toStatus - New status
 * @returns {Object} - { valid: boolean, reason?: string }
 */
function validateTransition(fromStatus, toStatus) {
    const from = fromStatus?.toLowerCase();
    const to = toStatus?.toLowerCase();

    // Allow initial state (no previous status)
    if (!from) {
        return { valid: true };
    }

    // Normalize and check if statuses exist
    if (!VALID_TRANSITIONS[from]) {
        return {
            valid: false,
            reason: `Unknown source status: ${fromStatus}`
        };
    }

    if (!Object.values(CallStatus).includes(to)) {
        return {
            valid: false,
            reason: `Unknown target status: ${toStatus}`
        };
    }

    // Check if transition is allowed
    const allowedTransitions = VALID_TRANSITIONS[from];
    if (!allowedTransitions.includes(to)) {
        return {
            valid: false,
            reason: `Invalid transition: ${fromStatus} → ${toStatus}`
        };
    }

    return { valid: true };
}

/**
 * Determine if call should be frozen (no longer polled)
 * Freeze policy: final + cooldown period elapsed
 * 
 * @param {Object} call - Call record with finalized_at timestamp
 * @param {number} cooldownHours - Cooldown period in hours (default: 6)
 * @returns {boolean} - True if call should be frozen
 */
function shouldFreeze(call, cooldownHours = 6) {
    if (!call.is_final || !call.finalized_at) {
        return false;
    }

    const finalizedAt = new Date(call.finalized_at);
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    const now = new Date();

    return (now - finalizedAt) > cooldownMs;
}

/**
 * Get state metadata for status
 * @param {string} status
 * @returns {Object} - { isFinal, category, description }
 */
function getStatusMetadata(status) {
    const normalized = status?.toLowerCase();

    const isFinal = isFinalStatus(normalized);
    const isActive = isActiveStatus(normalized);

    let category = 'unknown';
    let description = '';

    if (isActive) {
        category = 'active';
        description = 'Call is in progress';
    } else if (isFinal) {
        category = 'final';

        switch (normalized) {
            case CallStatus.COMPLETED:
                description = 'Call completed successfully';
                break;
            case CallStatus.BUSY:
                description = 'Recipient was busy';
                break;
            case CallStatus.NO_ANSWER:
                description = 'Recipient did not answer';
                break;
            case CallStatus.CANCELED:
                description = 'Call was canceled';
                break;
            case CallStatus.FAILED:
                description = 'Call failed';
                break;
            case CallStatus.VOICEMAIL_LEFT:
                description = 'Voicemail was left';
                break;
        }
    }

    return {
        isFinal,
        isActive,
        category,
        description,
        allowedTransitions: VALID_TRANSITIONS[normalized] || []
    };
}

/**
 * Apply state transition with validation
 * @param {Object} currentState - Current call state { status, is_final, finalized_at }
 * @param {string} newStatus - New status to transition to
 * @param {boolean} strict - If true, throw error on invalid transition
 * @returns {Object} - Updated state { status, is_final, finalized_at, sync_state }
 */
function applyTransition(currentState, newStatus, strict = false) {
    const validation = validateTransition(currentState.status, newStatus);

    if (!validation.valid) {
        const error = new Error(validation.reason);
        error.code = 'INVALID_TRANSITION';
        error.fromStatus = currentState.status;
        error.toStatus = newStatus;

        if (strict) {
            throw error;
        }

        console.warn('Invalid state transition (ignored in non-strict mode):', {
            from: currentState.status,
            to: newStatus,
            reason: validation.reason
        });

        // In non-strict mode, keep current state
        return currentState;
    }

    const normalized = newStatus.toLowerCase();
    const isFinal = isFinalStatus(normalized);

    const newState = {
        status: normalized,
        is_final: isFinal
    };

    // Set finalized_at if transitioning to final state
    if (isFinal && !currentState.is_final) {
        newState.finalized_at = new Date();
    } else {
        newState.finalized_at = currentState.finalized_at;
    }

    // Check if should freeze
    if (shouldFreeze({ ...currentState, ...newState })) {
        newState.sync_state = 'frozen';
    } else {
        newState.sync_state = currentState.sync_state || 'active';
    }

    return newState;
}

module.exports = {
    CallStatus,
    NON_FINAL_STATUSES,
    FINAL_STATUSES,
    VALID_TRANSITIONS,
    isFinalStatus,
    isActiveStatus,
    validateTransition,
    shouldFreeze,
    getStatusMetadata,
    applyTransition
};
