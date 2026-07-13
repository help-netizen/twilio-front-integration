import { describe, expect, it } from 'vitest';
import { deriveWizardStep, shouldShowTransferBanner } from './portInPrompt';

describe('deriveWizardStep', () => {
    it('starts on the plan step when neither the plan nor number is done', () => {
        expect(deriveWizardStep({ donePlan: false, doneNumber: false, doneTransfer: false })).toBe(1);
    });

    it('moves to the number step when a plan is done', () => {
        expect(deriveWizardStep({ donePlan: true, doneNumber: false, doneTransfer: false })).toBe(2);
    });

    it('moves to the transfer step once a number is ready', () => {
        expect(deriveWizardStep({ donePlan: false, doneNumber: true, doneTransfer: false })).toBe(3);
    });

    it('completes only when both number and transfer decisions are done', () => {
        expect(deriveWizardStep({ donePlan: true, doneNumber: true, doneTransfer: true })).toBe(4);
        expect(deriveWizardStep({ donePlan: false, doneNumber: false, doneTransfer: true })).toBe(1);
    });
});

describe('shouldShowTransferBanner', () => {
    const visibleState = {
        connected: true,
        numbersCount: 1,
        portRequestsCount: 0,
        portInPrompt: null,
    };

    it('shows after a connected company has a number but no transfer request or dismissal', () => {
        expect(shouldShowTransferBanner(visibleState)).toBe(true);
    });

    it('stays hidden until telephony is connected and a number exists', () => {
        expect(shouldShowTransferBanner({ ...visibleState, connected: false })).toBe(false);
        expect(shouldShowTransferBanner({ ...visibleState, numbersCount: 0 })).toBe(false);
    });

    it('stays hidden after any transfer request', () => {
        expect(shouldShowTransferBanner({ ...visibleState, portRequestsCount: 1 })).toBe(false);
    });

    it('stays hidden after the prompt is dismissed', () => {
        expect(shouldShowTransferBanner({ ...visibleState, portInPrompt: 'dismissed' })).toBe(false);
    });
});
