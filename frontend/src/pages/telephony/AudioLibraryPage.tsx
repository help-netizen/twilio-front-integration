import { useState, useEffect } from 'react';
import { Music, Play } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import { SettingsPageShell } from '../../components/settings/SettingsPageShell';
import type { AudioAsset } from '../../types/telephony';

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
        <SettingsPageShell
            eyebrow="Telephony"
            title="Audio Library"
            description="Greetings, prompts, and hold music used by your call flows."
        >
            <div className="space-y-4">
                <div className="flex flex-wrap gap-1">
                    {CATS.map(c => (
                        <button
                            key={c}
                            onClick={() => setCat(c)}
                            style={{
                                padding: '6px 14px',
                                fontSize: 12,
                                fontWeight: cat === c ? 600 : 400,
                                background: cat === c ? 'var(--blanc-accent-soft)' : 'rgba(25, 25, 25, 0.03)',
                                color: cat === c ? 'var(--blanc-accent)' : 'var(--blanc-ink-2)',
                                border: 'none',
                                borderRadius: 8,
                                cursor: 'pointer',
                            }}
                        >
                            {CAT_LABELS[c]}
                        </button>
                    ))}
                </div>

                {loading ? (
                    <div style={{ padding: 40, textAlign: 'center', color: 'var(--blanc-ink-3)' }}>Loading…</div>
                ) : filtered.length === 0 ? (
                    <div style={{ padding: 40, textAlign: 'center', color: 'var(--blanc-ink-3)', border: '1px dashed var(--blanc-line)', borderRadius: 16 }}>No audio in this category yet.</div>
                ) : (
                    /* Тайлы на канвасе (LAYOUT-CANON правило 7): родитель раздаёт gap 8, поверхность несут сами записи. */
                    <div className="flex flex-col gap-2">
                        {filtered.map(a => (
                            <div key={a.id} className="blanc-tile" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
                                <button title="Play" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--blanc-accent)', display: 'flex', padding: 4 }}><Play size={16} /></button>
                                <Music size={16} style={{ color: 'var(--blanc-ink-3)' }} />
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--blanc-ink-1)' }}>{a.name}</div>
                                    <div style={{ fontSize: 11.5, color: 'var(--blanc-ink-3)' }}>{CAT_LABELS[a.category] || a.category} · {a.format.toUpperCase()}</div>
                                </div>
                                <span style={{ fontSize: 12, color: 'var(--blanc-ink-2)' }}>{fmtDur(a.duration_sec)}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </SettingsPageShell>
    );
}
