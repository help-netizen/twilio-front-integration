import { useState, useEffect, useCallback } from 'react';
import { authedFetch } from '../services/apiClient';
import { Card } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Separator } from '../components/ui/separator';
import { Skeleton } from '../components/ui/skeleton';
import { Button } from '../components/ui/button';
import { toast } from 'sonner';
import { Wrench, RefreshCw, MapPin, Phone, Mail } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

/* ───────────────────────────── Types ────────────────────────────── */

interface Territory {
    name: string;
    id: string;
}

interface Provider {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    user_status: string;
    role: string;
    is_service_provider: boolean;
    assigned_territories: Territory[];
    skill_tags: { name: string; id: string }[];
    calendar_color: string | null;
    avatar: string | null;
    created: string;
}

/* ───────────────────────────── Page ─────────────────────────────── */

export default function ProvidersPage() {
    const [providers, setProviders] = useState<Provider[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchProviders = useCallback(async () => {
        setLoading(true);
        try {
            const res = await authedFetch(`${API_BASE}/zenbooker/team-members`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            setProviders(json.data || []);
        } catch (e: any) {
            toast.error('Failed to load providers', { description: e.message });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchProviders(); }, [fetchProviders]);

    const fmtPhone = (p: string | null) => {
        if (!p) return null;
        const digits = p.replace(/\D/g, '');
        if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
        if (digits.length === 11 && digits.startsWith('1')) return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
        return p;
    };

    return (
        <div className="max-w-5xl mx-auto p-6 space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <div className="flex items-center gap-2 mb-1">
                        <Wrench className="size-5 text-muted-foreground" />
                        <h2 className="text-xl font-semibold">Service Providers</h2>
                    </div>
                    <p className="text-sm text-muted-foreground">
                        Technicians and their assigned service territories (from Zenbooker).
                    </p>
                </div>
                <Button variant="outline" size="sm" onClick={fetchProviders} disabled={loading}>
                    <RefreshCw className={`size-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                    Refresh
                </Button>
            </div>

            <Separator />

            {/* Content */}
            {loading ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {[...Array(4)].map((_, i) => (
                        <Skeleton key={i} className="h-40 w-full rounded-lg" />
                    ))}
                </div>
            ) : providers.length === 0 ? (
                <div className="flex items-center justify-center py-16">
                    <div className="text-center">
                        <Wrench className="size-12 mx-auto mb-3 opacity-20" />
                        <p className="text-lg mb-1">No service providers found</p>
                        <p className="text-sm text-muted-foreground">
                            Service providers are managed in Zenbooker.
                        </p>
                    </div>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {providers.map(p => (
                        <Card key={p.id} className="p-4 space-y-3">
                            {/* Provider header */}
                            <div className="flex items-start justify-between">
                                <div className="flex items-center gap-3">
                                    {p.avatar ? (
                                        <img
                                            src={p.avatar.startsWith('//') ? `https:${p.avatar}` : p.avatar}
                                            alt={p.name}
                                            className="size-10 rounded-full object-cover"
                                        />
                                    ) : (
                                        <div
                                            className="size-10 rounded-full flex items-center justify-center text-white font-semibold text-sm"
                                            style={{ backgroundColor: p.calendar_color || '#6b7280' }}
                                        >
                                            {p.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                                        </div>
                                    )}
                                    <div>
                                        <div className="font-medium text-sm">{p.name}</div>
                                        <div className="flex items-center gap-2 mt-0.5">
                                            <Badge
                                                variant={p.user_status === 'activated' ? 'outline' : 'secondary'}
                                                className="text-xs"
                                            >
                                                {p.user_status}
                                            </Badge>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Contact info */}
                            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                                {p.phone && (
                                    <span className="flex items-center gap-1">
                                        <Phone className="size-3" /> {fmtPhone(p.phone)}
                                    </span>
                                )}
                                {p.email && (
                                    <span className="flex items-center gap-1">
                                        <Mail className="size-3" /> {p.email}
                                    </span>
                                )}
                            </div>

                            {/* Territories */}
                            {p.assigned_territories.length > 0 && (
                                <div>
                                    <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1.5">
                                        <MapPin className="size-3" /> Territories
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {p.assigned_territories.map(t => (
                                            <Badge key={t.id} variant="secondary" className="text-xs font-normal">
                                                {t.name.trim()}
                                            </Badge>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Skill tags */}
                            {p.skill_tags.length > 0 && (
                                <div>
                                    <div className="text-xs text-muted-foreground mb-1.5">Skills</div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {p.skill_tags.map(s => (
                                            <Badge key={s.id} variant="outline" className="text-xs font-normal">
                                                {s.name}
                                            </Badge>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </Card>
                    ))}
                </div>
            )}

            <div className="text-xs text-muted-foreground text-center pt-2">
                {providers.length} provider{providers.length !== 1 ? 's' : ''} • Data from Zenbooker
            </div>
        </div>
    );
}
