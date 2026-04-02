/**
 * PulseCallListItem — call event card in the timeline.
 * Card-based design: direction icon + phone + time in header,
 * audio player inside the card, expandable system details.
 */
import { useState } from 'react';
import {
    PhoneIncoming, PhoneOutgoing, ArrowLeftRight,
    Settings2, Clock, DollarSign, Hash, Navigation, Timer,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPhoneDisplay as formatPhoneNumber } from '@/utils/phoneUtils';
import type { CallData } from '../call-list-item';
import { PulseCallAudioPlayer } from './PulseCallAudioPlayer';

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { classes: string; label: string }> = {
    completed:            { classes: 'bg-green-500/10 text-green-700 border-green-200', label: 'Completed' },
    'no-answer':          { classes: 'bg-yellow-500/10 text-yellow-700 border-yellow-200', label: 'No Answer' },
    busy:                 { classes: 'bg-orange-500/10 text-orange-700 border-orange-200', label: 'Busy' },
    failed:               { classes: 'bg-red-500/10 text-red-700 border-red-200', label: 'Failed' },
    canceled:             { classes: 'bg-gray-500/10 text-gray-700 border-gray-200', label: 'Canceled' },
    ringing:              { classes: 'bg-blue-500/10 text-blue-700 border-blue-200', label: 'Ringing' },
    'in-progress':        { classes: 'bg-purple-500/10 text-purple-700 border-purple-200', label: 'In Progress' },
    voicemail_recording:  { classes: 'bg-orange-500/10 text-orange-700 border-orange-200', label: 'Voicemail' },
    voicemail_left:       { classes: 'bg-red-500/10 text-red-700 border-red-200', label: 'Voicemail Left' },
};

function getStatusConfig(status: string) {
    return STATUS_CONFIG[status] || { classes: 'bg-gray-500/10 text-gray-700 border-gray-200', label: status };
}

// ── Formatters ────────────────────────────────────────────────────────────────

const formatDuration = (seconds: number | null | undefined): string => {
    if (!seconds) return 'N/A';
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

    const dir = call.direction as string;
    const DirectionIcon = dir === 'incoming'
        ? PhoneIncoming
        : dir === 'internal'
            ? ArrowLeftRight
            : PhoneOutgoing;

    const directionLabel = dir === 'incoming' ? 'Incoming Call' : dir === 'internal' ? 'Internal Call' : 'Outgoing Call';

    return (
        <Card className="overflow-hidden border border-gray-200 hover:shadow-md transition-shadow">
            {/* Header */}
            <div className={`p-4 ${call.audioUrl ? 'pb-0' : ''}`}>
                <div className="flex items-center gap-3">
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div className={`flex items-center justify-center w-9 h-9 rounded-full border ${cfg.classes}`}>
                                    <DirectionIcon className="w-4 h-4" />
                                </div>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>{directionLabel} — {cfg.label}</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>

                    <p className="text-xs text-gray-600 font-mono">{formatPhoneNumber(otherPartyNumber)}</p>
                    <div className="flex-1" />
                    <div className="text-xs text-gray-500">{formatTime(call.startTime)}</div>

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

            {/* Audio Player, Summary, Transcription */}
            <div className="bg-gray-50/50">
                <PulseCallAudioPlayer call={call} />
            </div>

            {/* System Info */}
            {showSystemInfo && (
                <div className="p-4 pt-0 space-y-2 text-sm bg-gray-50">
                    <div className="flex items-center gap-2">
                        <Clock className="w-4 h-4 text-gray-400" />
                        <span className="text-gray-600">Duration:</span>
                        <span className="font-mono text-gray-900">{formatDuration(call.totalDuration || call.duration)}</span>
                    </div>
                    {call.talkTime !== undefined && (
                        <div className="flex items-center gap-2">
                            <Timer className="w-4 h-4 text-gray-400" />
                            <span className="text-gray-600">Talk:</span>
                            <span className="font-mono text-gray-900">{formatDuration(call.talkTime)}</span>
                        </div>
                    )}
                    {call.waitTime !== undefined && (
                        <div className="flex items-center gap-2">
                            <Clock className="w-4 h-4 text-gray-400" />
                            <span className="text-gray-600">Wait:</span>
                            <span className="font-mono text-gray-900">{formatDuration(call.waitTime)}</span>
                        </div>
                    )}
                    {call.cost !== undefined && (
                        <div className="flex items-center gap-2">
                            <DollarSign className="w-4 h-4 text-gray-400" />
                            <span className="text-gray-600">Cost:</span>
                            <span className="font-mono text-gray-900">${call.cost.toFixed(4)} USD</span>
                        </div>
                    )}
                    <div className="flex items-center gap-2">
                        <Hash className="w-4 h-4 text-gray-400" />
                        <span className="text-gray-600">Call SID:</span>
                        <code className="text-xs bg-gray-200 px-2 py-1 rounded font-mono text-gray-800">{call.callSid}</code>
                    </div>
                    <div className="flex items-center gap-2">
                        <Navigation className="w-4 h-4 text-gray-400" />
                        <span className="text-gray-600">Direction:</span>
                        <span className="font-mono text-gray-900">{call.twilioDirection}</span>
                    </div>
                </div>
            )}
        </Card>
    );
}
