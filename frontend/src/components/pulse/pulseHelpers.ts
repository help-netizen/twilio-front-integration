import type { CallData } from '../call-list-item';

// =============================================================================
// Convert API call to CallData (same logic as ConversationPage)
// =============================================================================
export function callToCallData(call: any): CallData {
    const direction: CallData['direction'] =
        (call.direction || '').includes('inbound') ? 'incoming' : 'outgoing';

    const statusMap: Record<string, CallData['status']> = {
        'completed': 'completed', 'no-answer': 'no-answer', 'busy': 'busy',
        'failed': 'failed', 'canceled': 'failed', 'ringing': 'ringing',
        'in-progress': 'in-progress', 'queued': 'ringing', 'initiated': 'ringing',
        'voicemail_recording': 'voicemail_recording', 'voicemail_left': 'voicemail_left',
    };
    const status = statusMap[call.status || 'completed'] || 'completed';

    const startTime = call.started_at ? new Date(call.started_at) : new Date(call.created_at);
    const endTime = call.ended_at ? new Date(call.ended_at) : startTime;

    return {
        id: String(call.id), direction,
        from: call.from_number || '', to: call.to_number || '',
        duration: call.duration_sec, status, startTime, endTime,
        cost: call.price ? parseFloat(call.price) : undefined,
        callSid: call.call_sid, queueTime: 0,
        parentCall: call.parent_call_sid || undefined,
        twilioDirection: call.direction,
        audioUrl: call.recording?.playback_url || undefined,
        recordingDuration: call.recording?.duration_sec || undefined,
        transcription: call.transcript?.text || undefined,
        transcriptStatus: call.transcript?.status as CallData['transcriptStatus'] || undefined,
        summary: call.transcript?.gemini_summary || undefined,
        answeredBy: call.answered_by || undefined,
    };
}
