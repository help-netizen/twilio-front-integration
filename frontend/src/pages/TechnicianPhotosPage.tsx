import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, Camera, CheckCircle2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { techniciansApi, type Technician } from '../services/techniciansApi';

function initials(name?: string | null) {
    if (!name) return '🙂';
    return name.trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

export default function TechnicianPhotosPage() {
    const navigate = useNavigate();
    const [techs, setTechs] = useState<Technician[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState<string | null>(null);
    const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

    const load = () => {
        setLoading(true);
        techniciansApi.list()
            .then(setTechs)
            .catch(e => toast.error(e.message))
            .finally(() => setLoading(false));
    };
    useEffect(load, []);

    const onPick = async (techId: string, file?: File) => {
        if (!file) return;
        setUploading(techId);
        try {
            await techniciansApi.uploadPhoto(techId, file);
            toast.success('Photo updated');
            setTechs(ts => ts.map(t => t.tech_id === techId ? { ...t, has_photo: true } : t));
        } catch (e: any) { toast.error(e.message || 'Upload failed'); }
        finally { setUploading(null); }
    };

    return (
        <div className="max-w-2xl mx-auto px-6 py-8" style={{ color: 'var(--blanc-ink-1)' }}>
            <button onClick={() => navigate('/settings/integrations')} className="flex items-center gap-1.5 text-sm mb-6" style={{ color: 'var(--blanc-ink-3)' }}>
                <ArrowLeft className="h-4 w-4" /> Settings
            </button>
            <h2 className="text-2xl font-semibold" style={{ fontFamily: 'var(--blanc-font-heading, inherit)' }}>Technician photos</h2>
            <p className="text-sm mt-1 mb-6" style={{ color: 'var(--blanc-ink-3)' }}>
                Shown on the customer payment page next to a thank-you. A photo builds trust and lifts tips.
            </p>

            {loading ? (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
            ) : techs.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>No technicians found yet — they appear here once assigned to jobs.</p>
            ) : (
                <div className="space-y-2">
                    {techs.map(t => (
                        <div key={t.tech_id} className="flex items-center justify-between rounded-xl border px-4 py-3" style={{ borderColor: 'var(--blanc-line)' }}>
                            <div className="flex items-center gap-3">
                                <div className="h-11 w-11 rounded-full flex items-center justify-center font-bold" style={{ background: '#efe7d8', color: '#8a7d68' }}>
                                    {t.has_photo ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : initials(t.name)}
                                </div>
                                <div>
                                    <div className="font-medium">{t.name || 'Unnamed technician'}</div>
                                    <div className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>{t.has_photo ? 'Photo set' : 'No photo'}</div>
                                </div>
                            </div>
                            <input ref={el => { fileInputs.current[t.tech_id] = el; }} type="file" accept="image/*" hidden
                                onChange={e => onPick(t.tech_id, e.target.files?.[0])} />
                            <Button variant="outline" size="sm" disabled={uploading === t.tech_id}
                                onClick={() => fileInputs.current[t.tech_id]?.click()}>
                                {uploading === t.tech_id ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Camera className="h-4 w-4 mr-2" />}
                                {t.has_photo ? 'Replace' : 'Upload'}
                            </Button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
