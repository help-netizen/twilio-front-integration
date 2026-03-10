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
    /** Return assistantId for a persistent assistant */
    assistantId?: string;
    /** OR return a transient assistant definition */
    assistant?: Record<string, any>;
    /** OR return a destination to skip AI entirely */
    destination?: Record<string, any>;
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
};

/**
 * Resolve the assistant for an incoming call.
 *
 * Decision logic (Stage 1):
 * 1. Look up the assistant profile ID in the registry
 * 2. If found, return { assistantId }
 * 3. If not found, return a transient fallback assistant
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
    const { assistantProfile, companyId, groupId, languageHint } = input;

    // Stage 1: Simple profile-based lookup
    const assistantId = ASSISTANT_PROFILES[assistantProfile];

    if (assistantId) {
        return { assistantId };
    }

    // Fallback: return a transient assistant definition
    // This ensures calls always get answered even if config is missing.
    console.warn(
        `[resolve-assistant] Profile "${assistantProfile}" not found in registry. ` +
        `Using transient fallback for company=${companyId}, group=${groupId}.`
    );

    return {
        assistant: {
            name: `Fallback Greeting (${companyId})`,
            firstMessage:
                'Hello, thank you for calling. How can I help you today?',
            firstMessageMode: 'assistant-speaks-first',
            model: {
                provider: 'openai',
                model: 'gpt-4o',
                temperature: 0.7,
                maxTokens: 300,
                messages: [
                    {
                        role: 'system',
                        content: `You are a friendly and professional phone receptionist for an appliance repair company.
Your job is to:
- Greet the caller warmly
- Ask how you can help
- Keep responses short (1-2 sentences)
- Be polite and professional

Do NOT:
- Promise appointments or scheduling
- Quote prices
- Transfer to a human (not yet implemented)
- Attempt deep qualification

Language preference: ${languageHint}`,
                    },
                ],
            },
            voice: {
                provider: 'azure',
                voiceId: 'andrew',
                speed: 1.0,
            },
            maxDurationSeconds: 300,
        },
    };
}
