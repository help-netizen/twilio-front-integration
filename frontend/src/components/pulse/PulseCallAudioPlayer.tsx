/**
 * PulseCallAudioPlayer — audio player, summary, transcription,
 * and live transcript for PulseCallListItem.
 *
 * Blanc design: warm tokens, no gray-* Tailwind colors,
 * no decorative backgrounds on summary/entities.
 */
import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { authedFetch } from '@/services/apiClient';
import { useLiveTranscript } from '@/hooks/useLiveTranscript';
import { Play, Pause, RotateCcw, RotateCw, Copy, Check } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { CallData, Entity, GeminiEntity } from '../call-list-item';

const fmtAudio = (s: number) => {
    if (!isFinite(s) || isNaN(s)) return '0:00';
    return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
};

const getSentiment = (score: number | null) => {
    if (score === null) return null;
    if (score <= -0.4) return { emoji: '😡', color: '#dc2626', label: 'Very Negative' };
    if (score <= -0.1) return { emoji: '😟', color: '#f59e0b', label: 'Negative' };
    if (score <= 0.1)  return { emoji: '😐', color: '#eab308', label: 'Neutral' };
    if (score <= 0.4)  return { emoji: '😊', color: '#22c55e', label: 'Positive' };
    return { emoji: '😄', color: '#3b82f6', label: 'Very Positive' };
};

export function PulseCallAudioPlayer({ call }: { call: CallData }) {
    const { token } = useAuth();
    const liveLines = useLiveTranscript(call.callSid || '');
    const isLiveStreaming = liveLines.length > 0 && !call.audioUrl;

    const [activeSection, setActiveSection] = useState<'summary' | 'transcription' | null>(
        () => call.status === 'completed' && call.summary ? 'summary' : null
    );
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

    useEffect(() => {
        const a = audioRef.current; if (!a) return;
        const u = () => setCurrentTime(a.currentTime);
        const d = () => { if (isFinite(a.duration)) setDuration(a.duration); };
        const e = () => setIsPlaying(false);
        a.addEventListener('timeupdate', u); a.addEventListener('loadedmetadata', d);
        a.addEventListener('durationchange', d); a.addEventListener('ended', e);
        return () => { a.removeEventListener('timeupdate', u); a.removeEventListener('loadedmetadata', d); a.removeEventListener('durationchange', d); a.removeEventListener('ended', e); };
    }, []);

    useEffect(() => { if (liveLines.length > 0 && activeSection !== 'transcription') setActiveSection('transcription'); }, [liveLines.length > 0]);

    const mediaLoadedRef = useRef(false);
    useEffect(() => {
        if (mediaLoadedRef.current || !call.callSid || !call.audioUrl) return;
        mediaLoadedRef.current = true;
        (async () => { try { const res = await authedFetch(`/api/calls/${call.callSid}/media`); if (!res.ok) return; const data = await res.json(); const t = data.transcript; if (t) { if (!transcriptionText && t.text) setTranscriptionText(t.text); if (entities.length === 0 && t.entities?.length) setEntities(t.entities); if (sentimentScore === null && t.sentimentScore != null) setSentimentScore(t.sentimentScore); if (t.gemini_summary) { setGeminiSummary(t.gemini_summary); setGeminiEntities(t.gemini_entities || []); setGeminiStatus('ready'); geminiLoadedRef.current = true; setActiveSection(prev => prev ?? 'summary'); } } } catch { /* ignore */ } })();
    }, [call.callSid]);

    useEffect(() => {
        if (activeSection !== 'summary' || geminiLoadedRef.current || !call.callSid) return;
        geminiLoadedRef.current = true; setGeminiStatus('loading');
        (async () => { try { const res = await authedFetch(`/api/calls/${call.callSid}/media`); if (!res.ok) throw new Error(); const data = await res.json(); const t = data.transcript; if (t) { if (!transcriptionText && t.text) setTranscriptionText(t.text); if (entities.length === 0 && t.entities?.length) setEntities(t.entities); if (sentimentScore === null && t.sentimentScore != null) setSentimentScore(t.sentimentScore); if (t.gemini_summary) { setGeminiSummary(t.gemini_summary); setGeminiEntities(t.gemini_entities || []); setGeminiStatus('ready'); } else setGeminiStatus('idle'); } else setGeminiStatus('idle'); } catch { setGeminiStatus('error'); } })();
    }, [activeSection, call.callSid]);

    const handlePlayPause = () => { if (!audioRef.current) return; if (isPlaying) audioRef.current.pause(); else audioRef.current.play(); setIsPlaying(!isPlaying); };
    const handleSkip = (s: number) => { if (!audioRef.current) return; audioRef.current.currentTime = Math.max(0, Math.min(audioRef.current.currentTime + s, duration)); };

    const handleResetTranscription = async () => { setIsTranscribing(true); setTranscribeError(null); try { await authedFetch(`/api/calls/${call.callSid}/transcript`, { method: 'DELETE' }); setTranscriptionText(null); setEntities([]); setSentimentScore(null); setGeminiSummary(null); setGeminiEntities([]); setGeminiStatus('idle'); setActiveGeminiIdx(null); geminiLoadedRef.current = false; mediaLoadedRef.current = false; const res = await authedFetch(`/api/calls/${call.callSid}/transcribe`, { method: 'POST' }); const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Failed'); setTranscriptionText(data.transcript); if (data.entities) setEntities(data.entities); if (data.gemini_summary) { setGeminiSummary(data.gemini_summary); setGeminiEntities(data.gemini_entities || []); setGeminiStatus('ready'); } if (data.sentimentScore != null) setSentimentScore(data.sentimentScore); } catch (err: any) { setTranscribeError(err.message); } finally { setIsTranscribing(false); } };
    const handleGenerateTranscription = async () => { setIsTranscribing(true); setTranscribeError(null); try { const res = await authedFetch(`/api/calls/${call.callSid}/transcribe`, { method: 'POST' }); const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Failed'); setTranscriptionText(data.transcript); if (data.entities) setEntities(data.entities); if (data.gemini_summary) { setGeminiSummary(data.gemini_summary); setGeminiEntities(data.gemini_entities || []); setGeminiStatus('ready'); } if (data.sentimentScore != null) setSentimentScore(data.sentimentScore); } catch (err: any) { setTranscribeError(err.message); } finally { setIsTranscribing(false); } };

    // ── Live transcription (no audio URL) ──
    if (!call.audioUrl && isLiveStreaming) {
        return (
            <div className="px-4 pb-4">
                <div className="space-y-3">
                    <div className="flex items-center gap-2">
                        <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                        <span className="text-xs text-red-500 font-medium">Live transcription</span>
                    </div>
                    <ScrollArea className="h-48 p-3 rounded-xl" style={{ background: 'rgba(117,106,89,0.04)' }}>
                        <div className="space-y-1">
                            {liveLines.map((line, idx) => (
                                <div key={idx} className="flex items-baseline gap-2 px-2 py-1 text-xs">
                                    <span className={`shrink-0 text-[10px] font-semibold ${line.speaker === 'agent' ? 'text-blue-500' : 'text-green-600'}`}>
                                        {line.speaker === 'agent' ? 'Agent' : 'Customer'}:
                                    </span>
                                    <span className="flex-1 text-sm leading-relaxed" style={{ color: 'var(--blanc-ink-1)' }}>
                                        {line.text}
                                        {!line.isFinal && <span className="ml-1 animate-pulse" style={{ color: 'var(--blanc-ink-3)' }}>▋</span>}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </ScrollArea>
                </div>
            </div>
        );
    }
    if (!call.audioUrl) return null;

    // ── Spinner helper ──
    const Spinner = () => (
        <div className="w-3 h-3 rounded-full animate-spin" style={{ border: '2px solid var(--blanc-line)', borderTopColor: 'var(--blanc-ink-2)' }} />
    );

    return (
        <div className="px-4 pb-4">
            <audio ref={audioRef} src={token ? `${call.audioUrl}?token=${encodeURIComponent(token)}` : call.audioUrl} preload="metadata" />
            <div className="space-y-3">
                {/* Controls row: tabs + player + time */}
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-3 shrink-0">
                        {(() => {
                            const sd = getSentiment(sentimentScore);
                            if (!sd) return null;
                            return <span title={`${sd.label} (${sentimentScore})`} className="text-base leading-none cursor-default" style={{ filter: `drop-shadow(0 0 2px ${sd.color})` }}>{sd.emoji}</span>;
                        })()}
                        <button
                            onClick={() => setActiveSection(activeSection === 'summary' ? null : 'summary')}
                            className="text-[11px] font-medium px-2 py-0.5 rounded-md transition-colors"
                            style={activeSection === 'summary'
                                ? { background: 'var(--blanc-surface-muted)', color: 'var(--blanc-ink-1)', border: '1px solid var(--blanc-line)' }
                                : { color: 'var(--blanc-ink-3)', border: '1px solid transparent' }
                            }
                        >
                            Summary
                        </button>
                        <button
                            onClick={() => setActiveSection(activeSection === 'transcription' ? null : 'transcription')}
                            className="text-[11px] font-medium px-2 py-0.5 rounded-md transition-colors flex items-center gap-1"
                            style={activeSection === 'transcription'
                                ? { background: 'var(--blanc-surface-muted)', color: 'var(--blanc-ink-1)', border: '1px solid var(--blanc-line)' }
                                : { color: 'var(--blanc-ink-3)', border: '1px solid transparent' }
                            }
                        >
                            Transcript
                            {isLiveStreaming && <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />}
                        </button>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        <button onClick={() => handleSkip(-10)} title="Rewind 10s" className="h-8 w-8 flex items-center justify-center transition-colors relative" style={{ color: 'var(--blanc-ink-3)' }}>
                            <RotateCcw className="w-[18px] h-[18px]" /><span className="absolute text-[8px] font-semibold" style={{ marginTop: '1px' }}>10</span>
                        </button>
                        <button onClick={handlePlayPause} className="h-8 w-8 flex items-center justify-center transition-colors" style={{ color: 'var(--blanc-ink-2)' }}>
                            {isPlaying ? <Pause className="w-[18px] h-[18px]" /> : <Play className="w-[18px] h-[18px]" />}
                        </button>
                        <button onClick={() => handleSkip(10)} title="Forward 10s" className="h-8 w-8 flex items-center justify-center transition-colors relative" style={{ color: 'var(--blanc-ink-3)' }}>
                            <RotateCw className="w-[18px] h-[18px]" /><span className="absolute text-[8px] font-semibold" style={{ marginTop: '1px' }}>10</span>
                        </button>
                    </div>
                    <span className="text-xs font-mono" style={{ color: 'var(--blanc-ink-3)' }}>
                        {fmtAudio(currentTime)} / {fmtAudio(duration)}
                    </span>
                </div>

                {/* ── Summary panel ── */}
                {activeSection === 'summary' && (
                    <div className="space-y-4 pt-1">
                        {/* Summary text */}
                        <div>
                            {(geminiSummary || call.summary) && (
                                <div className="flex items-center gap-1.5 mb-1.5">
                                    <h4 className="blanc-eyebrow" style={{ marginBottom: 0 }}>Summary</h4>
                                    <button
                                        onClick={() => { navigator.clipboard.writeText(geminiSummary || call.summary || ''); setCopiedSummary(true); setTimeout(() => setCopiedSummary(false), 1500); }}
                                        className="p-0.5 rounded transition-colors"
                                        style={{ color: 'var(--blanc-ink-3)' }}
                                        title="Copy summary"
                                    >
                                        {copiedSummary ? <Check className="size-3.5" style={{ color: 'var(--blanc-success)' }} /> : <Copy className="size-3.5" />}
                                    </button>
                                </div>
                            )}
                            {geminiStatus === 'loading'
                                ? <div className="flex items-center gap-2 py-2"><Spinner /><span className="text-sm animate-pulse" style={{ color: 'var(--blanc-ink-3)' }}>Generating summary…</span></div>
                                : geminiStatus === 'error'
                                    ? <p className="text-sm italic" style={{ color: 'var(--blanc-danger)' }}>Summary unavailable</p>
                                    : geminiSummary
                                        ? <p className="text-sm leading-relaxed" style={{ color: 'var(--blanc-ink-2)' }}>{geminiSummary}</p>
                                        : call.summary
                                            ? <p className="text-sm leading-relaxed" style={{ color: 'var(--blanc-ink-2)' }}>{call.summary}</p>
                                            : isTranscribing
                                                ? <p className="text-sm italic" style={{ color: 'var(--blanc-ink-3)' }}>Waiting for transcript…</p>
                                                : <p className="text-sm italic" style={{ color: 'var(--blanc-ink-3)' }}>No summary available</p>}
                        </div>

                        {/* Key entities */}
                        {(geminiEntities.length > 0 || geminiStatus === 'loading') && (
                            <div>
                                <div className="flex items-center justify-between mb-1.5">
                                    <h4 className="blanc-eyebrow" style={{ marginBottom: 0 }}>Key Entities</h4>
                                    {geminiEntities.length > 0 && (
                                        <span className="text-[10px]" style={{ color: 'var(--blanc-ink-3)' }}>{geminiEntities.length} found</span>
                                    )}
                                </div>
                                {geminiStatus === 'loading'
                                    ? <div className="flex items-center gap-2 py-2"><Spinner /><span className="text-sm animate-pulse" style={{ color: 'var(--blanc-ink-3)' }}>Extracting…</span></div>
                                    : (
                                        <div className="space-y-0.5">
                                            {geminiEntities.map((ge, idx) => {
                                                const hasTs = ge.start_ms != null;
                                                const sec = hasTs ? ge.start_ms! / 1000 : 0;
                                                const active = activeGeminiIdx === idx;
                                                const inRange = hasTs && currentTime >= sec && currentTime <= sec + 10;
                                                return (
                                                    <div
                                                        key={`ge-${ge.label}-${idx}`}
                                                        onClick={() => {
                                                            if (!hasTs) return;
                                                            if (audioRef.current) {
                                                                audioRef.current.currentTime = sec;
                                                                setCurrentTime(sec);
                                                                setActiveGeminiIdx(idx);
                                                                if (!isPlaying) { audioRef.current.play(); setIsPlaying(true); }
                                                            }
                                                        }}
                                                        className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors group ${hasTs ? 'cursor-pointer' : 'cursor-default'}`}
                                                        style={{
                                                            background: (active || inRange) ? 'rgba(47,99,216,0.06)' : undefined,
                                                            opacity: hasTs ? 1 : 0.7,
                                                        }}
                                                        title={hasTs ? `Jump to ${fmtAudio(sec)}` : undefined}
                                                    >
                                                        <span className="shrink-0 text-[11px] font-medium" style={{ color: 'var(--blanc-ink-3)', minWidth: 130 }}>
                                                            {ge.label}
                                                        </span>
                                                        <span className="flex-1 text-[12px] font-medium" style={{ color: 'var(--blanc-ink-1)', wordBreak: 'break-word' }}>
                                                            {ge.value}
                                                        </span>
                                                        <span className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                                            <button
                                                                onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(ge.value); setCopiedEntityIdx(idx); setTimeout(() => setCopiedEntityIdx(null), 1500); }}
                                                                className="p-0.5 rounded transition-colors"
                                                                style={{ color: 'var(--blanc-ink-3)' }}
                                                                title="Copy"
                                                            >
                                                                {copiedEntityIdx === idx ? <Check className="size-3" style={{ color: 'var(--blanc-success)' }} /> : <Copy className="size-3" />}
                                                            </button>
                                                        </span>
                                                        {hasTs && (
                                                            <span className="shrink-0 text-[10px] font-mono" style={{ color: 'var(--blanc-ink-3)' }}>
                                                                {fmtAudio(sec)}
                                                            </span>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                            </div>
                        )}

                        {geminiStatus === 'error' && (
                            <p className="text-xs italic" style={{ color: 'var(--blanc-ink-3)' }}>Entities unavailable</p>
                        )}
                    </div>
                )}

                {/* ── Transcription panel ── */}
                {activeSection === 'transcription' && (
                    <div className="pt-1">
                        <ScrollArea className="h-48 p-3 rounded-xl" style={{ background: 'rgba(117,106,89,0.04)' }}>
                            {isTranscribing ? (
                                <div className="flex items-center gap-2">
                                    <Spinner />
                                    <p className="text-sm animate-pulse" style={{ color: 'var(--blanc-ink-3)' }}>Generating transcription...</p>
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
                                                <span className={`shrink-0 text-[10px] font-semibold ${line.speaker === 'agent' ? 'text-blue-500' : 'text-green-600'}`}>
                                                    {line.speaker === 'agent' ? 'Agent' : 'Customer'}:
                                                </span>
                                                <span className="flex-1 text-sm leading-relaxed" style={{ color: 'var(--blanc-ink-1)' }}>
                                                    {line.text}
                                                    {!line.isFinal && <span className="ml-1 animate-pulse" style={{ color: 'var(--blanc-ink-3)' }}>▋</span>}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ) : (transcriptionText || call.transcription) ? (
                                <div>
                                    <div className="space-y-0.5">
                                        {(transcriptionText || call.transcription || '').split('\n').filter((l: string) => l.trim()).map((line: string, idx: number) => {
                                            const m = line.match(/^\[(\d+)ms\]\s*/);
                                            const ms = m ? parseInt(m[1], 10) : null;
                                            const clean = m ? line.slice(m[0].length) : line;
                                            const sec = ms != null ? ms / 1000 : null;
                                            return (
                                                <button
                                                    key={idx}
                                                    onClick={() => { if (audioRef.current && sec != null) { audioRef.current.currentTime = sec; setCurrentTime(sec); if (!isPlaying) { audioRef.current.play(); setIsPlaying(true); } } }}
                                                    className={`w-full flex items-baseline gap-2 px-2 py-1.5 rounded-lg text-left text-xs transition-colors ${sec != null ? 'cursor-pointer' : 'cursor-default'}`}
                                                    style={sec != null ? { color: 'var(--blanc-ink-1)' } : { color: 'var(--blanc-ink-2)' }}
                                                    onMouseEnter={e => { if (sec != null) e.currentTarget.style.background = 'rgba(117,106,89,0.06)'; }}
                                                    onMouseLeave={e => { e.currentTarget.style.background = ''; }}
                                                >
                                                    {sec != null && <span className="shrink-0 text-[10px] font-mono tabular-nums" style={{ color: 'var(--blanc-ink-3)' }}>{fmtAudio(sec)}</span>}
                                                    <span className="flex-1 text-sm leading-relaxed">{clean}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                    {call.callSid && (
                                        <button
                                            onClick={handleResetTranscription}
                                            className="mt-2 text-[11px] px-2 py-1 rounded-md transition-colors cursor-pointer"
                                            style={{ color: 'var(--blanc-ink-3)', border: '1px solid var(--blanc-line)' }}
                                        >
                                            ↻ Reset
                                        </button>
                                    )}
                                </div>
                            ) : (
                                <div>
                                    <p className="text-sm italic" style={{ color: 'var(--blanc-ink-3)' }}>No transcription available</p>
                                    {transcribeError && <p className="text-sm mt-1" style={{ color: 'var(--blanc-danger)' }}>{transcribeError}</p>}
                                    {call.callSid && (
                                        <button
                                            onClick={handleGenerateTranscription}
                                            className="mt-2 text-xs px-3 py-1.5 rounded-lg transition-colors cursor-pointer font-medium"
                                            style={{ background: 'var(--blanc-info)', color: '#fff' }}
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
    );
}
