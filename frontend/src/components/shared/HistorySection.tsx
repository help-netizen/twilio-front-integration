/**
 * HistorySection — the entity's activity chronology: audit-log actions + notes, merged.
 *
 * Notes render as yellow cards (same as NotesSection). Actions render as compact rows —
 * an action-specific icon, a human sentence (server-described), and "who · when", where
 * non-human actors (AI agent, Zenbooker sync, portal client) carry a small chip.
 * Feeds off GET /api/{jobs|leads|contacts}/:id/history (ACTIVITY-LOG-001).
 */
import { useState, useEffect, useCallback } from 'react';
import {
    ArrowRightLeft, Plus, XCircle, ArrowUpRight, Ban,
    RotateCcw, UserPlus, UserMinus, Tag, RefreshCw,
    Pencil, Clock, Trash2, Send, Check, CreditCard,
    Eye, Calendar, Star, MapPin, Link as LinkIcon,
    AlertCircle, Navigation, GitMerge,
} from 'lucide-react';
import { NoteAttachmentDisplay } from './NoteAttachmentDisplay';
import { authedFetch } from '../../services/apiClient';

// ─── Types ───────────────────────────────────────────────────────────────────

type ActorType = 'user' | 'ai' | 'integration' | 'system' | 'client';

interface HistoryItem {
    id: string;
    type: 'event' | 'note';
    event_type: string;
    action?: string;
    description?: string;
    actor: string;
    actor_type?: ActorType;
    actor_label?: string | null;
    actor_name?: string | null;
    target_type?: string;
    target_id?: string;
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

function formatDate(iso?: string | null): string {
    if (!iso) return 'Unknown date';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'Unknown date';
    try {
        return new Intl.DateTimeFormat('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit',
        }).format(d);
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

// Verb → icon. Works for both canonical `entity.action` keys (estimate.sent) and the
// legacy bare domain-event types (status_changed) surfaced before the cutover.
const VERB_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
    created: Plus,
    updated: Pencil,
    status_changed: ArrowRightLeft,
    sent: Send,
    approved: Check,
    accepted: Check,
    client_accepted: Check,
    declined: Ban,
    client_declined: Ban,
    voided: Ban,
    canceled: XCircle,
    lost: Ban,
    marked_lost: Ban,
    converted: ArrowUpRight,
    reactivated: RotateCcw,
    assigned: UserPlus,
    team_assigned: UserPlus,
    unassigned: UserMinus,
    team_unassigned: UserMinus,
    rescheduled: Calendar,
    eta_notified: Navigation,
    rating_link_sent: Star,
    recorded: CreditCard,
    payment_recorded: CreditCard,
    succeeded: CreditCard,
    payment_succeeded: CreditCard,
    session_started: CreditCard,
    card_session_started: CreditCard,
    session_canceled: XCircle,
    check_deposited: CreditCard,
    refunded: RotateCcw,
    failed: AlertCircle,
    payment_failed: AlertCircle,
    send_failed: AlertCircle,
    disputed: AlertCircle,
    merged: GitMerge,
    contact_merged: GitMerge,
    phone_moved: ArrowRightLeft,
    email_moved: ArrowRightLeft,
    address_set: MapPin,
    viewed: Eye,
    link_created: LinkIcon,
    link_sent: LinkIcon,
    receipt_sent: Send,
    portal_profile_updated: Pencil,
    portal_submitted: CreditCard,
    tags_changed: Tag,
    synced: RefreshCw,
    note_edited: Pencil,
    note_deleted: Trash2,
};

function iconForAction(action?: string, eventType?: string): React.ComponentType<{ className?: string }> {
    const key = action || eventType || '';
    const verb = key.includes('.') ? key.slice(key.indexOf('.') + 1) : key;
    return VERB_ICONS[verb] || VERB_ICONS[key] || Clock;
}

// Non-human actors get a small chip; humans show just their name.
const ACTOR_CHIP: Record<Exclude<ActorType, 'user'>, string> = {
    ai: 'AI',
    integration: 'Sync',
    system: 'System',
    client: 'Client',
};

function actorDisplay(item: HistoryItem): { name: string; chip: string | null; chipTone: 'accent' | 'muted' } {
    const type = item.actor_type;
    if (!type || type === 'user') {
        return { name: item.actor_name || item.actor || 'Someone', chip: null, chipTone: 'muted' };
    }
    const name = item.actor_label || item.actor || ACTOR_CHIP[type];
    return { name, chip: ACTOR_CHIP[type], chipTone: type === 'ai' ? 'accent' : 'muted' };
}

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
        <div className="space-y-1">
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
        <div className="p-3 rounded-xl space-y-2 my-1" style={{ background: NOTE_BG }}>
            {item.text && <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--blanc-ink-1)' }}>{item.text}</p>}
            {item.attachments && item.attachments.length > 0 && (
                <NoteAttachmentDisplay attachments={item.attachments} groupKey={`history-${item.id}`} />
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
    const Icon = iconForAction(item.action, item.event_type);
    const { name, chip, chipTone } = actorDisplay(item);

    return (
        <div className="flex items-start gap-2.5 py-1.5">
            <Icon className="size-3.5 shrink-0 mt-0.5 text-[var(--blanc-ink-3)]" />
            <div className="flex-1 min-w-0">
                <p className="text-sm" style={{ color: 'var(--blanc-ink-1)' }}>{item.description}</p>
                <p className="text-xs flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--blanc-ink-3)' }}>
                    <span className="font-medium">{name}</span>
                    {chip && (
                        <span
                            className="inline-block rounded-full px-1.5 text-[10px] font-bold uppercase tracking-wide"
                            style={chipTone === 'accent'
                                ? { background: 'var(--blanc-accent-soft)', color: 'var(--blanc-accent)' }
                                : { background: 'var(--blanc-surface-muted)', color: 'var(--blanc-ink-3)', border: '1px solid var(--blanc-line)' }}
                        >
                            {chip}
                        </span>
                    )}
                    <span>· {formatDate(item.created_at)}</span>
                </p>
            </div>
        </div>
    );
}
