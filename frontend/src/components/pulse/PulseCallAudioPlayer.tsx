/**
 * PulseCallAudioPlayer — audio player, summary, transcription,
 * and live transcript for PulseCallListItem.
 */
import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { authedFetch } from '@/services/apiClient';
import { useLiveTranscript } from '@/hooks/useLiveTranscript';
import { Play, Pause, RotateCcw, RotateCw, Copy, Check } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { CallData, Entity, GeminiEntity } from '../call-list-item';

const fmtAudio = (s: number) => { if (!isFinite(s) || isNaN(s)) return '0:00'; return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`; };
const getSentiment = (score: number | null) => { if (score === null) return null; if (score <= -0.4) return { emoji: '😡', color: '#dc2626', label: 'Very Negative' }; if (score <= -0.1) return { emoji: '😟', color: '#f59e0b', label: 'Negative' }; if (score <= 0.1) return { emoji: '😐', color: '#eab308', label: 'Neutral' }; if (score <= 0.4) return { emoji: '😊', color: '#22c55e', label: 'Positive' }; return { emoji: '😄', color: '#3b82f6', label: 'Very Positive' }; };

export function PulseCallAudioPlayer({ call }: { call: CallData }) {
    const { token } = useAuth();
    const liveLines = useLiveTranscript(call.callSid || '');
    const isLiveStreaming = liveLines.length > 0 && !call.audioUrl;

    const [activeSection, setActiveSection] = useState<'summary' | 'transcription' | null>(() => call.status === 'completed' && call.summary ? 'summary' : null);
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

    useEffect(() => { const a = audioRef.current; if (!a) return; const u = () => setCurrentTime(a.currentTime); const d = () => { if (isFinite(a.duration)) setDuration(a.duration); }; const e = () => setIsPlaying(false); a.addEventListener('timeupdate', u); a.addEventListener('loadedmetadata', d); a.addEventListener('durationchange', d); a.addEventListener('ended', e); return () => { a.removeEventListener('timeupdate', u); a.removeEventListener('loadedmetadata', d); a.removeEventListener('durationchange', d); a.removeEventListener('ended', e); }; }, []);

    // Auto-open transcription for live stream
    useEffect(() => { if (liveLines.length > 0 && activeSection !== 'transcription') setActiveSection('transcription'); }, [liveLines.length > 0]);

    const mediaLoadedRef = useRef(false);
    useEffect(() => { if (mediaLoadedRef.current || !call.callSid || !call.audioUrl) return; mediaLoadedRef.current = true; (async () => { try { const res = await authedFetch(`/api/calls/${call.callSid}/media`); if (!res.ok) return; const data = await res.json(); const t = data.transcript; if (t) { if (!transcriptionText && t.text) setTranscriptionText(t.text); if (entities.length === 0 && t.entities?.length) setEntities(t.entities); if (sentimentScore === null && t.sentimentScore != null) setSentimentScore(t.sentimentScore); if (t.gemini_summary) { setGeminiSummary(t.gemini_summary); setGeminiEntities(t.gemini_entities || []); setGeminiStatus('ready'); geminiLoadedRef.current = true; setActiveSection(prev => prev ?? 'summary'); } } } catch { /* ignore */ } })(); }, [call.callSid]);

    useEffect(() => { if (activeSection !== 'summary' || geminiLoadedRef.current || !call.callSid) return; geminiLoadedRef.current = true; setGeminiStatus('loading'); (async () => { try { const res = await authedFetch(`/api/calls/${call.callSid}/media`); if (!res.ok) throw new Error(); const data = await res.json(); const t = data.transcript; if (t) { if (!transcriptionText && t.text) setTranscriptionText(t.text); if (entities.length === 0 && t.entities?.length) setEntities(t.entities); if (sentimentScore === null && t.sentimentScore != null) setSentimentScore(t.sentimentScore); if (t.gemini_summary) { setGeminiSummary(t.gemini_summary); setGeminiEntities(t.gemini_entities || []); setGeminiStatus('ready'); } else setGeminiStatus('idle'); } else setGeminiStatus('idle'); } catch { setGeminiStatus('error'); } })(); }, [activeSection, call.callSid]);

    const handlePlayPause = () => { if (!audioRef.current) return; if (isPlaying) audioRef.current.pause(); else audioRef.current.play(); setIsPlaying(!isPlaying); };
    const handleSkip = (s: number) => { if (!audioRef.current) return; audioRef.current.currentTime = Math.max(0, Math.min(audioRef.current.currentTime + s, duration)); };

    const handleResetTranscription = async () => { setIsTranscribing(true); setTranscribeError(null); try { await authedFetch(`/api/calls/${call.callSid}/transcript`, { method: 'DELETE' }); setTranscriptionText(null); setEntities([]); setSentimentScore(null); setGeminiSummary(null); setGeminiEntities([]); setGeminiStatus('idle'); setActiveGeminiIdx(null); geminiLoadedRef.current = false; mediaLoadedRef.current = false; const res = await authedFetch(`/api/calls/${call.callSid}/transcribe`, { method: 'POST' }); const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Failed'); setTranscriptionText(data.transcript); if (data.entities) setEntities(data.entities); if (data.gemini_summary) { setGeminiSummary(data.gemini_summary); setGeminiEntities(data.gemini_entities || []); setGeminiStatus('ready'); } if (data.sentimentScore != null) setSentimentScore(data.sentimentScore); } catch (err: any) { setTranscribeError(err.message); } finally { setIsTranscribing(false); } };
    const handleGenerateTranscription = async () => { setIsTranscribing(true); setTranscribeError(null); try { const res = await authedFetch(`/api/calls/${call.callSid}/transcribe`, { method: 'POST' }); const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Failed'); setTranscriptionText(data.transcript); if (data.entities) setEntities(data.entities); if (data.gemini_summary) { setGeminiSummary(data.gemini_summary); setGeminiEntities(data.gemini_entities || []); setGeminiStatus('ready'); } if (data.sentimentScore != null) setSentimentScore(data.sentimentScore); } catch (err: any) { setTranscribeError(err.message); } finally { setIsTranscribing(false); } };

    // Live transcription panel (no audio URL)
    if (!call.audioUrl && isLiveStreaming) {
        return (
            <div className="px-4 pb-4">
                <div className="space-y-3">
                    <div className="flex items-center gap-2"><span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" /><span className="text-xs text-red-500 font-medium">Live transcription</span></div>
                    <ScrollArea className="h-48 p-3 rounded-md bg-muted/30">
                        <div className="space-y-1">
                            {liveLines.map((line, idx) => (
                                <div key={idx} className="flex items-baseline gap-2 px-2 py-1 text-xs">
                                    <span className={`shrink-0 text-[10px] font-semibold ${line.speaker === 'agent' ? 'text-blue-500' : 'text-green-600'}`}>{line.speaker === 'agent' ? 'Agent' : 'Customer'}:</span>
                                    <span className="flex-1 text-sm text-gray-700 leading-relaxed">{line.text}{!line.isFinal && <span className="ml-1 text-gray-300 animate-pulse">▋</span>}</span>
                                </div>
                            ))}
                        </div>
                    </ScrollArea>
                </div>
            </div>
        );
    }
    if (!call.audioUrl) return null;

    return (
        <div className="px-4 pb-4">
            <audio ref={audioRef} src={token ? `${call.audioUrl}?token=${encodeURIComponent(token)}` : call.audioUrl} preload="metadata" />
            <div className="space-y-3">
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-3 shrink-0">
                        {(() => { const sd = getSentiment(sentimentScore); if (!sd) return null; return <span title={`${sd.label} (${sentimentScore})`} className="text-base leading-none cursor-default" style={{ filter: `drop-shadow(0 0 2px ${sd.color})` }}>{sd.emoji}</span>; })()}
                        <button onClick={() => setActiveSection(activeSection === 'summary' ? null : 'summary')} className={`text-xs transition-colors ${activeSection === 'summary' ? 'text-gray-700 border-b-2 border-gray-700' : 'text-gray-500 border-b border-dashed border-gray-400 hover:text-gray-700'}`}>Summary</button>
                        <button onClick={() => setActiveSection(activeSection === 'transcription' ? null : 'transcription')} className={`text-xs transition-colors ${activeSection === 'transcription' ? 'text-gray-700 border-b-2 border-gray-700' : 'text-gray-500 border-b border-dashed border-gray-400 hover:text-gray-700'}`}>Transcription{isLiveStreaming && <span className="ml-1 inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />}</button>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        <button onClick={() => handleSkip(-10)} title="Rewind 10s" className="h-7 w-7 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors relative"><RotateCcw className="w-3.5 h-3.5" /><span className="absolute text-[9px] font-semibold">10</span></button>
                        <button onClick={handlePlayPause} className="h-7 w-7 flex items-center justify-center text-gray-500 hover:text-gray-700 transition-colors">{isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}</button>
                        <button onClick={() => handleSkip(10)} title="Forward 10s" className="h-7 w-7 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors relative"><RotateCw className="w-3.5 h-3.5" /><span className="absolute text-[9px] font-semibold">10</span></button>
                    </div>
                    <div className="flex items-center"><span className="text-xs text-gray-500 font-mono">{fmtAudio(currentTime)} / {fmtAudio(duration)}</span></div>
                </div>

                {activeSection === 'summary' && (
                    <div className="pt-2 space-y-3">
                        <div>
                            <div className="flex items-center gap-1.5 mb-1">
                                <h4 className="text-xs font-semibold text-gray-800 uppercase tracking-wide">Call Summary</h4>
                                {(geminiSummary || call.summary) && <button onClick={() => { navigator.clipboard.writeText(geminiSummary || call.summary || ''); setCopiedSummary(true); setTimeout(() => setCopiedSummary(false), 1500); }} className="p-0.5 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-700 transition-colors" title="Copy summary">{copiedSummary ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}</button>}
                            </div>
                            {geminiStatus === 'loading' ? <div className="flex items-center gap-2 bg-muted/30 p-3 rounded-md"><div className="w-3 h-3 border-2 border-gray-600 border-t-transparent rounded-full animate-spin" /><span className="text-sm text-gray-400 animate-pulse">Generating summary…</span></div>
                                : geminiStatus === 'error' ? <p className="text-sm text-red-500 italic bg-red-50 p-3 rounded-md">Summary unavailable</p>
                                    : geminiSummary ? <p className="text-sm text-gray-700 leading-relaxed bg-muted/30 p-3 rounded-md">{geminiSummary}</p>
                                        : call.summary ? <p className="text-sm text-gray-700 leading-relaxed">{call.summary}</p>
                                            : isTranscribing ? <p className="text-sm text-gray-400 italic bg-muted/30 p-3 rounded-md">Not ready (waiting for transcript)</p>
                                                : <p className="text-sm text-gray-400 italic">No summary available</p>}
                        </div>
                        <div>
                            <div className="flex items-center justify-between mb-1"><h4 className="text-xs font-semibold text-gray-800 uppercase tracking-wide">Key Entities</h4>{geminiEntities.length > 0 && <span className="text-[10px] text-gray-400">{geminiEntities.length} found</span>}</div>
                            {geminiStatus === 'loading' ? <div className="flex items-center gap-2 bg-muted/30 p-3 rounded-md"><div className="w-3 h-3 border-2 border-gray-600 border-t-transparent rounded-full animate-spin" /><span className="text-sm text-gray-400 animate-pulse">Extracting entities…</span></div>
                                : geminiStatus === 'error' ? <p className="text-sm text-red-500 italic bg-red-50 p-3 rounded-md">Entities unavailable</p>
                                    : geminiEntities.length > 0 ? (
                                        <div className="bg-muted/30 p-3 rounded-md space-y-1">
                                            {geminiEntities.map((ge, idx) => {
                                                const hasTs = ge.start_ms != null; const sec = hasTs ? ge.start_ms! / 1000 : 0; const active = activeGeminiIdx === idx; const inRange = hasTs && currentTime >= sec && currentTime <= sec + 10; return (
                                                    <div key={`ge-${ge.label}-${idx}`} onClick={() => { if (!hasTs) return; if (audioRef.current) { audioRef.current.currentTime = sec; setCurrentTime(sec); setActiveGeminiIdx(idx); if (!isPlaying) { audioRef.current.play(); setIsPlaying(true); } } }} className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left text-xs transition-colors group ${hasTs ? 'cursor-pointer' : 'cursor-default opacity-80'} ${(active || inRange) ? 'bg-blue-50 ring-1 ring-blue-200' : hasTs ? 'hover:bg-gray-100' : ''}`} title={hasTs ? `Jump to ${fmtAudio(sec)}` : 'No timestamp'}>
                                                        <span className="shrink-0 text-[11px] font-medium text-gray-500" style={{ minWidth: '140px' }}>{ge.label}</span>
                                                        <span className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                                            <button onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(ge.value); setCopiedEntityIdx(idx); setTimeout(() => setCopiedEntityIdx(null), 1500); }} className="p-0.5 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-700 transition-colors" title="Copy value">{copiedEntityIdx === idx ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}</button>
                                                            {hasTs && <button onClick={(e) => { e.stopPropagation(); if (audioRef.current) { audioRef.current.currentTime = sec; setCurrentTime(sec); setActiveGeminiIdx(idx); audioRef.current.play(); setIsPlaying(true); } }} className="p-0.5 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-700 transition-colors" title={`Play from ${fmtAudio(sec)}`}><Play className="w-3 h-3" /></button>}
                                                        </span>
                                                        <span className="shrink-0 text-gray-400">→</span>
                                                        <span className="flex-1 font-medium text-gray-800" style={{ wordBreak: 'break-word' }}>{ge.value}</span>
                                                        {hasTs && <span className="shrink-0 text-[10px] text-gray-400 font-mono">{fmtAudio(sec)}</span>}
                                                    </div>);
                                            })}
                                        </div>
                                    ) : (transcriptionText || call.transcription) && geminiStatus !== 'idle' ? <p className="text-xs text-gray-400 italic bg-muted/30 p-3 rounded-md">No key entities detected.</p> : isTranscribing ? <p className="text-xs text-gray-400 italic bg-muted/30 p-3 rounded-md">Will appear after transcription completes.</p> : null}
                        </div>
                    </div>
                )}

                {activeSection === 'transcription' && (
                    <div className="pt-2">
                        <ScrollArea className="h-48 p-3 rounded-md bg-muted/30">
                            {isTranscribing ? <div className="flex items-center gap-2"><div className="w-4 h-4 border-2 border-gray-600 border-t-transparent rounded-full animate-spin" /><p className="text-sm text-gray-400 animate-pulse">Generating transcription...</p></div>
                                : isLiveStreaming ? (
                                    <div>
                                        <div className="flex items-center gap-2 mb-2"><span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" /><span className="text-xs text-red-500 font-medium">Live transcription</span></div>
                                        <div className="space-y-1">{liveLines.map((line, idx) => (<div key={idx} className="flex items-baseline gap-2 px-2 py-1 text-xs"><span className={`shrink-0 text-[10px] font-semibold ${line.speaker === 'agent' ? 'text-blue-500' : 'text-green-600'}`}>{line.speaker === 'agent' ? 'Agent' : 'Customer'}:</span><span className="flex-1 text-sm text-gray-700 leading-relaxed">{line.text}{!line.isFinal && <span className="ml-1 text-gray-300 animate-pulse">▋</span>}</span></div>))}</div>
                                    </div>
                                ) : (transcriptionText || call.transcription) ? (
                                    <div>
                                        <div className="space-y-0.5">{(transcriptionText || call.transcription || '').split('\n').filter((l: string) => l.trim()).map((line: string, idx: number) => { const m = line.match(/^\[(\d+)ms\]\s*/); const ms = m ? parseInt(m[1], 10) : null; const clean = m ? line.slice(m[0].length) : line; const sec = ms != null ? ms / 1000 : null; return (<button key={idx} onClick={() => { if (audioRef.current && sec != null) { audioRef.current.currentTime = sec; setCurrentTime(sec); if (!isPlaying) { audioRef.current.play(); setIsPlaying(true); } } }} className={`w-full flex items-baseline gap-2 px-2 py-1.5 rounded text-left text-xs transition-colors ${sec != null ? 'cursor-pointer hover:bg-gray-100' : 'cursor-default'}`}>{sec != null && <span className="shrink-0 text-[10px] text-gray-400 font-mono tabular-nums">{fmtAudio(sec)}</span>}<span className="flex-1 text-sm text-gray-700 leading-relaxed">{clean}</span></button>); })}</div>
                                        {call.callSid && <button onClick={handleResetTranscription} className="mt-2 text-[11px] px-2 py-1 text-gray-400 border border-gray-300 rounded hover:bg-gray-100 transition-colors cursor-pointer">↻ Reset transcription</button>}
                                    </div>
                                ) : (
                                    <div>
                                        <p className="text-sm text-gray-400 italic">No transcription available</p>
                                        {transcribeError && <p className="text-sm text-red-500 mt-1">{transcribeError}</p>}
                                        {call.callSid && <button onClick={handleGenerateTranscription} className="mt-2 text-xs px-3 py-1.5 bg-gray-800 text-white rounded-md hover:bg-gray-700 transition-colors cursor-pointer">Generate</button>}
                                    </div>
                                )}
                        </ScrollArea>
                    </div>
                )}
            </div>
        </div>
    );
}
