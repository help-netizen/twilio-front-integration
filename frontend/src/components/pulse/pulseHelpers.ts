import type { CallData } from '../call-list-item';

const PULSE_STATUS_LABELS: Record<string, string> = {
    completed: 'Completed',
    'no-answer': 'No Answer',
    busy: 'Busy',
    failed: 'Failed',
    canceled: 'Canceled',
    ringing: 'Ringing',
    'in-progress': 'In Progress',
    voicemail_recording: 'Voicemail',
    voicemail_left: 'Voicemail Left',
    blocked: 'Blocked',
};

const MISSED_INBOUND_STATUSES = new Set([
    'no-answer', 'busy', 'failed', 'canceled', 'voicemail_left', 'voicemail_recording',
]);

export function getPulseCallStatusLabel(status: string | null | undefined): string {
    const normalized = (status || '').toLowerCase();
    return PULSE_STATUS_LABELS[normalized] || normalized;
}

export function isMissedInboundStatus(status: string | null | undefined): boolean {
    return MISSED_INBOUND_STATUSES.has((status || '').toLowerCase());
}

export function getPulsePrimaryText({
    isAnonymous,
    company,
    leadName,
    contactName,
    displayName,
    formattedPhone,
}: {
    isAnonymous: boolean;
    company?: string | null;
    leadName?: string | null;
    contactName?: string | null;
    displayName?: string | null;
    formattedPhone: string;
}): string {
    if (isAnonymous) return 'Anonymous';
    return company || leadName || contactName || displayName || formattedPhone;
}

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
        'blocked': 'blocked',
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

// =============================================================================
// Call icon selection — single source of truth for the sidebar
// (PulseContactItem) and the thread-feed tile (PulseCallListItem).
// =============================================================================
export type PulseCallIconKind = 'bot' | 'blocked' | 'incoming' | 'outgoing' | 'internal';

export function isAiAnsweredBy(answeredBy: string | null | undefined): boolean {
    return answeredBy === 'ai';
}

export function getPulseCallIconKind(
    direction: string | null | undefined,
    answeredBy: string | null | undefined,
    status?: string | null,
): PulseCallIconKind {
    if (status?.toLowerCase() === 'blocked') return 'blocked';
    if (isAiAnsweredBy(answeredBy)) return 'bot';
    if (direction === 'internal') return 'internal';
    if (direction === 'incoming' || direction === 'inbound') return 'incoming';
    return 'outgoing';
}
