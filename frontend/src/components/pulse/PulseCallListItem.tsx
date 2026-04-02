/**
 * PulseCallListItem — call event in the timeline.
 * Flat layout: direction icon + phone + status badge + time.
 * Audio player, summary, transcription expand below.
 */
import { useState } from 'react';
import {
    PhoneIncoming, PhoneOutgoing, ArrowLeftRight,
    Settings2, Clock, DollarSign, Hash, Navigation, Timer,
} from 'lucide-react';
import { formatPhoneDisplay as formatPhoneNumber } from '@/utils/phoneUtils';
import type { CallData } from '../call-list-item';
import { PulseCallAudioPlayer } from './PulseCallAudioPlayer';

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
    completed:           { bg: 'rgba(22,163,74,0.1)',  color: '#16a34a' },
    'no-answer':         { bg: 'rgba(234,179,8,0.1)',  color: '#ca8a04' },
    busy:                { bg: 'rgba(234,88,12,0.1)',  color: '#ea580c' },
    failed:              { bg: 'rgba(220,38,38,0.1)',  color: '#dc2626' },
    canceled:            { bg: 'rgba(107,114,128,0.1)', color: '#6b7280' },
    ringing:             { bg: 'rgba(37,99,235,0.1)',  color: '#2563eb' },
    'in-progress':       { bg: 'rgba(124,58,237,0.1)', color: '#7c3aed' },
    voicemail_recording: { bg: 'rgba(234,88,12,0.1)',  color: '#ea580c' },
    voicemail_left:      { bg: 'rgba(220,38,38,0.1)',  color: '#dc2626' },
};

function getStatusStyle(status: string) {
    return STATUS_COLORS[status] || { bg: 'rgba(107,114,128,0.1)', color: '#6b7280' };
}

const STATUS_LABELS: Record<string, string> = {
    completed: 'Completed', 'no-answer': 'No Answer', busy: 'Busy',
    failed: 'Failed', canceled: 'Canceled', ringing: 'Ringing',
    'in-progress': 'In Progress', voicemail_recording: 'Voicemail',
    voicemail_left: 'Voicemail Left',
};

// ── Formatters ────────────────────────────────────────────────────────────────

const formatDuration = (seconds: number | null | undefined): string => {
    if (!seconds) return 'N/A';
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const formatTime = (date: Date): string =>
    date.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

// ── Component ─────────────────────────────────────────────────────────────────

export function PulseCallListItem({ call }: { call: CallData }) {
    const [showSystemInfo, setShowSystemInfo] = useState(false);
    const status = (call.status || '').toLowerCase();
    const st = getStatusStyle(status);
    const statusLabel = STATUS_LABELS[status] || status;
    const otherPartyNumber = call.direction === 'incoming' ? call.from : call.to;

    const dir = call.direction as string;
    const DirectionIcon = dir === 'incoming'
        ? PhoneIncoming
        : dir === 'internal'
            ? ArrowLeftRight
            : PhoneOutgoing;

    return (
        <div
            className="rounded-xl overflow-hidden transition-colors"
            style={{ border: '1px solid var(--blanc-line)' }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(104,95,80,0.3)')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--blanc-line)')}
        >
            {/* Header row */}
            <div className={`px-4 py-3 ${call.audioUrl ? '' : ''}`}>
                <div className="flex items-center gap-2.5">
                    <DirectionIcon className="size-4 shrink-0" style={{ color: st.color }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--blanc-ink-1)' }}>
                        {formatPhoneNumber(otherPartyNumber)}
                    </span>
                    <span
                        className="px-2 py-0.5 rounded-md text-xs font-semibold shrink-0"
                        style={{ backgroundColor: st.bg, color: st.color }}
                    >
                        {statusLabel}
                    </span>
                    <div className="flex-1" />
                    <span className="text-xs shrink-0" style={{ color: 'var(--blanc-ink-3)' }}>
                        {formatTime(call.startTime)}
                    </span>
                    <button
                        onClick={() => setShowSystemInfo(!showSystemInfo)}
                        className="size-6 flex items-center justify-center rounded-lg transition-colors"
                        style={{ color: 'var(--blanc-ink-3)' }}
                        title="System info"
                    >
                        <Settings2 className={`size-3.5 transition-transform ${showSystemInfo ? 'rotate-90' : ''}`} />
                    </button>
                </div>
            </div>

            {/* Audio Player, Summary, Transcription */}
            <PulseCallAudioPlayer call={call} />

            {/* System Info */}
            {showSystemInfo && (
                <div className="px-4 pb-3 space-y-1.5 text-sm" style={{ background: 'rgba(117,106,89,0.04)' }}>
                    <div className="flex items-center gap-2">
                        <Clock className="size-3.5" style={{ color: 'var(--blanc-ink-3)' }} />
                        <span style={{ color: 'var(--blanc-ink-3)' }}>Duration:</span>
                        <span className="font-mono" style={{ color: 'var(--blanc-ink-1)' }}>{formatDuration(call.totalDuration || call.duration)}</span>
                    </div>
                    {call.talkTime !== undefined && (
                        <div className="flex items-center gap-2">
                            <Timer className="size-3.5" style={{ color: 'var(--blanc-ink-3)' }} />
                            <span style={{ color: 'var(--blanc-ink-3)' }}>Talk:</span>
                            <span className="font-mono" style={{ color: 'var(--blanc-ink-1)' }}>{formatDuration(call.talkTime)}</span>
                        </div>
                    )}
                    {call.waitTime !== undefined && (
                        <div className="flex items-center gap-2">
                            <Clock className="size-3.5" style={{ color: 'var(--blanc-ink-3)' }} />
                            <span style={{ color: 'var(--blanc-ink-3)' }}>Wait:</span>
                            <span className="font-mono" style={{ color: 'var(--blanc-ink-1)' }}>{formatDuration(call.waitTime)}</span>
                        </div>
                    )}
                    {call.cost !== undefined && (
                        <div className="flex items-center gap-2">
                            <DollarSign className="size-3.5" style={{ color: 'var(--blanc-ink-3)' }} />
                            <span style={{ color: 'var(--blanc-ink-3)' }}>Cost:</span>
                            <span className="font-mono" style={{ color: 'var(--blanc-ink-1)' }}>${call.cost.toFixed(4)} USD</span>
                        </div>
                    )}
                    <div className="flex items-center gap-2">
                        <Hash className="size-3.5" style={{ color: 'var(--blanc-ink-3)' }} />
                        <span style={{ color: 'var(--blanc-ink-3)' }}>SID:</span>
                        <code className="text-xs px-1.5 py-0.5 rounded font-mono" style={{ background: 'rgba(117,106,89,0.08)', color: 'var(--blanc-ink-2)' }}>{call.callSid}</code>
                    </div>
                    <div className="flex items-center gap-2">
                        <Navigation className="size-3.5" style={{ color: 'var(--blanc-ink-3)' }} />
                        <span style={{ color: 'var(--blanc-ink-3)' }}>Direction:</span>
                        <span className="font-mono" style={{ color: 'var(--blanc-ink-1)' }}>{call.twilioDirection}</span>
                    </div>
                </div>
            )}
        </div>
    );
}
