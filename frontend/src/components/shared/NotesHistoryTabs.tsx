/**
 * NotesHistoryTabs — NOTES / HISTORY tab switcher.
 *
 * Wraps NotesSection and HistorySection. Uses blanc-eyebrow style tabs.
 */
import { useState } from 'react';
import { NotesSection } from './NotesSection';
import { HistorySection } from './HistorySection';

interface NotesHistoryTabsProps {
    entityType: 'job' | 'lead' | 'contact';
    entityId: string | number;
    onNoteAdded?: () => void;
}

export function NotesHistoryTabs({ entityType, entityId, onNoteAdded }: NotesHistoryTabsProps) {
    const [tab, setTab] = useState<'notes' | 'history'>('notes');

    return (
        <div className="space-y-3">
            {/* Tab switcher */}
            <div className="flex gap-1">
                <button
                    onClick={() => setTab('notes')}
                    className="text-[11px] font-semibold uppercase tracking-widest transition-colors"
                    style={{
                        letterSpacing: '0.14em',
                        color: tab === 'notes' ? 'var(--blanc-ink-1)' : 'var(--blanc-ink-3)',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '2px 6px',
                        borderRadius: 6,
                    }}
                >
                    Notes
                </button>
                <span className="text-[11px] font-semibold" style={{ color: 'var(--blanc-ink-3)', lineHeight: '1.5' }}>/</span>
                <button
                    onClick={() => setTab('history')}
                    className="text-[11px] font-semibold uppercase tracking-widest transition-colors"
                    style={{
                        letterSpacing: '0.14em',
                        color: tab === 'history' ? 'var(--blanc-ink-1)' : 'var(--blanc-ink-3)',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '2px 6px',
                        borderRadius: 6,
                    }}
                >
                    History
                </button>
            </div>

            {/* Content */}
            {tab === 'notes' ? (
                <NotesSection entityType={entityType} entityId={entityId} onNoteAdded={onNoteAdded} />
            ) : (
                <HistorySection entityType={entityType} entityId={entityId} />
            )}
        </div>
    );
}
