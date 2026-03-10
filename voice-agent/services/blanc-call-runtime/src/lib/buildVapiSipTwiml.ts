/**
 * buildVapiSipTwiml.ts
 *
 * Generates TwiML for the Vapi Agent Node.
 * Creates a <Dial><Sip> element that bridges the active Twilio call
 * to the Vapi SIP endpoint with runtime context in SIP headers.
 */

export interface VapiSipTwimlOptions {
    /** SIP URI, e.g. "sip:blanc-ai-prod@sip.vapi.ai" */
    sipUri: string;

    /** Action callback URL (where Twilio sends the Dial result) */
    actionUrl: string;

    /** Query params for the action URL */
    actionQuery: Record<string, string>;

    /** SIP headers to pass to Vapi (x-blanc-* headers) */
    sipHeaders: Record<string, string>;

    /** Max ring time for the SIP leg (seconds) */
    timeout?: number;
}

/**
 * Build the TwiML response for a Vapi Agent Node.
 *
 * Example output:
 * ```xml
 * <?xml version="1.0" encoding="UTF-8"?>
 * <Response>
 *   <Dial action="https://blanc.example.com/api/twilio/vapi-agent-action?flowId=xxx&nodeId=yyy"
 *         method="POST" answerOnBridge="true" timeout="60">
 *     <Sip>sip:blanc-ai-prod@sip.vapi.ai?x-blanc-company-id=abc&amp;x-blanc-group-id=grp_001</Sip>
 *   </Dial>
 * </Response>
 * ```
 */
export function buildVapiSipTwiml(options: VapiSipTwimlOptions): string {
    const { sipUri, actionUrl, actionQuery, sipHeaders, timeout = 60 } = options;

    // Build action URL with query params
    const queryString = Object.entries(actionQuery)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&amp;');

    const fullActionUrl = queryString
        ? `${actionUrl}?${queryString}`
        : actionUrl;

    // Build SIP URI with x- headers as query params
    const sipQueryString = Object.entries(sipHeaders)
        .filter(([_, v]) => v !== '' && v !== undefined && v !== null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&amp;');

    const fullSipUri = sipQueryString
        ? `${sipUri}?${sipQueryString}`
        : sipUri;

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial action="${fullActionUrl}" method="POST" answerOnBridge="true" timeout="${timeout}">
    <Sip>${fullSipUri}</Sip>
  </Dial>
</Response>`;
}

/**
 * Convenience function to build TwiML from a Vapi Agent Node context.
 */
export function buildTwimlForVapiAgentNode(params: {
    environment: string;
    sipIngressAlias: string;
    blancBaseUrl: string;
    flowId: string;
    nodeId: string;
    groupId: string;
    companyId: string;
    calledNumber: string;
    languageHint: string;
    assistantProfile: string;
    afterAiPolicy: string;
}): string {
    return buildVapiSipTwiml({
        sipUri: `sip:${params.sipIngressAlias}@sip.vapi.ai`,
        actionUrl: `${params.blancBaseUrl}/api/twilio/vapi-agent-action`,
        actionQuery: {
            flowId: params.flowId,
            nodeId: params.nodeId,
            groupId: params.groupId,
        },
        sipHeaders: {
            'x-blanc-company-id': params.companyId,
            'x-blanc-group-id': params.groupId,
            'x-blanc-flow-id': params.flowId,
            'x-blanc-node-id': params.nodeId,
            'x-blanc-called-number': params.calledNumber,
            'x-blanc-language-hint': params.languageHint,
            'x-blanc-assistant-profile': params.assistantProfile,
            'x-blanc-after-ai-policy': params.afterAiPolicy,
        },
    });
}
