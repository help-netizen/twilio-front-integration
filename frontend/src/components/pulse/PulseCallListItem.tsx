/**
 * PulseCallListItem — exact match to TIMELINE_TECHNICAL_SPECIFICATION.md
 */
import { useState } from 'react';
import { PhoneIncoming, PhoneOutgoing, Settings2, Clock, DollarSign, Hash, Navigation, Timer } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPhoneDisplay as formatPhoneNumber } from '@/utils/phoneUtils';
import type { CallData } from '../call-list-item';
import { PulseCallAudioPlayer } from './PulseCallAudioPlayer';

const getStatusColor = (status: string) => {
    switch (status) {
        case 'completed': return 'bg-green-500/10 text-green-700 border-green-200';
        case 'no-answer': return 'bg-yellow-500/10 text-yellow-700 border-yellow-200';
        case 'busy': return 'bg-orange-500/10 text-orange-700 border-orange-200';
        case 'failed': return 'bg-red-500/10 text-red-700 border-red-200';
        case 'ringing': return 'bg-blue-500/10 text-blue-700 border-blue-200';
        case 'in-progress': return 'bg-purple-500/10 text-purple-700 border-purple-200';
        case 'voicemail_recording': return 'bg-orange-500/10 text-orange-700 border-orange-200';
        case 'voicemail_left': return 'bg-red-500/10 text-red-700 border-red-200';
        default: return 'bg-gray-500/10 text-gray-700 border-gray-200';
    }
};

const formatDuration = (seconds: number | null | undefined): string => {
    if (!seconds) return 'N/A';
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const formatTime = (date: Date): string => date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

export function PulseCallListItem({ call }: { call: CallData }) {
    const [showSystemInfo, setShowSystemInfo] = useState(false);
    const otherPartyNumber = call.direction === 'incoming' ? call.from : call.to;
    const directionLabel = call.direction === 'incoming' ? 'Incoming Call' : 'Outgoing Call';

    return (
        <Card className="overflow-hidden hover:shadow-md transition-shadow" style={{ border: '1px solid var(--blanc-line)' }}>
            {/* Header */}
            <div className={`p-4 ${call.audioUrl ? 'pb-0' : ''}`}>
                <div className="flex items-center gap-3">
                    <TooltipProvider><Tooltip><TooltipTrigger asChild>
                        <div className={`flex items-center justify-center w-9 h-9 rounded-full border ${getStatusColor(call.status)}`}>
                            {call.direction === 'incoming' ? <PhoneIncoming className="w-4 h-4" /> : <PhoneOutgoing className="w-4 h-4" />}
                        </div>
                    </TooltipTrigger><TooltipContent><p>{directionLabel} - {call.status.replace('-', ' ').charAt(0).toUpperCase() + call.status.replace('-', ' ').slice(1)}</p></TooltipContent></Tooltip></TooltipProvider>
                    <p className="text-xs text-gray-600 font-mono">{formatPhoneNumber(otherPartyNumber)}</p>
                    <div className="flex-1" />
                    <div className="text-xs text-gray-500">{formatTime(call.startTime)}</div>
                    <TooltipProvider><Tooltip><TooltipTrigger asChild>
                        <Button variant="ghost" size="icon" onClick={() => setShowSystemInfo(!showSystemInfo)} className="h-6 w-6 hover:bg-gray-100">
                            <Settings2 className={`w-4 h-4 transition-transform ${showSystemInfo ? 'rotate-90' : ''}`} />
                        </Button>
                    </TooltipTrigger><TooltipContent><p>System Information</p></TooltipContent></Tooltip></TooltipProvider>
                </div>
            </div>

            {/* Audio Player, Summary, Transcription, Live Stream */}
            <div className="bg-muted/20">
                <PulseCallAudioPlayer call={call} />
            </div>

            {/* System Info */}
            {showSystemInfo && (
                <div className="p-4 pt-0 space-y-2 text-sm bg-muted/30">
                    <div className="flex items-center gap-2"><Clock className="w-4 h-4 text-gray-400" /><span className="text-gray-600">Duration:</span><span className="font-mono text-gray-900">{formatDuration(call.totalDuration || call.duration)}</span></div>
                    {call.talkTime !== undefined && <div className="flex items-center gap-2"><Timer className="w-4 h-4 text-gray-400" /><span className="text-gray-600">Talk:</span><span className="font-mono text-gray-900">{formatDuration(call.talkTime)}</span></div>}
                    {call.waitTime !== undefined && <div className="flex items-center gap-2"><Clock className="w-4 h-4 text-gray-400" /><span className="text-gray-600">Wait:</span><span className="font-mono text-gray-900">{formatDuration(call.waitTime)}</span></div>}
                    {call.cost !== undefined && <div className="flex items-center gap-2"><DollarSign className="w-4 h-4 text-gray-400" /><span className="text-gray-600">Cost:</span><span className="font-mono text-gray-900">${call.cost.toFixed(4)} USD</span></div>}
                    <div className="flex items-center gap-2"><Hash className="w-4 h-4 text-gray-400" /><span className="text-gray-600">Call SID:</span><code className="text-xs bg-gray-200 px-2 py-1 rounded font-mono text-gray-800">{call.callSid}</code></div>
                    <div className="flex items-center gap-2"><Clock className="w-4 h-4 text-gray-400" /><span className="text-gray-600">Queue Time:</span><span className="font-mono text-gray-900">{call.queueTime}s</span></div>
                    <div className="flex items-center gap-2"><Navigation className="w-4 h-4 text-gray-400" /><span className="text-gray-600">Twilio Direction:</span><span className="font-mono text-gray-900">{call.twilioDirection}</span></div>
                </div>
            )}
        </Card>
    );
}
