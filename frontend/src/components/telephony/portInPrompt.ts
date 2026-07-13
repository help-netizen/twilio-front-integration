interface WizardStepState {
    donePlan: boolean;
    doneNumber: boolean;
    doneTransfer: boolean;
}

interface TransferBannerState {
    connected: boolean;
    numbersCount: number;
    portRequestsCount: number;
    portInPrompt: string | null | undefined;
}

export function deriveWizardStep({
    donePlan,
    doneNumber,
    doneTransfer,
}: WizardStepState): 1 | 2 | 3 | 4 {
    if (!doneNumber) return donePlan ? 2 : 1;
    return doneTransfer ? 4 : 3;
}

export function shouldShowTransferBanner({
    connected,
    numbersCount,
    portRequestsCount,
    portInPrompt,
}: TransferBannerState): boolean {
    return connected
        && numbersCount >= 1
        && portRequestsCount === 0
        && portInPrompt !== 'dismissed';
}
