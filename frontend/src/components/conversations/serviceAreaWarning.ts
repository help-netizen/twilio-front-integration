export function serviceAreaSelectionWarning({
    hasSelection,
    lookupFailed,
    eligible,
}: {
    hasSelection: boolean;
    lookupFailed: boolean;
    eligible?: boolean;
}): string | null {
    if (!hasSelection) return null;
    if (lookupFailed) return 'Service-area eligibility could not be verified';
    if (eligible === false) return "This technician isn't assigned to this Albusto service area";
    return null;
}
