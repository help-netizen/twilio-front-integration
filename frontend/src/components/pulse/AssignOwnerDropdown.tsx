import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { UserRound, X } from 'lucide-react';
import { pulseApi } from '../../services/pulseApi';
import { authedFetch } from '../../services/apiClient';
import { isMobileViewport, clampToViewport } from '../../hooks/useViewportSafePosition';

export function AssignOwnerDropdown({ timelineId, onAssigned }: { timelineId: number | null; onAssigned?: () => void }) {
    const [open, setOpen] = useState(false);
    const [members, setMembers] = useState<Array<{ id: string; name: string }>>([]);
    const [loaded, setLoaded] = useState(false);
    const btnRef = useRef<HTMLButtonElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Close on click outside
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            if (btnRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
            setOpen(false);
        };
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

    const handleAssign = (m: { id: string; name: string }) => {
        if (timelineId) {
            pulseApi.assignThread(timelineId, m.id)
                .then(() => { toast.success(`Assigned to ${m.name}`); onAssigned?.(); })
                .catch(() => toast.error('Failed to assign'));
        }
        setOpen(false);
    };

    const isMobile = open && isMobileViewport();
    const rect = btnRef.current?.getBoundingClientRect();
    const desktopPos = rect && !isMobile ? clampToViewport(rect, 200, 220) : null;

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
        <div className="relative">
            <button
                ref={btnRef}
                onClick={() => setOpen(!open)}
                className="inline-flex items-center gap-1.5 px-4 text-sm font-semibold transition-opacity hover:opacity-70"
                style={{ color: 'var(--blanc-info)', background: 'rgba(37, 99, 235, 0.08)', minHeight: 42, borderRadius: 14 }}
            >
                <UserRound className="size-4" /> Assign
            </button>
            {open && isMobile && (
                <>
                    <div className="blanc-mobile-sheet-backdrop" onClick={() => setOpen(false)} />
                    <div ref={dropdownRef} className="blanc-mobile-sheet">
                        <div className="blanc-mobile-sheet-header">
                            <h3>Assign Owner</h3>
                            <button onClick={() => setOpen(false)} className="p-1 rounded-lg" style={{ color: 'var(--blanc-ink-3)' }}>
                                <X className="size-5" />
                            </button>
                        </div>
                        {listContent}
                    </div>
                </>
            )}
            {open && !isMobile && desktopPos && (
                <div
                    ref={dropdownRef}
                    className="fixed z-[101] rounded-xl shadow-lg py-1 min-w-[200px] max-h-[200px] overflow-y-auto"
                    style={{
                        background: 'var(--blanc-surface-strong)',
                        border: '1px solid var(--blanc-line)',
                        left: desktopPos.left,
                        top: desktopPos.top,
                    }}
                >
                    {listContent}
                </div>
            )}
        </div>
    );
}
