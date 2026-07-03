import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { UserRound } from 'lucide-react';
import { pulseApi } from '../../services/pulseApi';
import { authedFetch } from '../../services/apiClient';
import { isMobileViewport } from '../../hooks/useViewportSafePosition';
import { BottomSheet } from '../ui/BottomSheet';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

export function AssignOwnerDropdown({ timelineId, onAssigned }: { timelineId: number | null; onAssigned?: () => void }) {
    const [open, setOpen] = useState(false);
    const [members, setMembers] = useState<Array<{ id: string; name: string }>>([]);
    const [loaded, setLoaded] = useState(false);

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

    const handleAssign = (m: { id: string; name: string }) => {
        if (timelineId) {
            pulseApi.assignThread(timelineId, m.id)
                .then(() => { toast.success(`Assigned to ${m.name}`); onAssigned?.(); })
                .catch(() => toast.error('Failed to assign'));
        }
        setOpen(false);
    };

    const isMobile = isMobileViewport();

    const listContent = (
        <>
            {!loaded ? (
                <div className="px-4 py-3 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>Loading…</div>
            ) : members.length === 0 ? (
                <div className="px-4 py-3 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>No team members</div>
            ) : (
                members.map(m => (
                    <div key={m.id} role="button" tabIndex={0}
                        onClick={() => handleAssign(m)}
                        className="px-4 py-3 text-sm hover:bg-muted/60 cursor-pointer"
                        style={{ color: 'var(--blanc-ink-1)' }}
                    >
                        {m.name}
                    </div>
                ))
            )}
        </>
    );

    return (
        <>
            {/* desktop = канонный Popover (тир z-150, dismiss из коробки — самодельный
                fixed z-[101] + click-outside/clampToViewport снесены, W3-аудит),
                mobile = канонный BottomSheet как и был. */}
            <Popover open={open && !isMobile} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <button
                        className="inline-flex items-center gap-1.5 px-4 text-sm font-semibold transition-opacity hover:opacity-70"
                        style={{ color: 'var(--blanc-info)', background: 'rgba(37, 99, 235, 0.08)', minHeight: 42, borderRadius: 14 }}
                    >
                        <UserRound className="size-4" /> Assign
                    </button>
                </PopoverTrigger>
                <PopoverContent align="start" sideOffset={4} className="w-auto min-w-[200px] max-h-[200px] overflow-y-auto p-0 py-1 rounded-xl">
                    {listContent}
                </PopoverContent>
            </Popover>
            {open && isMobile && (
                <BottomSheet open={open} onClose={() => setOpen(false)} title="Assign Owner" size="auto">
                    {listContent}
                </BottomSheet>
            )}
        </>
    );
}
