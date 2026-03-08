import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { authedFetch } from '@/services/apiClient';
import { Play, Pause, RotateCcw, RotateCw, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { CallData, Entity, GeminiEntity } from './callTypes';
import { formatAudioTime, getSentimentDisplay } from './callTypes';
import { resetTranscription, generateTranscription } from './callAudioHelpers';

interface CallAudioPlayerProps { call: CallData; }

export function CallAudioPlayer({ call }: CallAudioPlayerProps) {
    const { token } = useAuth();
    const [activeSection, setActiveSection] = useState<'summary' | 'transcription' | null>(() => call.summary ? 'summary' : null);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [transcriptionText, setTranscriptionText] = useState<string | null>(null);
    const [transcribeError, setTranscribeError] = useState<string | null>(null);
    const [entities, setEntities] = useState<Entity[]>([]);
    const [sentimentScore, setSentimentScore] = useState<number | null>(null);
    const [geminiSummary, setGeminiSummary] = useState<string | null>(null);
    const [geminiEntities, setGeminiEntities] = useState<GeminiEntity[]>([]);
    const [geminiStatus, setGeminiStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [activeGeminiIdx, setActiveGeminiIdx] = useState<number | null>(null);
    const [copiedEntityIdx, setCopiedEntityIdx] = useState<number | null>(null);
    const [copiedSummary, setCopiedSummary] = useState(false);
    const geminiLoadedRef = useRef(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(call.recordingDuration || call.totalDuration || call.duration || 0);
    const audioRef = useRef<HTMLAudioElement>(null);
    const mediaLoadedRef = useRef(false);

    const txState = { setTranscriptionText, setEntities, setSentimentScore, setGeminiSummary, setGeminiEntities, setGeminiStatus, setIsTranscribing, setTranscribeError, setActiveGeminiIdx, geminiLoadedRef, mediaLoadedRef };

    const handlePlayPause = () => { if (audioRef.current) { if (isPlaying) audioRef.current.pause(); else audioRef.current.play(); setIsPlaying(!isPlaying); } };
    const handleSkip = (seconds: number) => { if (audioRef.current) audioRef.current.currentTime = Math.max(0, Math.min(audioRef.current.currentTime + seconds, duration)); };
    const handleSliderChange = (value: number[]) => { if (audioRef.current) { audioRef.current.currentTime = value[0]; setCurrentTime(value[0]); } };

    useEffect(() => { const audio = audioRef.current; if (!audio) return; const updateTime = () => setCurrentTime(audio.currentTime); const updateDuration = () => { if (isFinite(audio.duration)) setDuration(audio.duration); }; const handleEnded = () => setIsPlaying(false); audio.addEventListener('timeupdate', updateTime); audio.addEventListener('loadedmetadata', updateDuration); audio.addEventListener('durationchange', updateDuration); audio.addEventListener('ended', handleEnded); return () => { audio.removeEventListener('timeupdate', updateTime); audio.removeEventListener('loadedmetadata', updateDuration); audio.removeEventListener('durationchange', updateDuration); audio.removeEventListener('ended', handleEnded); }; }, []);

    useEffect(() => {
        if (mediaLoadedRef.current || !call.callSid || !call.audioUrl) return;
        mediaLoadedRef.current = true;
        (async () => { try { const res = await authedFetch(`/api/calls/${call.callSid}/media`); if (!res.ok) return; const data = await res.json(); const t = data.transcript; if (t) { if (!transcriptionText && t.text) setTranscriptionText(t.text); if (entities.length === 0 && t.entities?.length) setEntities(t.entities); if (sentimentScore === null && t.sentimentScore != null) setSentimentScore(t.sentimentScore); if (t.gemini_summary) { setGeminiSummary(t.gemini_summary); setGeminiEntities(t.gemini_entities || []); setGeminiStatus('ready'); geminiLoadedRef.current = true; setActiveSection(prev => prev ?? 'summary'); } } } catch { } })();
    }, [call.callSid]);

    useEffect(() => {
        if (activeSection !== 'summary' || geminiLoadedRef.current || !call.callSid) return;
        geminiLoadedRef.current = true; setGeminiStatus('loading');
        (async () => { try { const res = await authedFetch(`/api/calls/${call.callSid}/media`); if (!res.ok) throw new Error('Failed'); const data = await res.json(); const t = data.transcript; if (t) { if (!transcriptionText && t.text) setTranscriptionText(t.text); if (entities.length === 0 && t.entities?.length) setEntities(t.entities); if (sentimentScore === null && t.sentimentScore != null) setSentimentScore(t.sentimentScore); if (t.gemini_summary) { setGeminiSummary(t.gemini_summary); setGeminiEntities(t.gemini_entities || []); setGeminiStatus('ready'); } else setGeminiStatus('idle'); } else setGeminiStatus('idle'); } catch { setGeminiStatus('error'); } })();
    }, [activeSection, call.callSid]);

    return (
        <div className="px-4 pb-4">
            <audio ref={audioRef} src={token ? `${call.audioUrl}?token=${encodeURIComponent(token)}` : call.audioUrl} preload="metadata" />
            <div className="space-y-3">
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-3 shrink-0">
                        {(() => { const sd = getSentimentDisplay(sentimentScore); if (!sd) return null; return <span title={`${sd.label} (${sentimentScore})`} className="text-base leading-none cursor-default" style={{ filter: `drop-shadow(0 0 2px ${sd.color})` }}>{sd.emoji}</span>; })()}
                        <button onClick={() => setActiveSection(activeSection === 'summary' ? null : 'summary')} className={cn('text-xs bg-transparent border-0 border-b pb-px cursor-pointer outline-none transition-colors', activeSection === 'summary' ? 'text-foreground border-b-2 border-foreground' : 'text-muted-foreground border-dashed border-muted-foreground hover:text-foreground')}>Summary</button>
                        <button onClick={() => setActiveSection(activeSection === 'transcription' ? null : 'transcription')} className={cn('text-xs bg-transparent border-0 border-b pb-px cursor-pointer outline-none transition-colors', activeSection === 'transcription' ? 'text-foreground border-b-2 border-foreground' : 'text-muted-foreground border-dashed border-muted-foreground hover:text-foreground')}>Transcription</button>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0"><Button variant="ghost" size="icon" className="size-8 relative" onClick={() => handleSkip(-10)} title="Rewind 10 seconds"><RotateCcw className="size-5 text-muted-foreground" /><span className="absolute text-[7px] font-bold text-muted-foreground leading-none">10</span></Button><Button variant="ghost" size="icon" className="size-8" onClick={handlePlayPause}>{isPlaying ? <Pause className="size-5 text-muted-foreground" /> : <Play className="size-5 text-muted-foreground" />}</Button><Button variant="ghost" size="icon" className="size-8 relative" onClick={() => handleSkip(10)} title="Forward 10 seconds"><RotateCw className="size-5 text-muted-foreground" /><span className="absolute text-[7px] font-bold text-muted-foreground leading-none">10</span></Button></div>
                    <div className="flex-1 flex items-center gap-2"><span className="text-xs text-muted-foreground shrink-0 w-10 text-right">{formatAudioTime(currentTime)}</span><Slider value={[currentTime]} max={duration || 100} step={1} onValueChange={handleSliderChange} className="flex-1" /><span className="text-xs text-muted-foreground shrink-0 w-10">{formatAudioTime(duration)}</span></div>
                </div>
                {activeSection === 'summary' && (
                    <div className="pt-2 space-y-3">
                        <div><div className="flex items-center gap-1.5 mb-1"><h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">Call Summary</h4>{(geminiSummary || call.summary) && <button onClick={() => { navigator.clipboard.writeText(geminiSummary || call.summary || ''); setCopiedSummary(true); setTimeout(() => setCopiedSummary(false), 1500); }} className="p-0.5 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors" title="Copy summary">{copiedSummary ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}</button>}</div>{geminiStatus === 'loading' ? <div className="flex items-center gap-2 bg-muted/30 p-3 rounded-md"><div className="size-3 border-2 border-primary border-t-transparent rounded-full animate-spin" /><span className="text-sm text-muted-foreground animate-pulse">Generating summary…</span></div> : geminiStatus === 'error' ? <p className="text-sm text-destructive italic bg-destructive/5 p-3 rounded-md">Summary unavailable</p> : geminiSummary ? <p className="text-sm leading-relaxed bg-muted/50 p-3 rounded-md">{geminiSummary}</p> : call.summary ? <p className="text-sm leading-relaxed bg-muted/50 p-3 rounded-md">{call.summary}</p> : isTranscribing ? <p className="text-sm text-muted-foreground italic bg-muted/30 p-3 rounded-md">Not ready (waiting for transcript)</p> : <p className="text-sm text-muted-foreground italic bg-muted/30 p-3 rounded-md">No summary available</p>}</div>
                        <div><div className="flex items-center justify-between mb-1"><h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">Key Entities</h4>{geminiEntities.length > 0 && <span className="text-[10px] text-muted-foreground">{geminiEntities.length} found</span>}</div>{geminiStatus === 'loading' ? <div className="flex items-center gap-2 bg-muted/30 p-3 rounded-md"><div className="size-3 border-2 border-primary border-t-transparent rounded-full animate-spin" /><span className="text-sm text-muted-foreground animate-pulse">Extracting entities…</span></div> : geminiStatus === 'error' ? <p className="text-sm text-destructive italic bg-destructive/5 p-3 rounded-md">Entities unavailable</p> : geminiEntities.length > 0 ? <div className="bg-muted/30 p-3 rounded-md space-y-1">{geminiEntities.map((ge, idx) => { const hasTs = ge.start_ms != null; const startSec = hasTs ? ge.start_ms! / 1000 : 0; const isActive = activeGeminiIdx === idx; const isInRange = hasTs && currentTime >= startSec && currentTime <= startSec + 10; return <div key={`gemini-${ge.label}-${idx}`} onClick={() => { if (!hasTs) return; if (audioRef.current) { audioRef.current.currentTime = startSec; setCurrentTime(startSec); setActiveGeminiIdx(idx); if (!isPlaying) { audioRef.current.play(); setIsPlaying(true); } } }} className={cn('w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left text-xs transition-colors group', hasTs ? 'cursor-pointer' : 'cursor-default opacity-80', (isActive || isInRange) ? 'bg-primary/10 ring-1 ring-primary/30' : hasTs ? 'hover:bg-muted/60' : '')} title={hasTs ? `Jump to ${formatAudioTime(startSec)}` : 'No timestamp'}><span className="shrink-0 text-[11px] font-medium text-muted-foreground" style={{ minWidth: '140px' }}>{ge.label}</span><span className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"><button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(ge.value); setCopiedEntityIdx(idx); setTimeout(() => setCopiedEntityIdx(null), 1500); }} className="p-0.5 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors" title="Copy value">{copiedEntityIdx === idx ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}</button>{hasTs && <button onClick={e => { e.stopPropagation(); if (audioRef.current) { audioRef.current.currentTime = startSec; setCurrentTime(startSec); setActiveGeminiIdx(idx); audioRef.current.play(); setIsPlaying(true); } }} className="p-0.5 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors" title={`Play from ${formatAudioTime(startSec)}`}><Play className="size-3" /></button>}</span><span className="shrink-0 text-muted-foreground">→</span><span className="flex-1 font-medium text-foreground" style={{ wordBreak: 'break-word' }}>{ge.value}</span>{hasTs && <span className="shrink-0 text-[10px] text-muted-foreground font-mono">{formatAudioTime(startSec)}</span>}</div>; })}</div> : (transcriptionText || call.transcription) && geminiStatus !== 'idle' ? <p className="text-xs text-muted-foreground italic bg-muted/30 p-3 rounded-md">No key entities detected for this call.</p> : isTranscribing ? <p className="text-xs text-muted-foreground italic bg-muted/30 p-3 rounded-md">Will appear after transcription completes.</p> : null}</div>
                    </div>
                )}
                {activeSection === 'transcription' && (
                    <div className="pt-2"><ScrollArea className="h-48 bg-muted/30 p-3 rounded-md">
                        {isTranscribing ? <div className="flex items-center gap-2"><div className="size-4 border-2 border-primary border-t-transparent rounded-full animate-spin" /><p className="text-sm text-muted-foreground animate-pulse">Generating transcription...</p></div>
                            : (transcriptionText || call.transcription) ? <div><div className="space-y-0.5">{(transcriptionText || call.transcription || '').split('\n').filter((l: string) => l.trim()).map((line: string, idx: number) => { const match = line.match(/^\[(\d+)ms\]\s*/); const startMs = match ? parseInt(match[1], 10) : null; const cleanLine = match ? line.slice(match[0].length) : line; const startSec = startMs != null ? startMs / 1000 : null; return <button key={idx} onClick={() => { if (audioRef.current && startSec != null) { audioRef.current.currentTime = startSec; setCurrentTime(startSec); if (!isPlaying) { audioRef.current.play(); setIsPlaying(true); } } }} className={cn('w-full flex items-baseline gap-2 px-2 py-1.5 rounded text-left text-xs transition-colors', startSec != null ? 'cursor-pointer hover:bg-muted/60' : 'cursor-default')}>{startSec != null && <span className="shrink-0 text-[10px] text-muted-foreground font-mono tabular-nums">{formatAudioTime(startSec)}</span>}<span className="flex-1 text-sm leading-relaxed">{cleanLine}</span></button>; })}</div>{call.callSid && <button onClick={() => resetTranscription(call.callSid, txState)} className="mt-2 text-[11px] px-2 py-1 text-muted-foreground border border-muted-foreground/30 rounded hover:bg-muted/50 transition-colors cursor-pointer">↻ Reset transcription</button>}</div>
                                : <div><p className="text-sm text-muted-foreground italic">No transcription available</p>{transcribeError && <p className="text-sm text-destructive mt-1">{transcribeError}</p>}{call.callSid && <button onClick={() => generateTranscription(call.callSid, txState)} className="mt-2 text-xs px-3 py-1.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors cursor-pointer">Generate</button>}</div>}
                    </ScrollArea></div>
                )}
            </div>
        </div>
    );
}
