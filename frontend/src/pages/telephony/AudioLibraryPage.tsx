import { useState, useEffect } from 'react';
import { Music, Upload, Search, Play, Pause, Trash2 } from 'lucide-react';
import { extendedMockApi, type AudioAsset } from '../../services/extendedMockApi';

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
    greeting: { label: 'Greeting', color: '#3b82f6' },
    voicemail_greeting: { label: 'Voicemail', color: '#14b8a6' },
    hold_music: { label: 'Hold Music', color: '#8b5cf6' },
    tts_template: { label: 'TTS', color: '#f97316' },
};

function formatDuration(sec: number) {
    if (sec === 0) return '—';
    const m = Math.floor(sec / 60); const s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function AudioLibraryPage() {
    const [assets, setAssets] = useState<AudioAsset[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [tab, setTab] = useState('all');
    const [playing, setPlaying] = useState<string | null>(null);

    useEffect(() => { extendedMockApi.getAudioAssets().then(a => { setAssets(a); setLoading(false); }); }, []);

    const filtered = assets.filter(a => {
        if (tab !== 'all' && a.category !== tab) return false;
        if (search && !a.name.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });

    const tabs = [
        { key: 'all', label: 'All', count: assets.length },
        { key: 'greeting', label: 'Greetings', count: assets.filter(a => a.category === 'greeting').length },
        { key: 'voicemail_greeting', label: 'Voicemail', count: assets.filter(a => a.category === 'voicemail_greeting').length },
        { key: 'hold_music', label: 'Hold Music', count: assets.filter(a => a.category === 'hold_music').length },
        { key: 'tts_template', label: 'TTS', count: assets.filter(a => a.category === 'tts_template').length },
    ];

    if (loading) return <div style={{ padding: 32 }}><div style={{ width: 24, height: 24, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;

    return (
        <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <div>
                    <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111', margin: 0 }}>Audio Library</h1>
                    <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Greetings, voicemail prompts, hold music, and TTS templates</p>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#6366f1', border: '1px solid #6366f1', borderRadius: 8, cursor: 'pointer' }}><Music size={15} />Create TTS</button>
                    <button style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 500, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}><Upload size={15} />Upload Audio</button>
                </div>
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #e5e7eb', paddingBottom: 0 }}>
                {tabs.map(t => (
                    <button key={t.key} onClick={() => setTab(t.key)} style={{ padding: '8px 16px', fontSize: 13, fontWeight: tab === t.key ? 600 : 400, color: tab === t.key ? '#6366f1' : '#6b7280', background: 'none', border: 'none', borderBottom: tab === t.key ? '2px solid #6366f1' : '2px solid transparent', cursor: 'pointer', marginBottom: -1 }}>
                        {t.label} <span style={{ fontSize: 11, fontWeight: 500, padding: '1px 6px', borderRadius: 8, background: '#f3f4f6', color: '#6b7280', marginLeft: 4 }}>{t.count}</span>
                    </button>
                ))}
            </div>

            <div style={{ position: 'relative', maxWidth: 300, marginBottom: 16 }}>
                <Search size={16} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search assets..." style={{ width: '100%', padding: '8px 12px 8px 32px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, outline: 'none' }} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {filtered.map(a => {
                    const cat = CATEGORY_LABELS[a.category] || { label: a.category, color: '#6b7280' };
                    return (
                        <div key={a.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
                            <button onClick={() => setPlaying(p => p === a.id ? null : a.id)} style={{ width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: playing === a.id ? '#6366f1' : '#f3f4f6', color: playing === a.id ? '#fff' : '#374151', border: 'none', cursor: 'pointer', flexShrink: 0 }}>
                                {playing === a.id ? <Pause size={16} /> : <Play size={16} />}
                            </button>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{a.name}</div>
                                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                                    {formatDuration(a.duration_sec)} · {a.format.toUpperCase()} · Used in {a.usage_count} flow{a.usage_count !== 1 ? 's' : ''}
                                </div>
                            </div>
                            <span style={{ fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 10, background: `${cat.color}15`, color: cat.color }}>{cat.label}</span>
                            {a.category !== 'tts_template' && (
                                <div style={{ width: 120, height: 24, background: '#f9fafb', borderRadius: 4, overflow: 'hidden', display: 'flex', alignItems: 'center', padding: '0 4px', gap: 1 }}>
                                    {Array.from({ length: 30 }, (_, i) => (
                                        <div key={i} style={{ width: 3, height: Math.max(4, Math.random() * 20), background: playing === a.id ? '#6366f1' : '#d1d5db', borderRadius: 1 }} />
                                    ))}
                                </div>
                            )}
                            <div style={{ fontSize: 11, color: '#9ca3af', minWidth: 70 }}>{new Date(a.created_at).toLocaleDateString()}</div>
                            <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#d1d5db', padding: 4 }}><Trash2 size={14} /></button>
                        </div>
                    );
                })}
                {filtered.length === 0 && <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No audio assets found. Upload your first file or create a TTS greeting.</div>}
            </div>
        </div>
    );
}
