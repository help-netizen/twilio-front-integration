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
    GitBranch,
    Navigation,
    Timer,
    Copy,
    Check,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPhoneNumber } from '@/utils/formatters';
import { cn } from '@/lib/utils';

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

interface CallListItemProps {
    call: CallData;
}

const STATUS_CONFIG: Record<string, { label: string; iconColor: string; iconBg: string; badgeBg: string; badgeText: string }> = {
    'completed': { label: 'completed', iconColor: '#16a34a', iconBg: '#dcfce7', badgeBg: '#dcfce7', badgeText: '#15803d' },
    'no-answer': { label: 'missed', iconColor: '#dc2626', iconBg: '#fee2e2', badgeBg: '#fee2e2', badgeText: '#b91c1c' },
    'busy': { label: 'busy', iconColor: '#ea580c', iconBg: '#ffedd5', badgeBg: '#ffedd5', badgeText: '#c2410c' },
    'failed': { label: 'missed', iconColor: '#dc2626', iconBg: '#fee2e2', badgeBg: '#fee2e2', badgeText: '#b91c1c' },
    'ringing': { label: 'ringing', iconColor: '#2563eb', iconBg: '#dbeafe', badgeBg: '#dbeafe', badgeText: '#1d4ed8' },
    'in-progress': { label: 'in progress', iconColor: '#7c3aed', iconBg: '#ede9fe', badgeBg: '#ede9fe', badgeText: '#6d28d9' },
    'voicemail_recording': { label: 'leaving voicemail', iconColor: '#ea580c', iconBg: '#ffedd5', badgeBg: '#ffedd5', badgeText: '#c2410c' },
    'voicemail_left': { label: 'voicemail left', iconColor: '#dc2626', iconBg: '#fee2e2', badgeBg: '#fee2e2', badgeText: '#b91c1c' },
};

export function CallListItem({ call }: CallListItemProps) {
    const { token } = useAuth();
    const [showSystemInfo, setShowSystemInfo] = useState(false);
    const [activeSection, setActiveSection] = useState<'summary' | 'transcription' | null>(() => {
        if (call.summary) return 'summary';
        return null;
    });
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [transcriptionText, setTranscriptionText] = useState<string | null>(null);
    const [transcribeError, setTranscribeError] = useState<string | null>(null);
    const [entities, setEntities] = useState<Entity[]>([]);
    const [sentimentScore, setSentimentScore] = useState<number | null>(null);

    // Gemini summary + structured entities
    const [geminiSummary, setGeminiSummary] = useState<string | null>(null);
    const [geminiEntities, setGeminiEntities] = useState<GeminiEntity[]>([]);
    const [geminiStatus, setGeminiStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [activeGeminiIdx, setActiveGeminiIdx] = useState<number | null>(null);
    const [copiedEntityIdx, setCopiedEntityIdx] = useState<number | null>(null);
    const [copiedSummary, setCopiedSummary] = useState(false);
    const geminiLoadedRef = useRef(false);

    // Audio player state
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(call.recordingDuration || call.totalDuration || call.duration || 0);
    const audioRef = useRef<HTMLAudioElement>(null);

    const formatDuration = (seconds: number | null) => {
        if (seconds === null || seconds === 0) return 'N/A';
        if (seconds < 60) return `${seconds}s`;
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}m ${secs}s`;
    };

    // Map sentiment score (-1…+1) to 5-level emoji + color
    const getSentimentDisplay = (score: number | null) => {
        if (score === null) return null;
        if (score <= -0.4) return { emoji: '😡', color: '#dc2626', label: 'Very Negative' };
        if (score <= -0.1) return { emoji: '😟', color: '#f59e0b', label: 'Negative' };
        if (score <= 0.1) return { emoji: '😐', color: '#eab308', label: 'Neutral' };
        if (score <= 0.4) return { emoji: '😊', color: '#22c55e', label: 'Positive' };
        return { emoji: '😄', color: '#3b82f6', label: 'Very Positive' };
    };

    const formatTime = (date: Date) => {
        return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        });
    };

    const formatAudioTime = (seconds: number) => {
        if (!isFinite(seconds) || isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const handlePlayPause = () => {
        if (audioRef.current) {
            if (isPlaying) {
                audioRef.current.pause();
            } else {
                audioRef.current.play();
            }
            setIsPlaying(!isPlaying);
        }
    };

    const handleSkip = (seconds: number) => {
        if (audioRef.current) {
            audioRef.current.currentTime = Math.max(0, Math.min(audioRef.current.currentTime + seconds, duration));
        }
    };

    const handleSliderChange = (value: number[]) => {
        if (audioRef.current) {
            audioRef.current.currentTime = value[0];
            setCurrentTime(value[0]);
        }
    };

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;

        const updateTime = () => setCurrentTime(audio.currentTime);
        const updateDuration = () => {
            if (isFinite(audio.duration)) setDuration(audio.duration);
        };
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
                    // Eagerly load Gemini summary/entities
                    if (t.gemini_summary) {
                        setGeminiSummary(t.gemini_summary);
                        setGeminiEntities(t.gemini_entities || []);
                        setGeminiStatus('ready');
                        geminiLoadedRef.current = true;
                        // Auto-open Summary tab if nothing is open yet
                        setActiveSection(prev => prev ?? 'summary');
                    }
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
                    // Also fill entities/transcript if not already set
                    if (!transcriptionText && t.text) setTranscriptionText(t.text);
                    if (entities.length === 0 && t.entities?.length) setEntities(t.entities);
                    if (sentimentScore === null && t.sentimentScore != null) setSentimentScore(t.sentimentScore);
                    // Gemini data
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

    const otherPartyNumber = call.direction === 'incoming' ? call.from : call.to;
    const directionLabel = call.direction === 'incoming' ? 'Incoming Call' : 'Outgoing Call';
    const statusCfg = STATUS_CONFIG[call.status] || STATUS_CONFIG['completed'];

    return (
        <Card className="overflow-hidden border hover:border-primary/40 transition-colors">
            {/* Main Call Info */}
            <div className="p-4 pb-2">
                <div className="flex items-center gap-3">
                    {/* Direction Icon with colored background + Status Badge */}
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div className="flex items-center gap-1.5 shrink-0">
                                    <div
                                        className="flex items-center justify-center size-7 rounded-full"
                                        style={{ backgroundColor: statusCfg.iconBg }}
                                    >
                                        {call.direction === 'incoming' ? (
                                            <PhoneIncoming className="size-4" style={{ color: statusCfg.iconColor }} />
                                        ) : (
                                            <PhoneOutgoing className="size-4" style={{ color: statusCfg.iconColor }} />
                                        )}
                                    </div>
                                    <span
                                        className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium"
                                        style={{ backgroundColor: statusCfg.badgeBg, color: statusCfg.badgeText }}
                                    >
                                        {statusCfg.label}
                                    </span>
                                </div>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>{directionLabel}</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>

                    {/* Call Details */}
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-baseline gap-2">
                                <p className="text-sm font-mono font-semibold">{formatPhoneNumber(otherPartyNumber)}</p>
                                {call.status === 'in-progress' && call.answeredBy ? (
                                    <span className="text-xs font-medium" style={{ color: '#16a34a' }}>{call.answeredBy}</span>
                                ) : (call.totalDuration || call.duration) ? (
                                    <span className="text-xs text-muted-foreground">{formatDuration(call.totalDuration || call.duration)}</span>
                                ) : null}
                            </div>
                            {/* Date and System Info toggle */}
                            <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">
                                    {formatTime(call.startTime)}
                                </span>
                                <TooltipProvider>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => setShowSystemInfo(!showSystemInfo)}
                                                className="size-6"
                                            >
                                                <Settings2 className={cn('size-4 transition-transform', showSystemInfo && 'rotate-90')} />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                            <p>System Information</p>
                                        </TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Always Visible Content */}
            <div>
                {/* Audio Player */}
                {call.audioUrl && (
                    <div className="px-4 pb-4">
                        <audio ref={audioRef} src={token ? `${call.audioUrl}?token=${encodeURIComponent(token)}` : call.audioUrl} preload="metadata" />

                        <div className="space-y-3">
                            {/* Single row: [Summary][Transcript] | [⟲10][▶][⟳10] | 0:00 ━━●── 3:45 */}
                            <div className="flex items-center gap-3">
                                {/* LEFT: Summary/Transcript buttons */}
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
                                        className={cn(
                                            'text-xs bg-transparent border-0 border-b pb-px cursor-pointer outline-none transition-colors',
                                            activeSection === 'summary'
                                                ? 'text-foreground border-b-2 border-foreground'
                                                : 'text-muted-foreground border-dashed border-muted-foreground hover:text-foreground'
                                        )}
                                    >
                                        Summary
                                    </button>
                                    <button
                                        onClick={() => setActiveSection(activeSection === 'transcription' ? null : 'transcription')}
                                        className={cn(
                                            'text-xs bg-transparent border-0 border-b pb-px cursor-pointer outline-none transition-colors',
                                            activeSection === 'transcription'
                                                ? 'text-foreground border-b-2 border-foreground'
                                                : 'text-muted-foreground border-dashed border-muted-foreground hover:text-foreground'
                                        )}
                                    >
                                        Transcription
                                    </button>
                                </div>

                                {/* CENTER: Audio Controls */}
                                <div className="flex items-center gap-0.5 shrink-0">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="size-8 relative"
                                        onClick={() => handleSkip(-10)}
                                        title="Rewind 10 seconds"
                                    >
                                        <RotateCcw className="size-5 text-muted-foreground" />
                                        <span className="absolute text-[7px] font-bold text-muted-foreground leading-none">10</span>
                                    </Button>

                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="size-8"
                                        onClick={handlePlayPause}
                                    >
                                        {isPlaying ? (
                                            <Pause className="size-5 text-muted-foreground" />
                                        ) : (
                                            <Play className="size-5 text-muted-foreground" />
                                        )}
                                    </Button>

                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="size-8 relative"
                                        onClick={() => handleSkip(10)}
                                        title="Forward 10 seconds"
                                    >
                                        <RotateCw className="size-5 text-muted-foreground" />
                                        <span className="absolute text-[7px] font-bold text-muted-foreground leading-none">10</span>
                                    </Button>
                                </div>

                                {/* RIGHT: Timeline (stretches) */}
                                <div className="flex-1 flex items-center gap-2">
                                    <span className="text-xs text-muted-foreground shrink-0 w-10 text-right">
                                        {formatAudioTime(currentTime)}
                                    </span>
                                    <Slider
                                        value={[currentTime]}
                                        max={duration || 100}
                                        step={1}
                                        onValueChange={handleSliderChange}
                                        className="flex-1"
                                    />
                                    <span className="text-xs text-muted-foreground shrink-0 w-10">
                                        {formatAudioTime(duration)}
                                    </span>
                                </div>
                            </div>

                            {/* Summary - Show only when active */}
                            {activeSection === 'summary' && (
                                <div className="pt-2 space-y-3">
                                    {/* ── Call Summary (Gemini) ── */}
                                    <div>
                                        <div className="flex items-center gap-1.5 mb-1">
                                            <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">Call Summary</h4>
                                            {(geminiSummary || call.summary) && (
                                                <button
                                                    onClick={() => {
                                                        navigator.clipboard.writeText(geminiSummary || call.summary || '');
                                                        setCopiedSummary(true);
                                                        setTimeout(() => setCopiedSummary(false), 1500);
                                                    }}
                                                    className="p-0.5 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors"
                                                    title="Copy summary"
                                                >
                                                    {copiedSummary ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
                                                </button>
                                            )}
                                        </div>
                                        {geminiStatus === 'loading' ? (
                                            <div className="flex items-center gap-2 bg-muted/30 p-3 rounded-md">
                                                <div className="size-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                                                <span className="text-sm text-muted-foreground animate-pulse">Generating summary…</span>
                                            </div>
                                        ) : geminiStatus === 'error' ? (
                                            <p className="text-sm text-destructive italic bg-destructive/5 p-3 rounded-md">Summary unavailable</p>
                                        ) : geminiSummary ? (
                                            <p className="text-sm leading-relaxed bg-muted/50 p-3 rounded-md">{geminiSummary}</p>
                                        ) : call.summary ? (
                                            <p className="text-sm leading-relaxed bg-muted/50 p-3 rounded-md">{call.summary}</p>
                                        ) : isTranscribing ? (
                                            <p className="text-sm text-muted-foreground italic bg-muted/30 p-3 rounded-md">Not ready (waiting for transcript)</p>
                                        ) : (
                                            <p className="text-sm text-muted-foreground italic bg-muted/30 p-3 rounded-md">No summary available</p>
                                        )}
                                    </div>

                                    {/* ── Key Entities (Gemini structured) ── */}
                                    <div>
                                        <div className="flex items-center justify-between mb-1">
                                            <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">Key Entities</h4>
                                            {geminiEntities.length > 0 && (
                                                <span className="text-[10px] text-muted-foreground">{geminiEntities.length} found</span>
                                            )}
                                        </div>
                                        {geminiStatus === 'loading' ? (
                                            <div className="flex items-center gap-2 bg-muted/30 p-3 rounded-md">
                                                <div className="size-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                                                <span className="text-sm text-muted-foreground animate-pulse">Extracting entities…</span>
                                            </div>
                                        ) : geminiStatus === 'error' ? (
                                            <p className="text-sm text-destructive italic bg-destructive/5 p-3 rounded-md">Entities unavailable</p>
                                        ) : geminiEntities.length > 0 ? (
                                            <div className="bg-muted/30 p-3 rounded-md space-y-1">
                                                {geminiEntities.map((ge, idx) => {
                                                    const hasTimestamp = ge.start_ms != null;
                                                    const startSec = hasTimestamp ? ge.start_ms! / 1000 : 0;
                                                    const isActive = activeGeminiIdx === idx;
                                                    const isInRange = hasTimestamp && currentTime >= startSec && currentTime <= startSec + 10;
                                                    return (
                                                        <div
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
                                                            className={cn(
                                                                'w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left text-xs transition-colors group',
                                                                hasTimestamp ? 'cursor-pointer' : 'cursor-default opacity-80',
                                                                (isActive || isInRange)
                                                                    ? 'bg-primary/10 ring-1 ring-primary/30'
                                                                    : hasTimestamp ? 'hover:bg-muted/60' : ''
                                                            )}
                                                            title={hasTimestamp ? `Jump to ${formatAudioTime(startSec)}` : 'No timestamp available'}
                                                        >
                                                            <span className="shrink-0 text-[11px] font-medium text-muted-foreground" style={{ minWidth: '140px' }}>
                                                                {ge.label}
                                                            </span>
                                                            {/* Copy & Play action icons */}
                                                            <span className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                                                <button
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        navigator.clipboard.writeText(ge.value);
                                                                        setCopiedEntityIdx(idx);
                                                                        setTimeout(() => setCopiedEntityIdx(null), 1500);
                                                                    }}
                                                                    className="p-0.5 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors"
                                                                    title="Copy value"
                                                                >
                                                                    {copiedEntityIdx === idx ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
                                                                </button>
                                                                {hasTimestamp && (
                                                                    <button
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            if (audioRef.current) {
                                                                                audioRef.current.currentTime = startSec;
                                                                                setCurrentTime(startSec);
                                                                                setActiveGeminiIdx(idx);
                                                                                audioRef.current.play();
                                                                                setIsPlaying(true);
                                                                            }
                                                                        }}
                                                                        className="p-0.5 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors"
                                                                        title={`Play from ${formatAudioTime(startSec)}`}
                                                                    >
                                                                        <Play className="size-3" />
                                                                    </button>
                                                                )}
                                                            </span>
                                                            <span className="shrink-0 text-muted-foreground">→</span>
                                                            <span className="flex-1 font-medium text-foreground" style={{ wordBreak: 'break-word' }}>{ge.value}</span>
                                                            {hasTimestamp && (
                                                                <span className="shrink-0 text-[10px] text-muted-foreground font-mono">
                                                                    {formatAudioTime(startSec)}
                                                                </span>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        ) : (transcriptionText || call.transcription) && geminiStatus !== 'idle' ? (
                                            <p className="text-xs text-muted-foreground italic bg-muted/30 p-3 rounded-md">No key entities detected for this call.</p>
                                        ) : isTranscribing ? (
                                            <p className="text-xs text-muted-foreground italic bg-muted/30 p-3 rounded-md">Will appear after transcription completes.</p>
                                        ) : null}
                                    </div>
                                </div>
                            )}

                            {/* Transcription - Show only when active */}
                            {activeSection === 'transcription' && (
                                <div className="pt-2">
                                    <ScrollArea className="h-48 bg-muted/30 p-3 rounded-md">
                                        {isTranscribing ? (
                                            <div className="flex items-center gap-2">
                                                <div className="size-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                                                <p className="text-sm text-muted-foreground animate-pulse">Generating transcription...</p>
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
                                                                className={cn(
                                                                    'w-full flex items-baseline gap-2 px-2 py-1.5 rounded text-left text-xs transition-colors',
                                                                    startSec != null ? 'cursor-pointer hover:bg-muted/60' : 'cursor-default'
                                                                )}
                                                            >
                                                                {startSec != null && (
                                                                    <span className="shrink-0 text-[10px] text-muted-foreground font-mono tabular-nums">
                                                                        {formatAudioTime(startSec)}
                                                                    </span>
                                                                )}
                                                                <span className="flex-1 text-sm leading-relaxed">{cleanLine}</span>
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
                                                        className="mt-2 text-[11px] px-2 py-1 text-muted-foreground border border-muted-foreground/30 rounded hover:bg-muted/50 transition-colors cursor-pointer"
                                                    >
                                                        ↻ Reset transcription
                                                    </button>
                                                )}
                                            </div>
                                        ) : (
                                            <div>
                                                <p className="text-sm text-muted-foreground italic">No transcription available</p>
                                                {transcribeError && (
                                                    <p className="text-sm text-destructive mt-1">{transcribeError}</p>
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
                                                        className="mt-2 text-xs px-3 py-1.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors cursor-pointer"
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
                )
                }

                {/* No Audio - Show Summary and Transcription separately */}
                {
                    !call.audioUrl && (
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
                                    <ScrollArea className="h-48 bg-muted/30 p-3 rounded-md">
                                        <p className="text-sm leading-relaxed whitespace-pre-wrap">
                                            {call.transcription}
                                        </p>
                                    </ScrollArea>
                                </div>
                            )}
                        </>
                    )
                }

                {/* System Information */}
                {
                    showSystemInfo && (
                        <>
                            <Separator />
                            <div className="p-4 space-y-2 text-sm bg-muted/30">
                                <div className="flex items-center gap-2">
                                    <Clock className="size-4 text-muted-foreground" />
                                    <span className="text-muted-foreground">Duration:</span>
                                    <span className="font-mono">
                                        {formatDuration(call.totalDuration || call.duration)}
                                    </span>
                                </div>

                                {call.talkTime !== undefined && (
                                    <div className="flex items-center gap-2">
                                        <Timer className="size-4 text-muted-foreground" />
                                        <span className="text-muted-foreground">Talk:</span>
                                        <span className="font-mono">
                                            {formatDuration(call.talkTime)}
                                        </span>
                                    </div>
                                )}

                                {call.waitTime !== undefined && (
                                    <div className="flex items-center gap-2">
                                        <Clock className="size-4 text-muted-foreground" />
                                        <span className="text-muted-foreground">Wait:</span>
                                        <span className="font-mono">
                                            {formatDuration(call.waitTime)}
                                        </span>
                                    </div>
                                )}

                                {call.cost !== undefined && (
                                    <div className="flex items-center gap-2">
                                        <DollarSign className="size-4 text-muted-foreground" />
                                        <span className="text-muted-foreground">Cost:</span>
                                        <span className="font-mono">
                                            ${call.cost.toFixed(4)} USD
                                        </span>
                                    </div>
                                )}

                                <div className="flex items-center gap-2">
                                    <Hash className="size-4 text-muted-foreground" />
                                    <span className="text-muted-foreground">Call SID:</span>
                                    <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                                        {call.callSid}
                                    </code>
                                </div>

                                <div className="flex items-center gap-2">
                                    <Clock className="size-4 text-muted-foreground" />
                                    <span className="text-muted-foreground">Queue Time:</span>
                                    <span className="font-mono">{call.queueTime}s</span>
                                </div>

                                {call.parentCall && (
                                    <div className="flex items-center gap-2">
                                        <GitBranch className="size-4 text-muted-foreground" />
                                        <span className="text-muted-foreground">Parent Call:</span>
                                        <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                                            {call.parentCall}
                                        </code>
                                    </div>
                                )}

                                <div className="flex items-center gap-2">
                                    <Navigation className="size-4 text-muted-foreground" />
                                    <span className="text-muted-foreground">Twilio Direction:</span>
                                    <span className="font-mono">{call.twilioDirection}</span>
                                </div>
                            </div>
                        </>
                    )
                }
            </div >
        </Card >
    );
}
