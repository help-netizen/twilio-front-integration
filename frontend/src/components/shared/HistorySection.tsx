/**
 * HistorySection — timeline of all entity events + notes merged.
 *
 * Notes display as yellow cards (same as NotesSection).
 * Events display as compact icon rows.
 */
import { useState, useEffect, useCallback } from 'react';
import {
    ArrowRightLeft, Plus, XCircle, ArrowUpRight, Ban,
    RotateCcw, UserPlus, UserMinus, Tag, RefreshCw,
    Pencil, Clock,
} from 'lucide-react';
import { NoteAttachmentDisplay } from './NoteAttachmentDisplay';
import { authedFetch } from '../../services/apiClient';

// ─── Types ───────────────────────────────────────────────────────────────────

interface HistoryItem {
    id: string;
    type: 'event' | 'note';
    event_type: string;
    description?: string;
    actor: string;
    created_at: string;
    data?: Record<string, unknown>;
    // Note-specific
    text?: string;
    author?: string;
    attachments?: Array<{
        id: number;
        fileName: string;
        contentType: string;
        fileSize: number;
    }>;
}

interface HistorySectionProps {
    entityType: 'job' | 'lead' | 'contact';
    entityId: string | number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOTE_BG = '#fef9e7';

function formatDate(iso: string): string {
    try {
        return new Intl.DateTimeFormat('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit',
        }).format(new Date(iso));
    } catch {
        return iso;
    }
}

function apiPath(entityType: string, entityId: string | number): string {
    switch (entityType) {
        case 'job': return `/api/jobs/${entityId}/history`;
        case 'lead': return `/api/leads/${entityId}/history`;
        case 'contact': return `/api/contacts/${entityId}/history`;
        default: return `/api/${entityType}s/${entityId}/history`;
    }
}

const EVENT_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
    status_changed: ArrowRightLeft,
    created: Plus,
    canceled: XCircle,
    converted: ArrowUpRight,
    marked_lost: Ban,
    reactivated: RotateCcw,
    team_assigned: UserPlus,
    team_unassigned: UserMinus,
    tags_changed: Tag,
    synced: RefreshCw,
    updated: Pencil,
};

// ─── Component ───────────────────────────────────────────────────────────────

export function HistorySection({ entityType, entityId }: HistorySectionProps) {
    const [items, setItems] = useState<HistoryItem[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchHistory = useCallback(async () => {
        try {
            const res = await authedFetch(apiPath(entityType, entityId));
            const data = await res.json();
            if (data.ok || data.data) setItems(data.data || []);
        } catch { /* silent */ }
        finally { setLoading(false); }
    }, [entityType, entityId]);

    useEffect(() => { fetchHistory(); }, [fetchHistory]);

    if (loading) {
        return <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>Loading history...</p>;
    }

    if (items.length === 0) {
        return <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>No history yet</p>;
    }

    return (
        <div className="space-y-2">
            {items.map(item => (
                item.type === 'note'
                    ? <NoteCard key={item.id} item={item} />
                    : <EventRow key={item.id} item={item} />
            ))}
        </div>
    );
}

// ─── Note Card (same style as NotesSection) ──────────────────────────────────

function NoteCard({ item }: { item: HistoryItem }) {
    return (
        <div className="p-3 rounded-xl space-y-2" style={{ background: NOTE_BG }}>
            {item.text && <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--blanc-ink-1)' }}>{item.text}</p>}
            {item.attachments && item.attachments.length > 0 && (
                <NoteAttachmentDisplay attachments={item.attachments} />
            )}
            <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                {item.actor && <span className="font-medium">{item.actor} · </span>}
                {formatDate(item.created_at)}
            </p>
        </div>
    );
}

// ─── Event Row (compact) ─────────────────────────────────────────────────────

function EventRow({ item }: { item: HistoryItem }) {
    const Icon = EVENT_ICONS[item.event_type] || Clock;

    return (
        <div className="flex items-start gap-2.5 py-1.5">
            <Icon className="size-3.5 shrink-0 mt-0.5" style={{ color: 'var(--blanc-ink-3)' }} />
            <div className="flex-1 min-w-0">
                <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>{item.description}</p>
                <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                    {item.actor && <span className="font-medium">{item.actor} · </span>}
                    {formatDate(item.created_at)}
                </p>
            </div>
        </div>
    );
}
