/**
 * PulseCallListItem — compact call event row in the timeline.
 * Icon-forward design: direction icon circle + phone + status + duration + time.
 * Expandable audio player and system details below.
 */
import { useState } from 'react';
import {
    PhoneIncoming, PhoneOutgoing, ArrowLeftRight,
    Clock, DollarSign, Hash, Navigation, Timer, ChevronDown,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPhoneDisplay as formatPhoneNumber } from '@/utils/phoneUtils';
import type { CallData } from '../call-list-item';
import { PulseCallAudioPlayer } from './PulseCallAudioPlayer';

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { bg: string; color: string; label: string }> = {
    completed:            { bg: 'rgba(27,139,99,0.10)',  color: '#1b8b63', label: 'Completed' },
    'no-answer':          { bg: 'rgba(212,77,60,0.10)',  color: '#d44d3c', label: 'No Answer' },
    busy:                 { bg: 'rgba(178,106,29,0.12)', color: '#b26a1d', label: 'Busy' },
    failed:               { bg: 'rgba(212,77,60,0.10)',  color: '#d44d3c', label: 'Failed' },
    canceled:             { bg: 'rgba(117,106,89,0.10)', color: '#7d8796', label: 'Canceled' },
    ringing:              { bg: 'rgba(47,99,216,0.10)',  color: '#2f63d8', label: 'Ringing' },
    'in-progress':        { bg: 'rgba(124,53,160,0.10)', color: '#7c35a0', label: 'In Progress' },
    voicemail_recording:  { bg: 'rgba(178,106,29,0.12)', color: '#b26a1d', label: 'Voicemail' },
    voicemail_left:       { bg: 'rgba(212,77,60,0.10)',  color: '#d44d3c', label: 'Voicemail Left' },
};

function getStatusConfig(status: string) {
    return STATUS_CONFIG[status] || { bg: 'rgba(117,106,89,0.08)', color: '#7d8796', label: status };
}

// ── Formatters ────────────────────────────────────────────────────────────────

const formatDuration = (seconds: number | null | undefined): string => {
    if (!seconds) return '';
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const formatTime = (date: Date): string =>
    date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

// ── Component ─────────────────────────────────────────────────────────────────

export function PulseCallListItem({ call }: { call: CallData }) {
    const [showSystemInfo, setShowSystemInfo] = useState(false);
    const status = (call.status || '').toLowerCase();
    const cfg = getStatusConfig(status);
    const otherPartyNumber = call.direction === 'incoming' ? call.from : call.to;
    const duration = formatDuration(call.totalDuration || call.duration);

    const dir = call.direction as string;
    const DirectionIcon = dir === 'incoming'
        ? PhoneIncoming
        : dir === 'internal'
            ? ArrowLeftRight
            : PhoneOutgoing;

    const directionLabel = dir === 'incoming' ? 'Inbound' : dir === 'internal' ? 'Internal' : 'Outbound';

    return (
        <div className="group/call">
            {/* Compact event row */}
            <div className="flex items-center gap-2.5 px-1 py-1.5 rounded-xl hover:bg-muted/40 transition-colors">
                {/* Direction icon */}
                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <div
                                className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                                style={{ background: cfg.bg }}
                            >
                                <DirectionIcon className="w-4 h-4" style={{ color: cfg.color }} />
                            </div>
                        </TooltipTrigger>
                        <TooltipContent>
                            <p>{directionLabel} — {cfg.label}</p>
                        </TooltipContent>
                    </Tooltip>
                </TooltipProvider>

                {/* Phone */}
                <span className="text-sm font-medium font-mono flex-1 truncate" style={{ color: 'var(--blanc-ink-1)' }}>
                    {formatPhoneNumber(otherPartyNumber)}
                </span>

                {/* Status pill */}
                <span
                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md shrink-0"
                    style={{ background: cfg.bg, color: cfg.color }}
                >
                    {cfg.label}
                </span>

                {/* Duration */}
                {duration && (
                    <span className="text-xs shrink-0" style={{ color: 'var(--blanc-ink-3)' }}>
                        {duration}
                    </span>
                )}

                {/* Time */}
                <span className="text-xs shrink-0" style={{ color: 'var(--blanc-ink-3)' }}>
                    {formatTime(call.startTime)}
                </span>

                {/* Expand toggle */}
                <button
                    onClick={() => setShowSystemInfo(!showSystemInfo)}
                    className="p-1 rounded-lg transition-colors hover:bg-muted/60 shrink-0 opacity-0 group-hover/call:opacity-100"
                    style={{ color: 'var(--blanc-ink-3)' }}
                    title="Call details"
                >
                    <ChevronDown
                        className="w-3.5 h-3.5 transition-transform"
                        style={{ transform: showSystemInfo ? 'rotate(180deg)' : 'none' }}
                    />
                </button>
            </div>

            {/* Audio player — indented, in its own card */}
            {call.audioUrl && (
                <div
                    className="ml-10 mt-1.5 rounded-xl overflow-hidden"
                    style={{ border: '1px solid var(--blanc-line)', background: 'var(--blanc-surface-strong)' }}
                >
                    <PulseCallAudioPlayer call={call} />
                </div>
            )}

            {/* System details — expandable */}
            {showSystemInfo && (
                <div
                    className="ml-10 mt-1.5 px-3 py-2.5 space-y-1.5 text-xs rounded-xl"
                    style={{ background: 'var(--blanc-surface-muted)', border: '1px solid var(--blanc-line)' }}
                >
                    <div className="flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                        <span style={{ color: 'var(--blanc-ink-3)' }}>Duration</span>
                        <span className="font-mono ml-auto" style={{ color: 'var(--blanc-ink-1)' }}>
                            {formatDuration(call.totalDuration || call.duration) || 'N/A'}
                        </span>
                    </div>
                    {call.talkTime !== undefined && (
                        <div className="flex items-center gap-2">
                            <Timer className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                            <span style={{ color: 'var(--blanc-ink-3)' }}>Talk</span>
                            <span className="font-mono ml-auto" style={{ color: 'var(--blanc-ink-1)' }}>{formatDuration(call.talkTime)}</span>
                        </div>
                    )}
                    {call.waitTime !== undefined && (
                        <div className="flex items-center gap-2">
                            <Clock className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                            <span style={{ color: 'var(--blanc-ink-3)' }}>Wait</span>
                            <span className="font-mono ml-auto" style={{ color: 'var(--blanc-ink-1)' }}>{formatDuration(call.waitTime)}</span>
                        </div>
                    )}
                    {call.cost !== undefined && (
                        <div className="flex items-center gap-2">
                            <DollarSign className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                            <span style={{ color: 'var(--blanc-ink-3)' }}>Cost</span>
                            <span className="font-mono ml-auto" style={{ color: 'var(--blanc-ink-1)' }}>${call.cost.toFixed(4)}</span>
                        </div>
                    )}
                    <div className="flex items-center gap-2">
                        <Hash className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                        <span style={{ color: 'var(--blanc-ink-3)' }}>SID</span>
                        <code
                            className="font-mono text-[10px] ml-auto px-1.5 py-0.5 rounded-md truncate max-w-[160px]"
                            style={{ background: 'rgba(118,106,89,0.1)', color: 'var(--blanc-ink-2)' }}
                        >
                            {call.callSid}
                        </code>
                    </div>
                    <div className="flex items-center gap-2">
                        <Navigation className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                        <span style={{ color: 'var(--blanc-ink-3)' }}>Direction</span>
                        <span className="font-mono ml-auto" style={{ color: 'var(--blanc-ink-1)' }}>{call.twilioDirection}</span>
                    </div>
                </div>
            )}
        </div>
    );
}
