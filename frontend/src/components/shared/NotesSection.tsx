/**
 * NotesSection — unified notes component for any entity (job, lead, contact).
 *
 * Self-contained: fetches and posts notes via API.
 * Usage: <NotesSection entityType="job" entityId={123} />
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../ui/button';
import { NoteAttachmentInput } from './NoteAttachmentInput';
import { NoteAttachmentDisplay } from './NoteAttachmentDisplay';
import { authedFetch } from '../../services/apiClient';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Note {
    text: string;
    created: string;
    author?: string;
    migrated?: boolean;
    attachments?: Array<{
        id: number;
        fileName: string;
        contentType: string;
        fileSize: number;
    }>;
}

interface NotesSectionProps {
    entityType: 'job' | 'lead' | 'contact';
    entityId: string | number;
    /** Optional callback after note is added (e.g. to refresh parent) */
    onNoteAdded?: () => void;
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
        case 'job': return `/api/jobs/${entityId}/notes`;
        case 'lead': return `/api/leads/${entityId}/notes`;
        case 'contact': return `/api/contacts/${entityId}/notes`;
        default: return `/api/${entityType}s/${entityId}/notes`;
    }
}

// ─── Component ───────────────────────────────────────────────────────────────

export function NotesSection({ entityType, entityId, onNoteAdded }: NotesSectionProps) {
    const [notes, setNotes] = useState<Note[]>([]);
    const [text, setText] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const [expanded, setExpanded] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const basePath = apiPath(entityType, entityId);

    const fetchNotes = useCallback(async () => {
        try {
            const res = await authedFetch(basePath);
            const data = await res.json();
            if (data.ok || data.data) setNotes(data.data || []);
        } catch { /* silent — notes are non-critical */ }
    }, [basePath]);

    useEffect(() => { fetchNotes(); }, [fetchNotes]);

    const handleSubmit = useCallback(async () => {
        if (!text.trim() && files.length === 0) return;
        setSubmitting(true);
        try {
            const formData = new FormData();
            formData.append('text', text.trim());
            files.forEach(f => formData.append('attachments', f));

            await authedFetch(basePath, { method: 'POST', body: formData });
            setText('');
            setFiles([]);
            setExpanded(false);
            fetchNotes();
            onNoteAdded?.();
        } catch (err) {
            console.error('[NotesSection] Failed to add note:', err);
        } finally {
            setSubmitting(false);
        }
    }, [text, files, basePath, fetchNotes, onNoteAdded]);

    const expand = () => {
        setExpanded(true);
        setTimeout(() => textareaRef.current?.focus(), 0);
    };

    // Click-outside to collapse
    const handleClickOutside = useCallback((e: MouseEvent) => {
        if (!containerRef.current?.contains(e.target as Node) && !text.trim() && files.length === 0) {
            setExpanded(false);
        }
    }, [text, files.length]);

    useEffect(() => {
        if (expanded) {
            document.addEventListener('mousedown', handleClickOutside);
            return () => document.removeEventListener('mousedown', handleClickOutside);
        }
    }, [expanded, handleClickOutside]);

    const canSubmit = (text.trim() || files.length > 0) && !submitting;

    // Newest first
    const sortedNotes = [...notes].reverse();

    return (
        <div ref={containerRef} className="space-y-3">
            {/* Add note input — always at top */}
            {expanded ? (
                <div className="space-y-2">
                    <textarea
                        ref={textareaRef}
                        className="w-full text-sm resize-none outline-none bg-transparent leading-5"
                        style={{
                            border: '1px solid var(--blanc-line)',
                            borderRadius: 10,
                            padding: '8px 12px',
                            minHeight: 72,
                            color: 'var(--blanc-ink-1)',
                        }}
                        placeholder="Write a note..."
                        value={text}
                        onChange={e => setText(e.target.value)}
                        onKeyDown={e => {
                            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSubmit) {
                                e.preventDefault();
                                handleSubmit();
                            }
                        }}
                        onInput={e => {
                            const t = e.target as HTMLTextAreaElement;
                            t.style.height = 'auto';
                            t.style.height = `${t.scrollHeight}px`;
                        }}
                        autoFocus
                    />
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <NoteAttachmentInput files={files} onChange={setFiles} compact />
                            <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>Cmd + Enter</p>
                        </div>
                        <Button size="sm" onMouseDown={e => e.preventDefault()} onClick={handleSubmit} disabled={!canSubmit}>
                            <Plus className="size-4 mr-1" /> Add Note
                        </Button>
                    </div>
                </div>
            ) : (
                <button
                    onClick={expand}
                    className="w-full flex items-center gap-2 transition-opacity hover:opacity-70"
                    style={{
                        height: 34,
                        borderRadius: 10,
                        border: '1px solid var(--blanc-line)',
                        background: 'transparent',
                        paddingLeft: 12,
                        paddingRight: 12,
                        cursor: 'text',
                        textAlign: 'left',
                    }}
                >
                    <Plus className="size-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                    <span className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>Add note…</span>
                </button>
            )}

            {/* Notes list — newest first */}
            {sortedNotes.map((note, i) => (
                <div key={i} className="p-3 rounded-xl space-y-2" style={{ background: NOTE_BG }}>
                    {note.text && <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--blanc-ink-1)' }}>{note.text}</p>}
                    {note.attachments && note.attachments.length > 0 && (
                        <NoteAttachmentDisplay attachments={note.attachments} />
                    )}
                    <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                        {note.author && <span className="font-medium">{note.author} · </span>}
                        {formatDate(note.created)}
                        {note.migrated && ' (migrated)'}
                    </p>
                </div>
            ))}
        </div>
    );
}
