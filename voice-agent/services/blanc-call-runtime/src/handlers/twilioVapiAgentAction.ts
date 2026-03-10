/**
 * twilioVapiAgentAction.ts
 *
 * Handles the Twilio <Dial> action callback after the Vapi SIP leg ends.
 *
 * When the AI conversation finishes (or the SIP leg fails), Twilio calls
 * this endpoint with DialCallStatus and other parameters. This handler
 * decides how to continue the Blanc flow.
 *
 * Endpoint: POST /api/twilio/vapi-agent-action
 *
 * Query params (from action URL):
 *   flowId, nodeId, groupId
 *
 * POST body (from Twilio):
 *   DialCallStatus, DialCallSid, DialCallDuration, CallSid, etc.
 */

import { Request, Response } from 'express';
import { resumeFlow } from '../lib/flowResumeRouter';

// Twilio DialCallStatus values
type DialCallStatus =
    | 'completed'
    | 'answered'
    | 'busy'
    | 'no-answer'
    | 'failed'
    | 'canceled';

interface TwilioDialActionParams {
    DialCallStatus: DialCallStatus;
    DialCallSid?: string;
    DialCallDuration?: string;
    DialBridged?: string;
    CallSid: string;
    CallStatus?: string;
}

export async function handleTwilioVapiAgentAction(req: Request, res: Response) {
    try {
        const body = req.body as TwilioDialActionParams;
        const query = req.query as Record<string, string>;

        const flowId = query.flowId || '';
        const nodeId = query.nodeId || '';
        const groupId = query.groupId || '';

        const dialStatus = body.DialCallStatus;
        const dialDuration = parseInt(body.DialCallDuration || '0', 10);

        console.log('[vapi-agent-action] Dial callback received', {
            callSid: body.CallSid,
            dialCallSid: body.DialCallSid,
            dialStatus,
            dialDuration,
            flowId,
            nodeId,
            groupId,
        });

        // Determine node output based on DialCallStatus
        let nodeOutput: string;

        switch (dialStatus) {
            case 'completed':
            case 'answered':
                // SIP leg was established and ended normally
                nodeOutput = 'completed';
                break;

            case 'busy':
            case 'no-answer':
            case 'failed':
                // SIP connection failed
                nodeOutput = 'error';
                break;

            case 'canceled':
                // Usually means caller hung up before bridge
                nodeOutput = 'caller_hangup';
                break;

            default:
                console.warn(`[vapi-agent-action] Unknown DialCallStatus: ${dialStatus}`);
                nodeOutput = 'error';
        }

        // Check if caller hung up during the conversation
        if (body.CallStatus === 'completed' && dialStatus === 'completed' && dialDuration === 0) {
            nodeOutput = 'caller_hangup';
        }

        console.log(`[vapi-agent-action] Node output: ${nodeOutput}`);

        // Resume the flow based on the node output
        const twiml = await resumeFlow({
            flowId,
            nodeId,
            groupId,
            nodeOutput,
            callSid: body.CallSid,
            dialCallSid: body.DialCallSid,
            dialDuration,
        });

        // Return TwiML for the next step
        res.type('text/xml');
        return res.status(200).send(twiml);
    } catch (error) {
        console.error('[vapi-agent-action] Error:', error);

        // On error, end the call gracefully
        res.type('text/xml');
        return res.status(200).send(
            `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>We're sorry, we encountered a technical issue. Please try calling again.</Say>
  <Hangup/>
</Response>`
        );
    }
}
