/**
 * PulseCallListItem — exact match to TIMELINE_TECHNICAL_SPECIFICATION.md
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
    Timer,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPhoneNumber } from '@/utils/formatters';
import type { CallData } from '../call-list-item';

// ── Status Colors (per spec) ─────────────────────────────────────────────────

const getStatusColor = (status: string) => {
    switch (status) {
        case 'completed':
            return 'bg-green-500/10 text-green-700 border-green-200';
        case 'no-answer':
            return 'bg-yellow-500/10 text-yellow-700 border-yellow-200';
        case 'busy':
            return 'bg-orange-500/10 text-orange-700 border-orange-200';
        case 'failed':
            return 'bg-red-500/10 text-red-700 border-red-200';
        case 'ringing':
            return 'bg-blue-500/10 text-blue-700 border-blue-200';
        case 'in-progress':
            return 'bg-purple-500/10 text-purple-700 border-purple-200';
        case 'voicemail_recording':
            return 'bg-orange-500/10 text-orange-700 border-orange-200';
        case 'voicemail_left':
            return 'bg-red-500/10 text-red-700 border-red-200';
        default:
            return 'bg-gray-500/10 text-gray-700 border-gray-200';
    }
};

// ── Formatters ───────────────────────────────────────────────────────────────

const formatDuration = (seconds: number | null | undefined): string => {
    if (!seconds) return 'N/A';
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
};

const formatTime = (date: Date): string => {
    return date.toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
    });
};

const formatAudioTime = (seconds: number): string => {
    if (!isFinite(seconds) || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
};

// ── Component ────────────────────────────────────────────────────────────────

export function PulseCallListItem({ call }: { call: CallData }) {
    const { token } = useAuth();
    const [showSystemInfo, setShowSystemInfo] = useState(false);
    const [activeSection, setActiveSection] = useState<'summary' | 'transcription' | null>(() => {
        // Show summary by default for completed calls with summary
        if (call.status === 'completed' && call.summary) return 'summary';
        return null;
    });

    // Audio player state
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(call.recordingDuration || call.totalDuration || call.duration || 0);
    const audioRef = useRef<HTMLAudioElement>(null);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;
        const updateTime = () => setCurrentTime(audio.currentTime);
        const updateDuration = () => { if (isFinite(audio.duration)) setDuration(audio.duration); };
        const handleEnded = () => setIsPlaying(false);
        audio.addEventListener('timeupdate', updateTime);
        audio.addEventListener('loadedmetadata', updateDuration);
        audio.addEventListener('durationchange', updateDuration);
        audio.addEventListener('ended', handleEnded);
        return () => {
            audio.removeEventListener('timeupdate', updateTime);
            audio.removeEventListener('loadedmetadata', updateDuration);
            audio.removeEventListener('durationchange', updateDuration);
            audio.removeEventListener('ended', handleEnded);
        };
    }, []);

    const handlePlayPause = () => {
        if (!audioRef.current) return;
        if (isPlaying) audioRef.current.pause();
        else audioRef.current.play();
        setIsPlaying(!isPlaying);
    };

    const handleSkip = (seconds: number) => {
        if (!audioRef.current) return;
        audioRef.current.currentTime = Math.max(0, Math.min(audioRef.current.currentTime + seconds, duration));
    };

    const handleSliderChange = (value: number[]) => {
        if (!audioRef.current) return;
        audioRef.current.currentTime = value[0];
        setCurrentTime(value[0]);
    };

    const otherPartyNumber = call.direction === 'incoming' ? call.from : call.to;
    const directionLabel = call.direction === 'incoming' ? 'Incoming Call' : 'Outgoing Call';

    return (
        <Card className="overflow-hidden border border-gray-200 hover:shadow-md transition-shadow">
            {/* ─── Header (p-4 pb-0) ─── */}
            <div className="p-4 pb-0">
                <div className="flex items-center gap-3">
                    {/* Direction Icon with Status Color (w-9 h-9 rounded-full border) */}
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div className={`flex items-center justify-center w-9 h-9 rounded-full border ${getStatusColor(call.status)}`}>
                                    {call.direction === 'incoming' ? (
                                        <PhoneIncoming className="w-4 h-4" />
                                    ) : (
                                        <PhoneOutgoing className="w-4 h-4" />
                                    )}
                                </div>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>{directionLabel} - {call.status.replace('-', ' ').charAt(0).toUpperCase() + call.status.replace('-', ' ').slice(1)}</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>

                    {/* Phone Number */}
                    <p className="text-xs text-gray-600 font-mono">{formatPhoneNumber(otherPartyNumber)}</p>

                    {/* Spacer */}
                    <div className="flex-1" />

                    {/* Date */}
                    <div className="text-xs text-gray-500">
                        {formatTime(call.startTime)}
                    </div>

                    {/* System Info Toggle */}
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setShowSystemInfo(!showSystemInfo)}
                                    className="h-6 w-6 hover:bg-gray-100"
                                >
                                    <Settings2 className={`w-4 h-4 transition-transform ${showSystemInfo ? 'rotate-90' : ''}`} />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>System Information</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                </div>
            </div>

            {/* ─── Audio Player (px-4 pb-4 bg-white) ─── */}
            {call.audioUrl && (
                <div className="px-4 pb-4 bg-white">
                    <audio
                        ref={audioRef}
                        src={token ? `${call.audioUrl}?token=${encodeURIComponent(token)}` : call.audioUrl}
                        preload="metadata"
                    />

                    <div className="space-y-3">
                        {/* Action buttons and Controls in one row */}
                        <div className="flex items-center gap-3">
                            {/* Summary and Transcription tabs on the left */}
                            <div className="flex items-center gap-3 shrink-0">
                                {call.summary && (
                                    <button
                                        onClick={() => setActiveSection(activeSection === 'summary' ? null : 'summary')}
                                        className={`text-xs transition-colors ${activeSection === 'summary'
                                                ? 'text-gray-700 border-b-2 border-gray-700'
                                                : 'text-gray-500 border-b border-dashed border-gray-400 hover:text-gray-700 hover:border-gray-600'
                                            }`}
                                    >
                                        Summary
                                    </button>
                                )}

                                {call.transcription && (
                                    <button
                                        onClick={() => setActiveSection(activeSection === 'transcription' ? null : 'transcription')}
                                        className={`text-xs transition-colors ${activeSection === 'transcription'
                                                ? 'text-gray-700 border-b-2 border-gray-700'
                                                : 'text-gray-500 border-b border-dashed border-gray-400 hover:text-gray-700 hover:border-gray-600'
                                            }`}
                                    >
                                        {call.transcriptStatus === 'processing' ? 'Transcribing...' : 'Transcript'}
                                    </button>
                                )}
                            </div>

                            {/* Audio Controls */}
                            <div className="flex items-center gap-1 shrink-0">
                                <button
                                    onClick={() => handleSkip(-10)}
                                    title="Rewind 10 seconds"
                                    className="h-7 w-7 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors relative"
                                >
                                    <RotateCcw className="w-3.5 h-3.5" />
                                    <span className="absolute text-[9px] font-semibold">10</span>
                                </button>

                                <button
                                    onClick={handlePlayPause}
                                    className="h-7 w-7 flex items-center justify-center text-gray-500 hover:text-gray-700 transition-colors"
                                >
                                    {isPlaying ? (
                                        <Pause className="w-3.5 h-3.5" />
                                    ) : (
                                        <Play className="w-3.5 h-3.5" />
                                    )}
                                </button>

                                <button
                                    onClick={() => handleSkip(10)}
                                    title="Forward 10 seconds"
                                    className="h-7 w-7 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors relative"
                                >
                                    <RotateCw className="w-3.5 h-3.5" />
                                    <span className="absolute text-[9px] font-semibold">10</span>
                                </button>
                            </div>

                            {/* Time Display */}
                            <div className="flex items-center">
                                <span className="text-xs text-gray-500 font-mono">
                                    {formatAudioTime(currentTime)} / {formatAudioTime(duration)}
                                </span>
                            </div>
                        </div>

                        {/* Slider */}
                        <Slider
                            value={[currentTime]}
                            max={duration || 100}
                            step={1}
                            onValueChange={handleSliderChange}
                            className="w-full"
                        />

                        {/* Summary - Show only when active */}
                        {activeSection === 'summary' && call.summary && (
                            <div className="pt-2">
                                <p className="text-sm text-gray-700 leading-relaxed">
                                    {call.summary}
                                </p>
                            </div>
                        )}

                        {/* Transcription - Show only when active */}
                        {activeSection === 'transcription' && call.transcription && (
                            <div className="pt-2">
                                <ScrollArea className="h-48 bg-gray-50 p-3 rounded-md">
                                    <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                                        {call.transcription}
                                    </p>
                                </ScrollArea>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ─── No Audio: Summary and Transcription separately ─── */}
            {!call.audioUrl && (
                <>
                    {call.summary && (
                        <div className="px-4 pb-4 border-t">
                            <h4 className="font-medium text-sm mt-3 mb-2">Summary</h4>
                            <p className="text-sm leading-relaxed bg-muted/50 p-3 rounded-md">
                                {call.summary}
                            </p>
                        </div>
                    )}
                    {call.transcription && (
                        <div className="px-4 pb-4 border-t">
                            <h4 className="font-medium text-sm mt-3 mb-2">Transcription</h4>
                            <ScrollArea className="h-48 bg-gray-50 p-3 rounded-md">
                                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                                    {call.transcription}
                                </p>
                            </ScrollArea>
                        </div>
                    )}
                </>
            )}

            {/* ─── System Information (bg-gray-50, p-4 pt-0, space-y-2) ─── */}
            {showSystemInfo && (
                <div className="p-4 pt-0 space-y-2 text-sm bg-gray-50">
                    <div className="flex items-center gap-2">
                        <Clock className="w-4 h-4 text-gray-400" />
                        <span className="text-gray-600">Duration:</span>
                        <span className="font-mono text-gray-900">
                            {formatDuration(call.totalDuration || call.duration)}
                        </span>
                    </div>

                    {call.talkTime !== undefined && (
                        <div className="flex items-center gap-2">
                            <Timer className="w-4 h-4 text-gray-400" />
                            <span className="text-gray-600">Talk:</span>
                            <span className="font-mono text-gray-900">
                                {formatDuration(call.talkTime)}
                            </span>
                        </div>
                    )}

                    {call.waitTime !== undefined && (
                        <div className="flex items-center gap-2">
                            <Clock className="w-4 h-4 text-gray-400" />
                            <span className="text-gray-600">Wait:</span>
                            <span className="font-mono text-gray-900">
                                {formatDuration(call.waitTime)}
                            </span>
                        </div>
                    )}

                    {call.cost !== undefined && (
                        <div className="flex items-center gap-2">
                            <DollarSign className="w-4 h-4 text-gray-400" />
                            <span className="text-gray-600">Cost:</span>
                            <span className="font-mono text-gray-900">
                                ${call.cost.toFixed(4)} USD
                            </span>
                        </div>
                    )}

                    <div className="flex items-center gap-2">
                        <Hash className="w-4 h-4 text-gray-400" />
                        <span className="text-gray-600">Call SID:</span>
                        <code className="text-xs bg-gray-200 px-2 py-1 rounded font-mono text-gray-800">
                            {call.callSid}
                        </code>
                    </div>

                    <div className="flex items-center gap-2">
                        <Clock className="w-4 h-4 text-gray-400" />
                        <span className="text-gray-600">Queue Time:</span>
                        <span className="font-mono text-gray-900">{call.queueTime}s</span>
                    </div>

                    <div className="flex items-center gap-2">
                        <Navigation className="w-4 h-4 text-gray-400" />
                        <span className="text-gray-600">Twilio Direction:</span>
                        <span className="font-mono text-gray-900">{call.twilioDirection}</span>
                    </div>
                </div>
            )}
        </Card>
    );
}
