import { useState } from 'react';
import { PhoneIncoming, PhoneOutgoing, Settings2, Clock, DollarSign, Hash, GitBranch, Navigation, Timer } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPhoneDisplay as formatPhoneNumber } from '@/utils/phoneUtils';
import { cn } from '@/lib/utils';
import { CallAudioPlayer } from './CallAudioPlayer';
import { STATUS_CONFIG, formatDuration, formatCallTime } from './callTypes';
import type { CallData } from './callTypes';

// Re-export types so existing imports still work
export type { CallData, Entity, GeminiEntity } from './callTypes';

interface CallListItemProps {
    call: CallData;
}

export function CallListItem({ call }: CallListItemProps) {
    const [showSystemInfo, setShowSystemInfo] = useState(false);
    const otherPartyNumber = call.direction === 'incoming' ? call.from : call.to;
    const directionLabel = call.direction === 'incoming' ? 'Incoming Call' : 'Outgoing Call';
    const statusCfg = STATUS_CONFIG[call.status] || STATUS_CONFIG['completed'];

    return (
        <Card className="overflow-hidden border hover:border-primary/40 transition-colors">
            {/* Main Call Info */}
            <div className="p-4 pb-2">
                <div className="flex items-center gap-3">
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div className="flex items-center gap-1.5 shrink-0">
                                    <div className="flex items-center justify-center size-7 rounded-full" style={{ backgroundColor: statusCfg.iconBg }}>
                                        {call.direction === 'incoming' ? <PhoneIncoming className="size-4" style={{ color: statusCfg.iconColor }} /> : <PhoneOutgoing className="size-4" style={{ color: statusCfg.iconColor }} />}
                                    </div>
                                    <span className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: statusCfg.badgeBg, color: statusCfg.badgeText }}>{statusCfg.label}</span>
                                </div>
                            </TooltipTrigger>
                            <TooltipContent><p>{directionLabel}</p></TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
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
                            <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">{formatCallTime(call.startTime)}</span>
                                <TooltipProvider>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button variant="ghost" size="icon" onClick={() => setShowSystemInfo(!showSystemInfo)} className="size-6">
                                                <Settings2 className={cn('size-4 transition-transform', showSystemInfo && 'rotate-90')} />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent><p>System Information</p></TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div>
                {/* Audio Player with Summary/Transcription */}
                {call.audioUrl && <CallAudioPlayer call={call} />}

                {/* No Audio — show summary/transcription inline */}
                {!call.audioUrl && (
                    <>
                        {call.summary && (
                            <div className="px-4 pb-4 border-t">
                                <h4 className="font-medium text-sm mt-3 mb-2">Summary</h4>
                                <p className="text-sm leading-relaxed bg-muted/50 p-3 rounded-md">{call.summary}</p>
                            </div>
                        )}
                        {call.transcription && (
                            <div className="px-4 pb-4 border-t">
                                <h4 className="font-medium text-sm mt-3 mb-2">Transcription</h4>
                                <ScrollArea className="h-48 bg-muted/30 p-3 rounded-md">
                                    <p className="text-sm leading-relaxed whitespace-pre-wrap">{call.transcription}</p>
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
                            <div className="flex items-center gap-2"><Clock className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Duration:</span><span className="font-mono">{formatDuration(call.totalDuration || call.duration)}</span></div>
                            {call.talkTime !== undefined && <div className="flex items-center gap-2"><Timer className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Talk:</span><span className="font-mono">{formatDuration(call.talkTime)}</span></div>}
                            {call.waitTime !== undefined && <div className="flex items-center gap-2"><Clock className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Wait:</span><span className="font-mono">{formatDuration(call.waitTime)}</span></div>}
                            {call.cost !== undefined && <div className="flex items-center gap-2"><DollarSign className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Cost:</span><span className="font-mono">${call.cost.toFixed(4)} USD</span></div>}
                            <div className="flex items-center gap-2"><Hash className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Call SID:</span><code className="text-xs bg-muted px-2 py-1 rounded font-mono">{call.callSid}</code></div>
                            <div className="flex items-center gap-2"><Clock className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Queue Time:</span><span className="font-mono">{call.queueTime}s</span></div>
                            {call.parentCall && <div className="flex items-center gap-2"><GitBranch className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Parent Call:</span><code className="text-xs bg-muted px-2 py-1 rounded font-mono">{call.parentCall}</code></div>}
                            <div className="flex items-center gap-2"><Navigation className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Twilio Direction:</span><span className="font-mono">{call.twilioDirection}</span></div>
                        </div>
                    </>
                )}
            </div>
        </Card>
    );
}
