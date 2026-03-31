import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { UserRound } from 'lucide-react';
import { pulseApi } from '../../services/pulseApi';
import { authedFetch } from '../../services/apiClient';

export function AssignOwnerDropdown({ timelineId, onAssigned }: { timelineId: number | null; onAssigned?: () => void }) {
    const [open, setOpen] = useState(false);
    const [members, setMembers] = useState<Array<{ id: string; name: string }>>([]);
    const [loaded, setLoaded] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    useEffect(() => {
        if (!open || loaded) return;
        const API_BASE = import.meta.env.VITE_API_URL || '/api';
        authedFetch(`${API_BASE}/users`)
            .then(r => r.json())
            .then(data => {
                const users = (data.users || data || []).map((u: any) => ({
                    id: u.id || u.user_id || u.keycloak_id,
                    name: u.full_name || u.name || u.email || u.username || 'Unknown',
                }));
                setMembers(users);
                setLoaded(true);
            })
            .catch(() => setLoaded(true));
    }, [open, loaded]);

    return (
        <div className="relative" ref={ref}>
            <button
                onClick={() => setOpen(!open)}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded transition-colors"
            >
                <UserRound className="size-3" /> Assign
            </button>
            {open && (
                <div className="absolute left-0 top-full mt-1 z-50 bg-card rounded-xl shadow-lg border border-border py-1 min-w-[180px] max-h-[200px] overflow-y-auto">
                    {!loaded ? (
                        <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
                    ) : members.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-muted-foreground">No team members</div>
                    ) : (
                        members.map(m => (
                            <div key={m.id} role="button" tabIndex={0}
                                onClick={() => {
                                    if (timelineId) {
                                        pulseApi.assignThread(timelineId, m.id)
                                            .then(() => { toast.success(`Assigned to ${m.name}`); onAssigned?.(); })
                                            .catch(() => toast.error('Failed to assign'));
                                    }
                                    setOpen(false);
                                }}
                                className="px-3 py-2 text-sm text-foreground hover:bg-muted/60 cursor-pointer"
                            >
                                {m.name}
                            </div>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
