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
    Timer
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
    const [activeSection, setActiveSection] = useState<'summary' | 'transcription' | null>(null);
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

    const formatDuration = (seconds: number | null) => {
        if (seconds === null || seconds === 0) return 'N/A';
        if (seconds < 60) return `${seconds}s`;
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}m ${secs}s`;
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
                                    {call.summary ? (
                                        <p className="text-sm leading-relaxed bg-muted/50 p-3 rounded-md">
                                            {call.summary}
                                        </p>
                                    ) : (
                                        <p className="text-sm text-muted-foreground italic bg-muted/30 p-3 rounded-md">
                                            No summary available
                                        </p>
                                    )}

                                    {/* Detected Entities */}
                                    <div className="bg-muted/30 rounded-md p-3">
                                        <div className="flex items-center justify-between mb-2">
                                            <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">Detected Entities</h4>
                                            {entities.length > 0 && (
                                                <span className="text-[10px] text-muted-foreground">{entities.length} found</span>
                                            )}
                                        </div>
                                        {entities.length > 0 ? (
                                            <ScrollArea className="max-h-48">
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
                                                                className={cn(
                                                                    'w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs transition-colors cursor-pointer',
                                                                    (isActive || isInRange)
                                                                        ? 'bg-primary/10 ring-1 ring-primary/30'
                                                                        : 'hover:bg-muted/60'
                                                                )}
                                                                aria-label={`${entity.entity_type.replace(/_/g, ' ')}: ${entity.text}, at ${formatAudioTime(startSec)}`}
                                                            >
                                                                <span className="shrink-0 px-1.5 py-0.5 rounded bg-muted text-[10px] font-medium text-muted-foreground uppercase">
                                                                    {entity.entity_type.replace(/_/g, ' ')}
                                                                </span>
                                                                <span className="flex-1 truncate font-medium text-foreground">{entity.text}</span>
                                                                {entity.start != null && (
                                                                    <span className="shrink-0 text-[10px] text-muted-foreground font-mono">
                                                                        {formatAudioTime(startSec)}
                                                                    </span>
                                                                )}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </ScrollArea>
                                        ) : transcriptionText || call.transcription ? (
                                            <p className="text-xs text-muted-foreground italic">No entities detected for this call.</p>
                                        ) : (
                                            <p className="text-xs text-muted-foreground italic">Entities will appear after transcription is complete.</p>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Transcription - Show only when active */}
                            {activeSection === 'transcription' && (
                                <div className="pt-2">
                                    <ScrollArea className="h-48 bg-muted/30 p-3 rounded-md">
                                        {(transcriptionText || call.transcription) ? (
                                            <p className="text-sm leading-relaxed whitespace-pre-wrap">
                                                {transcriptionText || call.transcription}
                                            </p>
                                        ) : isTranscribing ? (
                                            <div className="flex items-center gap-2">
                                                <div className="size-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                                                <p className="text-sm text-muted-foreground animate-pulse">Generating transcription...</p>
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
                )}

                {/* No Audio - Show Summary and Transcription separately */}
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
                                <ScrollArea className="h-48 bg-muted/30 p-3 rounded-md">
                                    <p className="text-sm leading-relaxed whitespace-pre-wrap">
                                        {call.transcription}
                                    </p>
                                </ScrollArea>
                            </div>
                        )}
                    </>
                )}

                {/* System Information */}
                {showSystemInfo && (
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
                )}
            </div>
        </Card>
    );
}
