import { useState, useEffect } from 'react';
import { Music, Play } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import type { AudioAsset } from '../../types/telephony';

const INK1 = 'var(--blanc-ink-1, #202734)';
const INK2 = 'var(--blanc-ink-2, #536070)';
const INK3 = 'var(--blanc-ink-3, #7d8796)';
const JOB = 'var(--blanc-job, #2f63d8)';
const LINE = 'var(--blanc-line, rgba(117,106,89,0.18))';

const CATS = ['all', 'greeting', 'hold_music', 'ivr_prompt', 'tts'] as const;
const CAT_LABELS: Record<string, string> = { all: 'All', greeting: 'Greetings', hold_music: 'Hold music', ivr_prompt: 'IVR prompts', tts: 'TTS' };

export default function AudioLibraryPage() {
    const [assets, setAssets] = useState<AudioAsset[]>([]);
    const [cat, setCat] = useState<string>('all');
    const [loading, setLoading] = useState(true);
    useEffect(() => { telephonyApi.listAudio().then(a => { setAssets(a); setLoading(false); }); }, []);
    const filtered = cat === 'all' ? assets : assets.filter(a => a.category === cat);
    const fmtDur = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;

    return (
        <div style={{ padding: '28px 24px' }}>
            <div style={{ marginBottom: 20 }}>
                <div className="blanc-eyebrow">Telephony</div>
                <h1 style={{ fontSize: 24, fontWeight: 600, margin: '4px 0 4px', fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: INK1 }}>Audio library</h1>
                <p style={{ fontSize: 13, color: INK3, margin: 0 }}>Greetings, prompts, and hold music used by your call flows.</p>
            </div>

            <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
                {CATS.map(c => <button key={c} onClick={() => setCat(c)} style={{ padding: '6px 14px', fontSize: 12, fontWeight: cat === c ? 600 : 400, background: cat === c ? 'rgba(47,99,216,0.1)' : 'rgba(117,106,89,0.04)', color: cat === c ? JOB : INK2, border: 'none', borderRadius: 8, cursor: 'pointer' }}>{CAT_LABELS[c]}</button>)}
            </div>

            {loading ? (
                <div style={{ padding: 40, textAlign: 'center', color: INK3 }}>Loading…</div>
            ) : filtered.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: INK3, border: `1px dashed ${LINE}`, borderRadius: 16 }}>No audio in this category yet.</div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {filtered.map(a => (
                        <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: 'var(--blanc-surface-strong, #fffdf9)', border: `1px solid ${LINE}`, borderRadius: 12 }}>
                            <button title="Play" style={{ background: 'none', border: 'none', cursor: 'pointer', color: JOB, display: 'flex', padding: 4 }}><Play size={16} /></button>
                            <Music size={16} style={{ color: INK3 }} />
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 13.5, fontWeight: 600, color: INK1 }}>{a.name}</div>
                                <div style={{ fontSize: 11.5, color: INK3 }}>{CAT_LABELS[a.category] || a.category} · {a.format.toUpperCase()}</div>
                            </div>
                            <span style={{ fontSize: 12, color: INK2 }}>{fmtDur(a.duration_sec)}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
