/**
 * flowResumeRouter.ts
 *
 * Resumes the Blanc call flow after the Vapi AI leg ends.
 * Called by the Twilio <Dial> action callback handler.
 *
 * Returns TwiML for the next step based on the node output.
 *
 * Stage 1: Simple routing based on DialCallStatus.
 * Future: Full flow engine integration with edge-based routing.
 */

export interface FlowResumeInput {
    flowId: string;
    nodeId: string;
    groupId: string;
    nodeOutput: string; // 'completed' | 'error' | 'timeout' | 'caller_hangup' | 'transferred'
    callSid: string;
    dialCallSid?: string;
    dialDuration: number;
}

/**
 * Resume the flow after the Vapi Agent Node.
 *
 * Returns TwiML string for Twilio to execute.
 *
 * Stage 1 behavior:
 * - completed → Say a brief message, then hangup (or connect to dispatcher)
 * - error     → Play error message, end call
 * - timeout   → Play timeout message, end call
 * - caller_hangup → No TwiML needed (call is already ended)
 *
 * Future: This will query the flow engine to find the next node
 * based on the edge connected to the output port.
 */
export async function resumeFlow(input: FlowResumeInput): Promise<string> {
    const { flowId, nodeId, groupId, nodeOutput, dialDuration } = input;

    console.log(`[flow-resume] Resuming flow=${flowId} node=${nodeId} output=${nodeOutput}`);

    switch (nodeOutput) {
        case 'completed':
            // AI conversation ended normally.
            // Stage 1: Simple end. Future: route to next node in flow.
            return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Thank you for calling. One of our team members will follow up with you shortly. Goodbye.</Say>
  <Hangup/>
</Response>`;

        case 'transferred':
            // AI initiated a live transfer — call is already routed.
            // Nothing to do on this leg.
            return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`;

        case 'error':
            // SIP connection or runtime error
            console.error(`[flow-resume] Error in Vapi Agent Node: flow=${flowId} node=${nodeId}`);
            return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>We apologize for the inconvenience. Please hold while we connect you to a team member.</Say>
  <Hangup/>
</Response>`;

        case 'timeout':
            // AI leg exceeded max duration
            return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Thank you for your patience. We'll have someone get back to you shortly. Goodbye.</Say>
  <Hangup/>
</Response>`;

        case 'caller_hangup':
            // Caller already hung up — end gracefully
            return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`;

        default:
            console.warn(`[flow-resume] Unknown node output: ${nodeOutput}`);
            return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Thank you for calling. Goodbye.</Say>
  <Hangup/>
</Response>`;
    }
}
