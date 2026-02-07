const {
    CallStatus,
    isFinalStatus,
    isActiveStatus,
    validateTransition,
    shouldFreeze,
    getStatusMetadata,
    applyTransition
} = require('../backend/src/services/stateMachine');

describe('Call State Machine', () => {
    describe('isFinalStatus', () => {
        it('should return true for final statuses', () => {
            expect(isFinalStatus('completed')).toBe(true);
            expect(isFinalStatus('busy')).toBe(true);
            expect(isFinalStatus('no-answer')).toBe(true);
            expect(isFinalStatus('canceled')).toBe(true);
            expect(isFinalStatus('failed')).toBe(true);
        });

        it('should return false for non-final statuses', () => {
            expect(isFinalStatus('queued')).toBe(false);
            expect(isFinalStatus('initiated')).toBe(false);
            expect(isFinalStatus('ringing')).toBe(false);
            expect(isFinalStatus('in-progress')).toBe(false);
        });

        it('should be case insensitive', () => {
            expect(isFinalStatus('COMPLETED')).toBe(true);
            expect(isFinalStatus('Queued')).toBe(false);
        });
    });

    describe('validateTransition', () => {
        it('should allow valid transitions', () => {
            expect(validateTransition('queued', 'ringing').valid).toBe(true);
            expect(validateTransition('ringing', 'in-progress').valid).toBe(true);
            expect(validateTransition('in-progress', 'completed').valid).toBe(true);
        });

        it('should reject invalid transitions', () => {
            const result = validateTransition('completed', 'in-progress');
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('Invalid transition');
        });

        it('should allow final status to stay the same (idempotency)', () => {
            expect(validateTransition('completed', 'completed').valid).toBe(true);
            expect(validateTransition('failed', 'failed').valid).toBe(true);
        });

        it('should reject backwards transitions', () => {
            expect(validateTransition('in-progress', 'queued').valid).toBe(false);
            expect(validateTransition('completed', 'ringing').valid).toBe(false);
        });

        it('should allow initial state (no fromStatus)', () => {
            expect(validateTransition(null, 'queued').valid).toBe(true);
            expect(validateTransition(undefined, 'ringing').valid).toBe(true);
        });
    });

    describe('shouldFreeze', () => {
        it('should not freeze non-final calls', () => {
            const call = {
                is_final: false,
                finalized_at: null
            };
            expect(shouldFreeze(call)).toBe(false);
        });

        it('should not freeze recently finalized calls', () => {
            const call = {
                is_final: true,
                finalized_at: new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 hours ago
            };
            expect(shouldFreeze(call, 6)).toBe(false);
        });

        it('should freeze calls after cooldown period', () => {
            const call = {
                is_final: true,
                finalized_at: new Date(Date.now() - 10 * 60 * 60 * 1000) // 10 hours ago
            };
            expect(shouldFreeze(call, 6)).toBe(true);
        });

        it('should respect custom cooldown period', () => {
            const call = {
                is_final: true,
                finalized_at: new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 hours ago
            };
            expect(shouldFreeze(call, 1)).toBe(true); // 1 hour cooldown
            expect(shouldFreeze(call, 3)).toBe(false); // 3 hour cooldown
        });
    });

    describe('getStatusMetadata', () => {
        it('should return correct metadata for active statuses', () => {
            const meta = getStatusMetadata('ringing');
            expect(meta.isActive).toBe(true);
            expect(meta.isFinal).toBe(false);
            expect(meta.category).toBe('active');
        });

        it('should return correct metadata for final statuses', () => {
            const meta = getStatusMetadata('completed');
            expect(meta.isFinal).toBe(true);
            expect(meta.isActive).toBe(false);
            expect(meta.category).toBe('final');
            expect(meta.description).toContain('completed successfully');
        });

        it('should include allowed transitions', () => {
            const meta = getStatusMetadata('queued');
            expect(meta.allowedTransitions).toContain('ringing');
            expect(meta.allowedTransitions).toContain('initiated');
        });
    });

    describe('applyTransition', () => {
        it('should apply valid transition and set is_final', () => {
            const currentState = {
                status: 'in-progress',
                is_final: false,
                finalized_at: null
            };

            const newState = applyTransition(currentState, 'completed');

            expect(newState.status).toBe('completed');
            expect(newState.is_final).toBe(true);
            expect(newState.finalized_at).toBeInstanceOf(Date);
        });

        it('should preserve finalized_at on subsequent updates', () => {
            const finalizedAt = new Date('2026-01-01');
            const currentState = {
                status: 'completed',
                is_final: true,
                finalized_at: finalizedAt
            };

            const newState = applyTransition(currentState, 'completed');

            expect(newState.finalized_at).toBe(finalizedAt);
        });

        it('should reject invalid transition in strict mode', () => {
            const currentState = {
                status: 'completed',
                is_final: true
            };

            expect(() => {
                applyTransition(currentState, 'queued', true);
            }).toThrow('Invalid transition');
        });

        it('should ignore invalid transition in non-strict mode', () => {
            const currentState = {
                status: 'completed',
                is_final: true,
                finalized_at: new Date()
            };

            const newState = applyTransition(currentState, 'queued', false);

            // Should keep current state
            expect(newState.status).toBe('completed');
        });

        it('should set sync_state to frozen after cooldown', () => {
            const currentState = {
                status: 'in-progress',
                is_final: false,
                finalized_at: null,
                sync_state: 'active'
            };

            // Mock shouldFreeze to return true
            const stateMachine = require('../backend/src/services/stateMachine');
            const originalShouldFreeze = stateMachine.shouldFreeze;
            stateMachine.shouldFreeze = jest.fn(() => true);

            const newState = applyTransition(currentState, 'completed');

            expect(newState.sync_state).toBe('frozen');

            // Restore
            stateMachine.shouldFreeze = originalShouldFreeze;
        });
    });
});
