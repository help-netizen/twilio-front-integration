export interface Entity {
    entity_type: string;
    text: string;
    start: number;  // ms
    end: number;    // ms
}

export interface GeminiEntity {
    label: string;
    value: string;
    start_ms: number | null;
}

export interface CallData {
    id: string;
    direction: 'incoming' | 'outgoing';
    from: string;
    to: string;
    duration: number | null;
    totalDuration?: number;
    talkTime?: number;
    waitTime?: number;
    status: 'completed' | 'no-answer' | 'busy' | 'failed' | 'ringing' | 'in-progress' | 'voicemail_recording' | 'voicemail_left';
    startTime: Date;
    endTime: Date;
    cost?: number;
    callSid: string;
    queueTime: number;
    parentCall?: string;
    twilioDirection: string;
    audioUrl?: string;
    recordingDuration?: number;
    summary?: string;
    transcription?: string;
    transcriptStatus?: 'processing' | 'completed' | 'failed';
    answeredBy?: string;
}

export const STATUS_CONFIG: Record<string, { label: string; iconColor: string; iconBg: string; badgeBg: string; badgeText: string }> = {
    'completed': { label: 'completed', iconColor: '#16a34a', iconBg: '#dcfce7', badgeBg: '#dcfce7', badgeText: '#15803d' },
    'no-answer': { label: 'missed', iconColor: '#dc2626', iconBg: '#fee2e2', badgeBg: '#fee2e2', badgeText: '#b91c1c' },
    'busy': { label: 'busy', iconColor: '#ea580c', iconBg: '#ffedd5', badgeBg: '#ffedd5', badgeText: '#c2410c' },
    'failed': { label: 'missed', iconColor: '#dc2626', iconBg: '#fee2e2', badgeBg: '#fee2e2', badgeText: '#b91c1c' },
    'ringing': { label: 'ringing', iconColor: '#2563eb', iconBg: '#dbeafe', badgeBg: '#dbeafe', badgeText: '#1d4ed8' },
    'in-progress': { label: 'in progress', iconColor: '#7c3aed', iconBg: '#ede9fe', badgeBg: '#ede9fe', badgeText: '#6d28d9' },
    'voicemail_recording': { label: 'leaving voicemail', iconColor: '#ea580c', iconBg: '#ffedd5', badgeBg: '#ffedd5', badgeText: '#c2410c' },
    'voicemail_left': { label: 'voicemail left', iconColor: '#dc2626', iconBg: '#fee2e2', badgeBg: '#fee2e2', badgeText: '#b91c1c' },
};

export function formatDuration(seconds: number | null): string {
    if (seconds === null || seconds === 0) return 'N/A';
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
}

export function formatAudioTime(seconds: number): string {
    if (!isFinite(seconds) || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatCallTime(date: Date): string {
    return date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

export function getSentimentDisplay(score: number | null) {
    if (score === null) return null;
    if (score <= -0.4) return { emoji: '😡', color: '#dc2626', label: 'Very Negative' };
    if (score <= -0.1) return { emoji: '😟', color: '#f59e0b', label: 'Negative' };
    if (score <= 0.1) return { emoji: '😐', color: '#eab308', label: 'Neutral' };
    if (score <= 0.4) return { emoji: '😊', color: '#22c55e', label: 'Positive' };
    return { emoji: '😄', color: '#3b82f6', label: 'Very Positive' };
}
