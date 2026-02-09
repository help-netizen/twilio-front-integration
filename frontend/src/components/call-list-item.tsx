import { useState, useRef, useEffect } from 'react';
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPhoneNumber } from '@/utils/formatters';

export interface CallData {
    id: string;
    direction: 'incoming' | 'outgoing';
    from: string;
    to: string;
    duration: number | null;
    totalDuration?: number;
    talkTime?: number;
    waitTime?: number;
    status: 'completed' | 'no-answer' | 'busy' | 'failed';
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
}

interface CallListItemProps {
    call: CallData;
}

export function CallListItem({ call }: CallListItemProps) {
    const [showSystemInfo, setShowSystemInfo] = useState(false);
    const [activeSection, setActiveSection] = useState<'summary' | 'transcription' | null>(null);

    // Audio player state
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(call.recordingDuration || call.totalDuration || call.duration || 0);
    const audioRef = useRef<HTMLAudioElement>(null);

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
            default:
                return 'bg-gray-500/10 text-gray-700 border-gray-200';
        }
    };

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

    return (
        <Card className="overflow-hidden border border-gray-200 hover:shadow-md transition-shadow">
            {/* Main Call Info */}
            <div className="p-4 pb-2">
                <div className="flex items-center gap-3">
                    {/* Combined Direction Icon and Status */}
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div className={`flex items-center gap-2 px-3 py-2 rounded-full border ${getStatusColor(call.status)}`}>
                                    {call.direction === 'incoming' ? (
                                        <PhoneIncoming className="w-4 h-4" />
                                    ) : (
                                        <PhoneOutgoing className="w-4 h-4" />
                                    )}
                                    <span className="text-xs font-medium">
                                        {call.status.replace('-', ' ')}
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
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                                <p className="text-sm text-gray-900 font-mono font-semibold">{formatPhoneNumber(otherPartyNumber)}</p>
                                {(call.totalDuration || call.duration) ? (
                                    <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>{formatDuration(call.totalDuration || call.duration)}</span>
                                ) : null}
                            </div>
                            {/* Date and System Info toggle in top right corner */}
                            <div className="flex items-center gap-2">
                                <div className="text-xs text-gray-500">
                                    {formatTime(call.startTime)}
                                </div>
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
                    </div>
                </div>
            </div>

            {/* Always Visible Content */}
            <div className="bg-gray-50/50">
                {/* Audio Player */}
                {call.audioUrl && (
                    <div className="px-4 pb-4 bg-white">
                        <audio ref={audioRef} src={call.audioUrl} preload="metadata" />

                        <div className="space-y-3">
                            {/* Single row: [Summary][Transcript] | [⟲10][▶][⟳10] | 0:00 ━━●── 3:45 */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                {/* LEFT: Summary/Transcript buttons */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
                                    <button
                                        onClick={() => setActiveSection(activeSection === 'summary' ? null : 'summary')}
                                        style={{
                                            fontSize: '0.75rem',
                                            lineHeight: '1rem',
                                            background: 'transparent',
                                            border: 'none',
                                            borderBottom: activeSection === 'summary' ? '2px solid #374151' : '1px dashed #9ca3af',
                                            borderRadius: 0,
                                            padding: 0,
                                            paddingBottom: '1px',
                                            cursor: 'pointer',
                                            color: activeSection === 'summary' ? '#374151' : '#6b7280',
                                            outline: 'none',
                                            transition: 'color 150ms, border-color 150ms',
                                        }}
                                    >
                                        Summary
                                    </button>
                                    <button
                                        onClick={() => setActiveSection(activeSection === 'transcription' ? null : 'transcription')}
                                        style={{
                                            fontSize: '0.75rem',
                                            lineHeight: '1rem',
                                            background: 'transparent',
                                            border: 'none',
                                            borderBottom: activeSection === 'transcription' ? '2px solid #374151' : '1px dashed #9ca3af',
                                            borderRadius: 0,
                                            padding: 0,
                                            paddingBottom: '1px',
                                            cursor: 'pointer',
                                            color: activeSection === 'transcription' ? '#374151' : '#6b7280',
                                            outline: 'none',
                                            transition: 'color 150ms, border-color 150ms',
                                        }}
                                    >
                                        {call.transcriptStatus === 'processing' ? 'Transcribing...' : 'Transcript'}
                                    </button>
                                </div>

                                {/* CENTER: Audio Controls */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', flexShrink: 0 }}>
                                    <button
                                        onClick={() => handleSkip(-10)}
                                        title="Rewind 10 seconds"
                                        style={{
                                            height: '2rem',
                                            width: '2rem',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            background: 'transparent',
                                            border: 'none',
                                            padding: 0,
                                            cursor: 'pointer',
                                            color: '#6b7280',
                                            position: 'relative',
                                            transition: 'color 150ms',
                                        }}
                                    >
                                        <RotateCcw style={{ width: 20, height: 20, minWidth: 20, stroke: '#6b7280', fill: 'none' }} />
                                        <span style={{ position: 'absolute', fontSize: '7px', fontWeight: 700, color: '#6b7280', lineHeight: 1 }}>10</span>
                                    </button>

                                    <button
                                        onClick={handlePlayPause}
                                        style={{
                                            height: '2rem',
                                            width: '2rem',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            background: 'transparent',
                                            border: 'none',
                                            padding: 0,
                                            cursor: 'pointer',
                                            color: '#6b7280',
                                            transition: 'color 150ms',
                                        }}
                                    >
                                        {isPlaying ? (
                                            <Pause style={{ width: 20, height: 20, minWidth: 20, stroke: '#6b7280', fill: 'none' }} />
                                        ) : (
                                            <Play style={{ width: 20, height: 20, minWidth: 20, stroke: '#6b7280', fill: 'none' }} />
                                        )}
                                    </button>

                                    <button
                                        onClick={() => handleSkip(10)}
                                        title="Forward 10 seconds"
                                        style={{
                                            height: '2rem',
                                            width: '2rem',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            background: 'transparent',
                                            border: 'none',
                                            padding: 0,
                                            cursor: 'pointer',
                                            color: '#6b7280',
                                            position: 'relative',
                                            transition: 'color 150ms',
                                        }}
                                    >
                                        <RotateCw style={{ width: 20, height: 20, minWidth: 20, stroke: '#6b7280', fill: 'none' }} />
                                        <span style={{ position: 'absolute', fontSize: '7px', fontWeight: 700, color: '#6b7280', lineHeight: 1 }}>10</span>
                                    </button>
                                </div>

                                {/* RIGHT: Timeline (stretches) */}
                                <div style={{ flex: '1 1 0%', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <span style={{ fontSize: '0.75rem', lineHeight: '1rem', color: '#9ca3af', flexShrink: 0, width: '2.5rem', textAlign: 'right' }}>
                                        {formatAudioTime(currentTime)}
                                    </span>
                                    <Slider
                                        value={[currentTime]}
                                        max={duration || 100}
                                        step={1}
                                        onValueChange={handleSliderChange}
                                        className="flex-1"
                                    />
                                    <span style={{ fontSize: '0.75rem', lineHeight: '1rem', color: '#9ca3af', flexShrink: 0, width: '2.5rem' }}>
                                        {formatAudioTime(duration)}
                                    </span>
                                </div>
                            </div>

                            {/* Summary - Show only when active */}
                            {activeSection === 'summary' && (
                                <div className="pt-2">
                                    {call.summary ? (
                                        <p className="text-sm text-gray-700 leading-relaxed bg-blue-50 p-3 rounded-md">
                                            {call.summary}
                                        </p>
                                    ) : (
                                        <p className="text-sm text-gray-400 italic bg-gray-50 p-3 rounded-md">
                                            No summary available
                                        </p>
                                    )}
                                </div>
                            )}

                            {/* Transcription - Show only when active */}
                            {activeSection === 'transcription' && (
                                <div className="pt-2">
                                    <ScrollArea className="h-48 bg-gray-50 p-3 rounded-md">
                                        {call.transcriptStatus === 'processing' ? (
                                            <p className="text-sm text-gray-500 italic animate-pulse">Transcribing audio...</p>
                                        ) : call.transcriptStatus === 'failed' ? (
                                            <p className="text-sm text-red-500">Transcription failed</p>
                                        ) : call.transcription ? (
                                            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                                                {call.transcription}
                                            </p>
                                        ) : (
                                            <p className="text-sm text-gray-400 italic">No transcript available</p>
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
                            <div className="p-4 bg-white border-t border-gray-200">
                                <h4 className="font-semibold text-gray-900 mb-2">Summary</h4>
                                <p className="text-sm text-gray-700 leading-relaxed bg-blue-50 p-3 rounded-md">
                                    {call.summary}
                                </p>
                            </div>
                        )}

                        {call.transcription && (
                            <div className="p-4 bg-white border-t border-gray-200">
                                <h4 className="font-semibold text-gray-900 mb-2">Transcription</h4>
                                <ScrollArea className="h-48 bg-gray-50 p-3 rounded-md">
                                    <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                                        {call.transcription}
                                    </p>
                                </ScrollArea>
                            </div>
                        )}
                    </>
                )}

                {/* System Information */}
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

                        {call.parentCall && (
                            <div className="flex items-center gap-2">
                                <GitBranch className="w-4 h-4 text-gray-400" />
                                <span className="text-gray-600">Parent Call:</span>
                                <code className="text-xs bg-gray-200 px-2 py-1 rounded font-mono text-gray-800">
                                    {call.parentCall}
                                </code>
                            </div>
                        )}

                        <div className="flex items-center gap-2">
                            <Navigation className="w-4 h-4 text-gray-400" />
                            <span className="text-gray-600">Twilio Direction:</span>
                            <span className="font-mono text-gray-900">{call.twilioDirection}</span>
                        </div>
                    </div>
                )}
            </div>
        </Card>
    );
}
