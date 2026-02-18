/**
 * PulseCallListItem — exact match to TIMELINE_TECHNICAL_SPECIFICATION.md
 */

import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { authedFetch } from '@/services/apiClient';
import { useLiveTranscript } from '@/hooks/useLiveTranscript';
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
import type { CallData, Entity, GeminiEntity } from '../call-list-item';

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

    const [sentimentScore, setSentimentScore] = useState<number | null>(null);

    // Live streaming transcription
    const liveLines = useLiveTranscript(call.callSid || '');
    const isLiveStreaming = liveLines.length > 0 && !call.audioUrl; // live if lines exist and call still active (no recording yet)

    // Auto-open transcription tab when live streaming starts
    useEffect(() => {
        if (liveLines.length > 0 && activeSection !== 'transcription') {
            setActiveSection('transcription');
        }
    }, [liveLines.length > 0]); // only trigger on first line arrival

    // Gemini summary + structured entities
    const [geminiSummary, setGeminiSummary] = useState<string | null>(null);
    const [geminiEntities, setGeminiEntities] = useState<GeminiEntity[]>([]);
    const [geminiStatus, setGeminiStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [activeGeminiIdx, setActiveGeminiIdx] = useState<number | null>(null);
    const geminiLoadedRef = useRef(false);

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

    // Eagerly load transcript data (sentiment, entities) on mount
    const mediaLoadedRef = useRef(false);
    useEffect(() => {
        if (mediaLoadedRef.current || !call.callSid || !call.audioUrl) return;
        mediaLoadedRef.current = true;
        (async () => {
            try {
                const res = await authedFetch(`/api/calls/${call.callSid}/media`);
                if (!res.ok) return;
                const data = await res.json();
                const t = data.transcript;
                if (t) {
                    if (!transcriptionText && t.text) setTranscriptionText(t.text);
                    if (entities.length === 0 && t.entities?.length) setEntities(t.entities);
                    if (sentimentScore === null && t.sentimentScore != null) setSentimentScore(t.sentimentScore);
                }
            } catch { /* ignore */ }
        })();
    }, [call.callSid]);

    // Load Gemini summary/entities from /media when Summary tab opens
    useEffect(() => {
        if (activeSection !== 'summary' || geminiLoadedRef.current || !call.callSid) return;
        geminiLoadedRef.current = true;
        setGeminiStatus('loading');
        (async () => {
            try {
                const res = await authedFetch(`/api/calls/${call.callSid}/media`);
                if (!res.ok) throw new Error('Failed to load media');
                const data = await res.json();
                const t = data.transcript;
                if (t) {
                    if (!transcriptionText && t.text) setTranscriptionText(t.text);
                    if (entities.length === 0 && t.entities?.length) setEntities(t.entities);
                    if (sentimentScore === null && t.sentimentScore != null) setSentimentScore(t.sentimentScore);
                    if (t.gemini_summary) {
                        setGeminiSummary(t.gemini_summary);
                        setGeminiEntities(t.gemini_entities || []);
                        setGeminiStatus('ready');
                    } else {
                        setGeminiStatus('idle');
                    }
                } else {
                    setGeminiStatus('idle');
                }
            } catch {
                setGeminiStatus('error');
            }
        })();
    }, [activeSection, call.callSid]);

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

    // Map sentiment score (-1…+1) to 5-level emoji + color
    const getSentimentDisplay = (score: number | null) => {
        if (score === null) return null;
        if (score <= -0.4) return { emoji: '😡', color: '#dc2626', label: 'Very Negative' };
        if (score <= -0.1) return { emoji: '😟', color: '#f59e0b', label: 'Negative' };
        if (score <= 0.1) return { emoji: '😐', color: '#eab308', label: 'Neutral' };
        if (score <= 0.4) return { emoji: '😊', color: '#22c55e', label: 'Positive' };
        return { emoji: '😄', color: '#3b82f6', label: 'Very Positive' };
    };

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
                                    {/* Sentiment emoji */}
                                    {(() => {
                                        const sd = getSentimentDisplay(sentimentScore);
                                        if (!sd) return null;
                                        return (
                                            <span
                                                title={`${sd.label} (${sentimentScore})`}
                                                className="text-base leading-none cursor-default"
                                                style={{ filter: `drop-shadow(0 0 2px ${sd.color})` }}
                                            >{sd.emoji}</span>
                                        );
                                    })()}
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
                                        {isLiveStreaming && (
                                            <span className="ml-1 inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                                        )}
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
                                    {/* ── Call Summary (Gemini) ── */}
                                    <div>
                                        <h4 className="text-xs font-semibold text-gray-800 uppercase tracking-wide mb-1">Call Summary</h4>
                                        {geminiStatus === 'loading' ? (
                                            <div className="flex items-center gap-2 bg-gray-50 p-3 rounded-md">
                                                <div className="w-3 h-3 border-2 border-gray-600 border-t-transparent rounded-full animate-spin" />
                                                <span className="text-sm text-gray-400 animate-pulse">Generating summary…</span>
                                            </div>
                                        ) : geminiStatus === 'error' ? (
                                            <p className="text-sm text-red-500 italic bg-red-50 p-3 rounded-md">Summary unavailable</p>
                                        ) : geminiSummary ? (
                                            <p className="text-sm text-gray-700 leading-relaxed bg-gray-50 p-3 rounded-md">{geminiSummary}</p>
                                        ) : call.summary ? (
                                            <p className="text-sm text-gray-700 leading-relaxed">{call.summary}</p>
                                        ) : isTranscribing ? (
                                            <p className="text-sm text-gray-400 italic bg-gray-50 p-3 rounded-md">Not ready (waiting for transcript)</p>
                                        ) : (
                                            <p className="text-sm text-gray-400 italic">No summary available</p>
                                        )}
                                    </div>

                                    {/* ── Key Entities (Gemini structured) ── */}
                                    <div>
                                        <div className="flex items-center justify-between mb-1">
                                            <h4 className="text-xs font-semibold text-gray-800 uppercase tracking-wide">Key Entities</h4>
                                            {geminiEntities.length > 0 && (
                                                <span className="text-[10px] text-gray-400">{geminiEntities.length} found</span>
                                            )}
                                        </div>
                                        {geminiStatus === 'loading' ? (
                                            <div className="flex items-center gap-2 bg-gray-50 p-3 rounded-md">
                                                <div className="w-3 h-3 border-2 border-gray-600 border-t-transparent rounded-full animate-spin" />
                                                <span className="text-sm text-gray-400 animate-pulse">Extracting entities…</span>
                                            </div>
                                        ) : geminiStatus === 'error' ? (
                                            <p className="text-sm text-red-500 italic bg-red-50 p-3 rounded-md">Entities unavailable</p>
                                        ) : geminiEntities.length > 0 ? (
                                            <div className="bg-gray-50 p-3 rounded-md space-y-1">
                                                {geminiEntities.map((ge, idx) => {
                                                    const hasTimestamp = ge.start_ms != null;
                                                    const startSec = hasTimestamp ? ge.start_ms! / 1000 : 0;
                                                    const isActive = activeGeminiIdx === idx;
                                                    const isInRange = hasTimestamp && currentTime >= startSec && currentTime <= startSec + 10;
                                                    return (
                                                        <button
                                                            key={`gemini-${ge.label}-${idx}`}
                                                            onClick={() => {
                                                                if (!hasTimestamp) return;
                                                                if (audioRef.current) {
                                                                    audioRef.current.currentTime = startSec;
                                                                    setCurrentTime(startSec);
                                                                    setActiveGeminiIdx(idx);
                                                                    if (!isPlaying) {
                                                                        audioRef.current.play();
                                                                        setIsPlaying(true);
                                                                    }
                                                                }
                                                            }}
                                                            className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left text-xs transition-colors ${hasTimestamp ? 'cursor-pointer' : 'cursor-default opacity-80'
                                                                } ${(isActive || isInRange)
                                                                    ? 'bg-blue-50 ring-1 ring-blue-200'
                                                                    : hasTimestamp ? 'hover:bg-gray-100' : ''
                                                                }`}
                                                            title={hasTimestamp ? `Jump to ${formatAudioTime(startSec)}` : 'No timestamp available'}
                                                        >
                                                            <span className="shrink-0 text-[11px] font-medium text-gray-500" style={{ minWidth: '140px' }}>
                                                                {ge.label}
                                                            </span>
                                                            <span className="shrink-0 text-gray-400">→</span>
                                                            <span className="flex-1 font-medium text-gray-800" style={{ wordBreak: 'break-word' }}>{ge.value}</span>
                                                            {hasTimestamp && (
                                                                <span className="shrink-0 text-[10px] text-gray-400 font-mono">
                                                                    {formatAudioTime(startSec)}
                                                                </span>
                                                            )}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        ) : (transcriptionText || call.transcription) && geminiStatus !== 'idle' ? (
                                            <p className="text-xs text-gray-400 italic bg-gray-50 p-3 rounded-md">No key entities detected for this call.</p>
                                        ) : isTranscribing ? (
                                            <p className="text-xs text-gray-400 italic bg-gray-50 p-3 rounded-md">Will appear after transcription completes.</p>
                                        ) : null}
                                    </div>
                                </div>
                            )}

                            {/* Transcription - Show only when active */}
                            {activeSection === 'transcription' && (
                                <div className="pt-2">
                                    <ScrollArea className="h-48 bg-gray-50 p-3 rounded-md">
                                        {isTranscribing ? (
                                            <div className="flex items-center gap-2">
                                                <div className="w-4 h-4 border-2 border-gray-600 border-t-transparent rounded-full animate-spin" />
                                                <p className="text-sm text-gray-400 animate-pulse">Generating transcription...</p>
                                            </div>
                                        ) : isLiveStreaming ? (
                                            <div>
                                                <div className="flex items-center gap-2 mb-2">
                                                    <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                                                    <span className="text-xs text-red-500 font-medium">Live transcription</span>
                                                </div>
                                                <div className="space-y-1">
                                                    {liveLines.map((line, idx) => (
                                                        <div key={idx} className="flex items-baseline gap-2 px-2 py-1 text-xs">
                                                            <span className={`shrink-0 text-[10px] font-semibold ${line.speaker === 'agent' ? 'text-blue-500' : 'text-green-600'
                                                                }`}>
                                                                {line.speaker === 'agent' ? 'Agent' : 'Customer'}:
                                                            </span>
                                                            <span className="flex-1 text-sm text-gray-700 leading-relaxed">
                                                                {line.text}
                                                                {!line.isFinal && <span className="ml-1 text-gray-300 animate-pulse">▋</span>}
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        ) : (transcriptionText || call.transcription) ? (
                                            <div>
                                                <div className="space-y-0.5">
                                                    {(transcriptionText || call.transcription || '').split('\n').filter((l: string) => l.trim()).map((line: string, idx: number) => {
                                                        const match = line.match(/^\[(\d+)ms\]\s*/);
                                                        const startMs = match ? parseInt(match[1], 10) : null;
                                                        const cleanLine = match ? line.slice(match[0].length) : line;
                                                        const startSec = startMs != null ? startMs / 1000 : null;
                                                        return (
                                                            <button
                                                                key={idx}
                                                                onClick={() => {
                                                                    if (audioRef.current && startSec != null) {
                                                                        audioRef.current.currentTime = startSec;
                                                                        setCurrentTime(startSec);
                                                                        if (!isPlaying) {
                                                                            audioRef.current.play();
                                                                            setIsPlaying(true);
                                                                        }
                                                                    }
                                                                }}
                                                                className={`w-full flex items-baseline gap-2 px-2 py-1.5 rounded text-left text-xs transition-colors ${startSec != null ? 'cursor-pointer hover:bg-gray-100' : 'cursor-default'}`}
                                                            >
                                                                {startSec != null && (
                                                                    <span className="shrink-0 text-[10px] text-gray-400 font-mono tabular-nums">
                                                                        {formatAudioTime(startSec)}
                                                                    </span>
                                                                )}
                                                                <span className="flex-1 text-sm text-gray-700 leading-relaxed">{cleanLine}</span>
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                                {call.callSid && (
                                                    <button
                                                        onClick={async () => {
                                                            setIsTranscribing(true);
                                                            setTranscribeError(null);
                                                            try {
                                                                await authedFetch(`/api/calls/${call.callSid}/transcript`, { method: 'DELETE' });
                                                                setTranscriptionText(null);
                                                                setEntities([]);
                                                                setSentimentScore(null);
                                                                setGeminiSummary(null);
                                                                setGeminiEntities([]);
                                                                setGeminiStatus('idle');
                                                                setActiveGeminiIdx(null);
                                                                geminiLoadedRef.current = false;
                                                                mediaLoadedRef.current = false;
                                                                const res = await authedFetch(`/api/calls/${call.callSid}/transcribe`, { method: 'POST' });
                                                                const data = await res.json();
                                                                if (!res.ok) throw new Error(data.error || 'Failed');
                                                                setTranscriptionText(data.transcript);
                                                                if (data.entities) setEntities(data.entities);
                                                                if (data.gemini_summary) {
                                                                    setGeminiSummary(data.gemini_summary);
                                                                    setGeminiEntities(data.gemini_entities || []);
                                                                    setGeminiStatus('ready');
                                                                }
                                                                if (data.sentimentScore != null) setSentimentScore(data.sentimentScore);
                                                            } catch (err: any) {
                                                                setTranscribeError(err.message);
                                                            } finally {
                                                                setIsTranscribing(false);
                                                            }
                                                        }}
                                                        className="mt-2 text-[11px] px-2 py-1 text-gray-400 border border-gray-300 rounded hover:bg-gray-100 transition-colors cursor-pointer"
                                                    >
                                                        ↻ Reset transcription
                                                    </button>
                                                )}
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
                                                                if (data.gemini_summary) {
                                                                    setGeminiSummary(data.gemini_summary);
                                                                    setGeminiEntities(data.gemini_entities || []);
                                                                    setGeminiStatus('ready');
                                                                }
                                                                if (data.sentimentScore != null) setSentimentScore(data.sentimentScore);
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
