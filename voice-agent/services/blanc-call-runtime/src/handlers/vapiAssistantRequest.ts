/**
 * vapiAssistantRequest.ts
 *
 * Handles Vapi's `assistant-request` server event.
 *
 * When a call reaches the Vapi SIP phone number resource (which has
 * assistantId=null and serverUrl pointing here), Vapi sends an
 * `assistant-request` event. This handler resolves the correct
 * assistant based on runtime context from SIP headers.
 *
 * Endpoint: POST /api/vapi/runtime
 *
 * Vapi expects one of:
 *   { "assistantId": "..." }
 *   { "assistant": { ... } }
 *   { "destination": { ... } }
 */

import { Request, Response } from 'express';
import { resolveAssistantForCall } from '../lib/resolveAssistantForCall';

interface VapiServerMessage {
    message: {
        type: string;
        call?: {
            id?: string;
            phoneNumber?: {
                sipUri?: string;
            };
            customer?: {
                number?: string;
            };
            // SIP headers are available via customSipHeaders or similar
            [key: string]: any;
        };
        [key: string]: any;
    };
}

export async function handleVapiAssistantRequest(req: Request, res: Response) {
    const startTime = Date.now();

    try {
        const body = req.body as VapiServerMessage;
        const messageType = body?.message?.type;

        // Only handle assistant-request events
        if (messageType !== 'assistant-request') {
            // For other event types (status-update, end-of-call-report, etc.),
            // acknowledge and return. These can be handled by separate handlers later.
            console.log(`[vapi-runtime] Received event: ${messageType} (ignoring)`);
            return res.status(200).json({ ok: true });
        }

        const call = body.message.call || {};

        // Extract SIP headers from the call context
        // Vapi passes custom SIP headers in the call object
        const sipHeaders = extractSipHeaders(call);

        console.log('[vapi-runtime] assistant-request received', {
            callId: call.id,
            companyId: sipHeaders.companyId,
            groupId: sipHeaders.groupId,
            flowId: sipHeaders.flowId,
            nodeId: sipHeaders.nodeId,
            assistantProfile: sipHeaders.assistantProfile,
        });

        // Resolve the assistant
        const resolution = await resolveAssistantForCall({
            companyId: sipHeaders.companyId,
            groupId: sipHeaders.groupId,
            flowId: sipHeaders.flowId,
            nodeId: sipHeaders.nodeId,
            calledNumber: sipHeaders.calledNumber,
            callerNumber: call.customer?.number || '',
            languageHint: sipHeaders.languageHint || 'en',
            assistantProfile: sipHeaders.assistantProfile || 'greeting_only_v1',
            afterAiPolicy: sipHeaders.afterAiPolicy || 'resume_flow',
        });

        const elapsed = Date.now() - startTime;
        console.log(`[vapi-runtime] Resolved in ${elapsed}ms:`, resolution);

        // Warn if resolution is slow (Vapi has a timeout on this)
        if (elapsed > 2000) {
            console.warn(`[vapi-runtime] ⚠️ Slow resolution: ${elapsed}ms`);
        }

        return res.status(200).json(resolution);
    } catch (error) {
        console.error('[vapi-runtime] Error handling assistant-request:', error);

        // On error, return a safe fallback — a minimal greeting assistant
        return res.status(200).json({
            assistant: {
                firstMessage: 'Thank you for calling. Please hold while we connect you.',
                model: {
                    provider: 'openai',
                    model: 'gpt-4o',
                    messages: [
                        {
                            role: 'system',
                            content:
                                'You are a brief receptionist. The system encountered an error resolving the assistant. Keep the caller on the line briefly and politely.',
                        },
                    ],
                },
            },
        });
    }
}

/**
 * Extract Blanc-specific SIP headers from the Vapi call object.
 * Headers are typically prefixed with x-blanc-.
 */
function extractSipHeaders(call: Record<string, any>) {
    // Vapi may pass SIP headers in different locations depending on version.
    // Check common locations: call.headers, call.sipHeaders, call.metadata
    const headers = call.headers || call.sipHeaders || call.metadata || {};

    return {
        companyId: headers['x-blanc-company-id'] || '',
        groupId: headers['x-blanc-group-id'] || '',
        flowId: headers['x-blanc-flow-id'] || '',
        nodeId: headers['x-blanc-node-id'] || '',
        calledNumber: headers['x-blanc-called-number'] || '',
        languageHint: headers['x-blanc-language-hint'] || 'en',
        assistantProfile: headers['x-blanc-assistant-profile'] || 'greeting_only_v1',
        afterAiPolicy: headers['x-blanc-after-ai-policy'] || 'resume_flow',
    };
}
