/**
 * PulseCallListItem — call card for the Pulse timeline.
 * Design follows TIMELINE_DOCUMENTATION.md spec:
 *  - Header: left(icon + phone + timestamp) ❘ right(Badge + duration badge)
 *  - Audio player in bg-gray-50 pill
 *  - Call Summary always visible (bg-blue-50)
 *  - Transcription: Collapsible with blue trigger
 *  - System Info: Collapsible, grid 2-col
 */

import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import {
    PhoneIncoming,
    PhoneOutgoing,
    Play,
    Pause,
    RotateCcw,
    RotateCw,
    Settings2,
    Clock,
    DollarSign,
    Hash,
    Navigation,
    ChevronDown,
    MessageSquare,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { formatPhoneNumber } from '@/utils/formatters';
import type { CallData } from '../call-list-item';

// ── Status badge config ──────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, { text: string; className: string }> = {
    'completed': { text: 'Completed', className: 'bg-green-100 text-green-800 hover:bg-green-100' },
    'no-answer': { text: 'No Answer', className: 'bg-yellow-100 text-yellow-800 hover:bg-yellow-100' },
    'busy': { text: 'Busy', className: 'bg-orange-100 text-orange-800 hover:bg-orange-100' },
    'failed': { text: 'Failed', className: 'bg-red-100 text-red-800 hover:bg-red-100' },
    'ringing': { text: 'Ringing', className: 'bg-blue-100 text-blue-800 hover:bg-blue-100' },
    'in-progress': { text: 'In Progress', className: 'bg-purple-100 text-purple-800 hover:bg-purple-100' },
    'voicemail_recording': { text: 'Leaving Voicemail', className: 'bg-orange-100 text-orange-800 hover:bg-orange-100' },
    'voicemail_left': { text: 'Voicemail Left', className: 'bg-red-100 text-red-800 hover:bg-red-100' },
};

// ── Formatters ───────────────────────────────────────────────────────────────

function fmtDuration(sec: number | null | undefined): string {
    if (!sec) return '';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtAudioTime(sec: number): string {
    if (!isFinite(sec) || isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtTimestamp(date: Date): string {
    return date.toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
    });
}

// ── Component ────────────────────────────────────────────────────────────────

export function PulseCallListItem({ call }: { call: CallData }) {
    const { token } = useAuth();
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(call.recordingDuration || call.totalDuration || call.duration || 0);
    const [transcriptionOpen, setTranscriptionOpen] = useState(false);
    const [systemInfoOpen, setSystemInfoOpen] = useState(false);
    const audioRef = useRef<HTMLAudioElement>(null);

    // Audio events
    useEffect(() => {
        const a = audioRef.current;
        if (!a) return;
        const onTime = () => setCurrentTime(a.currentTime);
        const onDur = () => { if (isFinite(a.duration)) setDuration(a.duration); };
        const onEnd = () => setIsPlaying(false);
        a.addEventListener('timeupdate', onTime);
        a.addEventListener('loadedmetadata', onDur);
        a.addEventListener('durationchange', onDur);
        a.addEventListener('ended', onEnd);
        return () => {
            a.removeEventListener('timeupdate', onTime);
            a.removeEventListener('loadedmetadata', onDur);
            a.removeEventListener('durationchange', onDur);
            a.removeEventListener('ended', onEnd);
        };
    }, []);

    const togglePlay = () => {
        if (!audioRef.current) return;
        isPlaying ? audioRef.current.pause() : audioRef.current.play();
        setIsPlaying(!isPlaying);
    };
    const skip = (s: number) => {
        if (!audioRef.current) return;
        audioRef.current.currentTime = Math.max(0, Math.min(audioRef.current.currentTime + s, duration));
    };
    const seek = (v: number[]) => {
        if (!audioRef.current) return;
        audioRef.current.currentTime = v[0];
        setCurrentTime(v[0]);
    };

    const otherNumber = call.direction === 'incoming' ? call.from : call.to;
    const badge = STATUS_BADGE[call.status] || STATUS_BADGE['completed'];
    const durationSec = call.totalDuration || call.duration;

    return (
        <Card className="bg-white border border-gray-200 shadow-sm overflow-hidden">
            <div className="p-4 space-y-3">
                {/* ─── Header ─── */}
                <div className="flex items-center justify-between">
                    {/* Left: icon + phone + timestamp */}
                    <div className="flex items-center gap-2">
                        {call.direction === 'incoming'
                            ? <PhoneIncoming className="w-5 h-5 text-green-600 shrink-0" />
                            : <PhoneOutgoing className="w-5 h-5 text-blue-600 shrink-0" />}
                        <span className="text-sm font-medium text-gray-900">
                            {formatPhoneNumber(otherNumber)}
                        </span>
                        <span className="text-xs text-gray-500">
                            {fmtTimestamp(call.startTime)}
                        </span>
                    </div>

                    {/* Right: status badge + duration badge */}
                    <div className="flex items-center gap-2 shrink-0">
                        <Badge variant="secondary" className={badge.className}>
                            {badge.text}
                        </Badge>
                        {durationSec ? (
                            <span className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-700">
                                {fmtDuration(durationSec)}
                            </span>
                        ) : null}
                    </div>
                </div>

                {/* ─── Audio Player ─── */}
                {call.audioUrl && (
                    <div className="bg-gray-50 rounded-lg p-3">
                        <audio
                            ref={audioRef}
                            src={token ? `${call.audioUrl}?token=${encodeURIComponent(token)}` : call.audioUrl}
                            preload="metadata"
                        />

                        <div className="flex items-center gap-3">
                            {/* Play / Pause */}
                            <Button variant="ghost" size="icon" className="size-8" onClick={togglePlay}>
                                {isPlaying
                                    ? <Pause className="w-5 h-5" />
                                    : <Play className="w-5 h-5" />}
                            </Button>

                            {/* Rewind */}
                            <Button variant="ghost" size="icon" className="size-8 relative hover:bg-gray-200" onClick={() => skip(-10)}>
                                <RotateCcw className="w-4 h-4" />
                                <span className="absolute text-[7px] font-bold leading-none">10</span>
                            </Button>

                            {/* Forward */}
                            <Button variant="ghost" size="icon" className="size-8 relative hover:bg-gray-200" onClick={() => skip(10)}>
                                <RotateCw className="w-4 h-4" />
                                <span className="absolute text-[7px] font-bold leading-none">10</span>
                            </Button>

                            {/* Progress bar */}
                            <Slider
                                value={[currentTime]}
                                max={duration || 100}
                                step={1}
                                onValueChange={seek}
                                className="flex-1"
                            />

                            {/* Time */}
                            <span className="text-xs text-gray-600 font-mono shrink-0">
                                {fmtAudioTime(currentTime)} / {fmtAudioTime(duration)}
                            </span>
                        </div>
                    </div>
                )}

                {/* ─── Call Summary (always visible when exists) ─── */}
                {call.summary && (
                    <div className="p-3 bg-blue-50 rounded-lg">
                        <div className="flex items-center gap-1.5 mb-1.5">
                            <MessageSquare className="w-4 h-4 text-gray-700" />
                            <span className="text-sm font-semibold text-gray-900">Call Summary</span>
                        </div>
                        <p className="text-sm text-gray-700 leading-relaxed">{call.summary}</p>
                    </div>
                )}

                {/* ─── Transcription (Collapsible) ─── */}
                {call.transcription && (
                    <div>
                        <button
                            onClick={() => setTranscriptionOpen(!transcriptionOpen)}
                            className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 transition-colors"
                        >
                            <ChevronDown className={cn(
                                'w-4 h-4 transition-transform',
                                transcriptionOpen && 'rotate-180',
                            )} />
                            View Transcription
                        </button>

                        {transcriptionOpen && (
                            <ScrollArea className="mt-2 h-[200px] p-3 bg-gray-50 rounded-lg">
                                <p className="text-sm text-gray-700 whitespace-pre-line leading-relaxed">
                                    {call.transcription}
                                </p>
                            </ScrollArea>
                        )}
                    </div>
                )}

                {call.transcriptStatus === 'processing' && (
                    <p className="text-sm text-gray-500 italic animate-pulse">Transcribing audio…</p>
                )}

                {/* ─── System Information (Collapsible) ─── */}
                <div>
                    <button
                        onClick={() => setSystemInfoOpen(!systemInfoOpen)}
                        className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 transition-colors"
                    >
                        <Settings2 className={cn(
                            'w-4 h-4 transition-transform',
                            systemInfoOpen && 'rotate-90',
                        )} />
                        System Information
                    </button>

                    {systemInfoOpen && (
                        <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                            {call.cost !== undefined && (
                                <div className="flex items-center gap-1.5">
                                    <DollarSign className="w-4 h-4 text-gray-400" />
                                    <span className="text-gray-500">Cost:</span>
                                    <span className="font-mono">${call.cost.toFixed(3)}</span>
                                </div>
                            )}
                            <div className="flex items-center gap-1.5">
                                <Hash className="w-4 h-4 text-gray-400" />
                                <span className="text-gray-500">Call SID:</span>
                                <span className="font-mono text-xs truncate max-w-[140px]">{call.callSid}</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                                <Clock className="w-4 h-4 text-gray-400" />
                                <span className="text-gray-500">Queue:</span>
                                <span className="font-mono">{call.queueTime}s</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                                <Navigation className="w-4 h-4 text-gray-400" />
                                <span className="text-gray-500">Direction:</span>
                                <span className="font-mono capitalize">{call.twilioDirection}</span>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </Card>
    );
}
