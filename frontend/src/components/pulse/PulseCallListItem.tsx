/**
 * PulseCallListItem — exact match to TIMELINE_TECHNICAL_SPECIFICATION.md
 */

import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { authedFetch } from '@/services/apiClient';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPhoneNumber } from '@/utils/formatters';
import type { CallData, Entity } from '../call-list-item';

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
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [transcriptionText, setTranscriptionText] = useState<string | null>(null);
    const [transcribeError, setTranscribeError] = useState<string | null>(null);
    const [entities, setEntities] = useState<Entity[]>([]);
    const [activeEntityIdx, setActiveEntityIdx] = useState<number | null>(null);

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


    const otherPartyNumber = call.direction === 'incoming' ? call.from : call.to;
    const directionLabel = call.direction === 'incoming' ? 'Incoming Call' : 'Outgoing Call';

    return (
        <Card className="overflow-hidden border border-gray-200 hover:shadow-md transition-shadow">
            {/* ─── Header ─── */}
            <div className={`p-4 ${call.audioUrl ? 'pb-0' : ''}`}>
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

            {/* ─── Content wrapper (bg-gray-50/50) ─── */}
            <div className="bg-gray-50/50">
                {/* Audio Player (px-4 pb-4 bg-white) */}
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
                                    <button
                                        onClick={() => setActiveSection(activeSection === 'summary' ? null : 'summary')}
                                        className={`text-xs transition-colors ${activeSection === 'summary'
                                            ? 'text-gray-700 border-b-2 border-gray-700'
                                            : 'text-gray-500 border-b border-dashed border-gray-400 hover:text-gray-700 hover:border-gray-600'
                                            }`}
                                    >
                                        Summary
                                    </button>

                                    <button
                                        onClick={() => setActiveSection(activeSection === 'transcription' ? null : 'transcription')}
                                        className={`text-xs transition-colors ${activeSection === 'transcription'
                                            ? 'text-gray-700 border-b-2 border-gray-700'
                                            : 'text-gray-500 border-b border-dashed border-gray-400 hover:text-gray-700 hover:border-gray-600'
                                            }`}
                                    >
                                        Transcription
                                    </button>
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

                            {/* Summary - Show only when active */}
                            {activeSection === 'summary' && (
                                <div className="pt-2 space-y-3">
                                    {call.summary ? (
                                        <p className="text-sm text-gray-700 leading-relaxed">
                                            {call.summary}
                                        </p>
                                    ) : (
                                        <p className="text-sm text-gray-400 italic">No summary available</p>
                                    )}

                                    {/* Detected Entities */}
                                    <div className="flex items-center justify-between mb-1">
                                        <h4 className="text-xs font-semibold text-gray-800 uppercase tracking-wide">Detected Entities</h4>
                                        {entities.length > 0 && (
                                            <span className="text-[10px] text-gray-400">{entities.length} found</span>
                                        )}
                                    </div>
                                    <ScrollArea className="h-48 bg-gray-50 p-3 rounded-md">
                                        {entities.length > 0 ? (
                                            <div className="space-y-1">
                                                {entities.map((entity, idx) => {
                                                    const startSec = entity.start / 1000;
                                                    const endSec = entity.end / 1000;
                                                    const isActive = activeEntityIdx === idx;
                                                    const isInRange = currentTime >= startSec && currentTime <= endSec;
                                                    return (
                                                        <button
                                                            key={`${entity.entity_type}-${entity.start}-${idx}`}
                                                            onClick={() => {
                                                                if (audioRef.current && entity.start != null) {
                                                                    audioRef.current.currentTime = startSec;
                                                                    setCurrentTime(startSec);
                                                                    setActiveEntityIdx(idx);
                                                                    if (!isPlaying) {
                                                                        audioRef.current.play();
                                                                        setIsPlaying(true);
                                                                    }
                                                                }
                                                            }}
                                                            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs transition-colors cursor-pointer ${(isActive || isInRange)
                                                                ? 'bg-blue-50 ring-1 ring-blue-200'
                                                                : 'hover:bg-gray-100'
                                                                }`}
                                                            aria-label={`${entity.entity_type.replace(/_/g, ' ')}: ${entity.text}, at ${formatAudioTime(startSec)}`}
                                                        >
                                                            <span className="shrink-0 px-1.5 py-0.5 rounded bg-gray-200 text-[10px] font-medium text-gray-600 uppercase">
                                                                {entity.entity_type.replace(/_/g, ' ')}
                                                            </span>
                                                            <span className="flex-1 truncate font-medium text-gray-800">{entity.text}</span>
                                                            {entity.start != null && (
                                                                <span className="shrink-0 text-[10px] text-gray-400 font-mono">
                                                                    {formatAudioTime(startSec)}
                                                                </span>
                                                            )}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        ) : transcriptionText || call.transcription ? (
                                            <p className="text-xs text-gray-400 italic">No entities detected for this call.</p>
                                        ) : (
                                            <p className="text-xs text-gray-400 italic">Entities will appear after transcription is complete.</p>
                                        )}
                                    </ScrollArea>
                                </div>
                            )}

                            {/* Transcription - Show only when active */}
                            {activeSection === 'transcription' && (
                                <div className="pt-2">
                                    <ScrollArea className="h-48 bg-gray-50 p-3 rounded-md">
                                        {(transcriptionText || call.transcription) ? (
                                            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                                                {transcriptionText || call.transcription}
                                            </p>
                                        ) : isTranscribing ? (
                                            <div className="flex items-center gap-2">
                                                <div className="w-4 h-4 border-2 border-gray-600 border-t-transparent rounded-full animate-spin" />
                                                <p className="text-sm text-gray-400 animate-pulse">Generating transcription...</p>
                                            </div>
                                        ) : (
                                            <div>
                                                <p className="text-sm text-gray-400 italic">No transcription available</p>
                                                {transcribeError && (
                                                    <p className="text-sm text-red-500 mt-1">{transcribeError}</p>
                                                )}
                                                {call.callSid && (
                                                    <button
                                                        onClick={async () => {
                                                            setIsTranscribing(true);
                                                            setTranscribeError(null);
                                                            try {
                                                                const res = await authedFetch(`/api/calls/${call.callSid}/transcribe`, { method: 'POST' });
                                                                const data = await res.json();
                                                                if (!res.ok) throw new Error(data.error || 'Failed');
                                                                setTranscriptionText(data.transcript);
                                                                if (data.entities) setEntities(data.entities);
                                                            } catch (err: any) {
                                                                setTranscribeError(err.message);
                                                            } finally {
                                                                setIsTranscribing(false);
                                                            }
                                                        }}
                                                        className="mt-2 text-xs px-3 py-1.5 bg-gray-800 text-white rounded-md hover:bg-gray-700 transition-colors cursor-pointer"
                                                    >
                                                        Generate
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </ScrollArea>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

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
