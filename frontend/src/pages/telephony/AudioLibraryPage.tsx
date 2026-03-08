import { useState, useEffect } from 'react';
import { Music, Play, Upload, Plus } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import type { AudioAsset } from '../../types/telephony';

const CATS = ['all', 'greeting', 'hold_music', 'ivr_prompt', 'tts'] as const;
const CAT_LABELS: Record<string, string> = { all: 'All', greeting: 'Greetings', hold_music: 'Hold Music', ivr_prompt: 'IVR Prompts', tts: 'TTS' };

export default function AudioLibraryPage() {
    const [assets, setAssets] = useState<AudioAsset[]>([]);
    const [cat, setCat] = useState<string>('all');
    const [loading, setLoading] = useState(true);
    useEffect(() => { telephonyApi.listAudio().then(a => { setAssets(a); setLoading(false); }); }, []);
    const filtered = cat === 'all' ? assets : assets.filter(a => a.category === cat);
    const fmtDur = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
    return (
        <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div><h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Audio Library</h1><p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Greetings, prompts, hold music</p></div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', fontSize: 13, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}><Upload size={14} />Upload</button>
                    <button style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', fontSize: 13, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}><Plus size={14} />Create TTS</button>
                </div>
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
                {CATS.map(c => <button key={c} onClick={() => setCat(c)} style={{ padding: '6px 14px', fontSize: 12, fontWeight: cat === c ? 600 : 400, background: cat === c ? '#ede9fe' : '#f9fafb', color: cat === c ? '#6366f1' : '#6b7280', border: 'none', borderRadius: 6, cursor: 'pointer' }}>{CAT_LABELS[c]}</button>)}
            </div>
            {loading ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {filtered.map(a => (
                        <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8 }}>
                            <button style={{ width: 32, height: 32, borderRadius: '50%', background: '#ede9fe', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Play size={14} style={{ color: '#6366f1' }} /></button>
                            <Music size={16} style={{ color: '#6366f1' }} />
                            <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{a.name}</div><div style={{ fontSize: 11, color: '#9ca3af' }}>{CAT_LABELS[a.category] || a.category} · {a.format.toUpperCase()}</div></div>
                            <span style={{ fontSize: 12, color: '#6b7280' }}>{fmtDur(a.duration_sec)}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
