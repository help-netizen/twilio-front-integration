/**
 * resolveAssistantForCall.ts
 *
 * Maps runtime call context to the correct Vapi assistant.
 * Must be FAST — Vapi has a timeout on assistant-request responses.
 *
 * Stage 1: Simple profile-based lookup.
 * Future:  Per-group, per-brand, per-language, per-time resolution.
 */

export interface AssistantResolutionInput {
    companyId: string;
    groupId: string;
    flowId: string;
    nodeId: string;
    calledNumber: string;
    callerNumber: string;
    languageHint: string;
    assistantProfile: string;
    afterAiPolicy: string;
}

export interface AssistantResolutionResult {
    /** Return only a persistent assistant id. */
    assistantId?: string;
    /** Fail closed when no persistent, server-owned assistant exists. */
    error?: string;
}

/**
 * Assistant profile registry.
 *
 * Maps profile IDs to Vapi assistant IDs.
 * On Stage 1, this is a simple in-memory map.
 * Later, this could be backed by a database or config service.
 */
const ASSISTANT_PROFILES: Record<string, string> = {
    greeting_only_v1: '4339f404-9b71-454b-ba6d-8167392304f0',
    lead_qualifier_v2: '30e85a87-9d7e-4694-828e-1fea7d10f3ef',
};

/**
 * Resolve the assistant for an incoming call.
 *
 * Decision logic (Stage 1):
 * 1. Look up the assistant profile ID in the registry
 * 2. If found, return { assistantId }
 * 3. If not found, fail closed; transient assistants are forbidden
 *
 * Future expansion points:
 * - Per-group assistant overrides
 * - Per-language assistant selection
 * - Office-hours routing (return destination instead)
 * - A/B testing different assistant versions
 */
export async function resolveAssistantForCall(
    input: AssistantResolutionInput
): Promise<AssistantResolutionResult> {
    const { assistantProfile, companyId, groupId } = input;

    // Stage 1: Simple profile-based lookup
    const assistantId = ASSISTANT_PROFILES[assistantProfile];

    if (assistantId) {
        return { assistantId };
    }

    // VAPI-AGENCY-001 T2: this legacy prototype is not the supported runtime
    // selector. Keep it fail-closed until it is retired; never synthesize an
    // assistant from caller-controlled profile/company data.
    console.warn(
        `[resolve-assistant] Profile "${assistantProfile}" not found in registry. ` +
        `Refusing transient fallback for company=${companyId}, group=${groupId}.`
    );

    return {
        error: 'Assistant configuration is unavailable.',
    };
}
